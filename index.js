import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "st-local-statusbar";
const extensionBaseUrl = new URL(".", import.meta.url);
const statusHostClass = "st-local-statusbar-host";
const statusFrameClass = "st-local-statusbar-frame";
const statusHiddenSourceClass = "st-local-statusbar-hidden-source";
const cotHostClass = "st-local-cot-host";
const cotFrameClass = "st-local-cot-frame";
const cotHiddenSourceClass = "st-local-cot-hidden-source";
const enabledInputId = "st_local_statusbar_enabled";
const cotEnabledInputId = "st_local_cot_enabled";
const reloadButtonId = "st_local_statusbar_reload";
const autoExpandInputId = "st_local_statusbar_auto_expand";
const widthInputId = "st_local_statusbar_width";
const textScaleInputId = "st_local_statusbar_text_scale";
const textWeightInputId = "st_local_statusbar_text_weight";
const textAlignInputId = "st_local_statusbar_text_align";

const defaultSettings = {
    enabled: true,
    cotEnabled: true,
    autoExpand: true,
    panelWidth: 100,
    textScale: 95,
    textWeight: 500,
    textAlign: "right",
};

const statusBridgeScript = `
<script>
window.__STLSB_BRIDGE__ = window.__STLSB_BRIDGE__ || { message: "__STLSB_INITIAL_MESSAGE__" };
window.eventSource = { on: () => {} };
window.getCurrentMessageId = () => 0;
window.getChatMessages = () => [{ message: window.__STLSB_BRIDGE__.message || "" }];
</script>`;

let statusFragmentCache = null;
let cotFragmentCache = null;
let mountTimer = null;
let domObserver = null;
let lastCharacterMessageSignature = "";

function fileUrl(name) {
    return new URL(name, extensionBaseUrl).href;
}

function getSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    return extension_settings[extensionName];
}

function ensureSettings() {
    const settings = getSettings();
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (typeof settings[key] === "undefined") {
            settings[key] = value;
        }
    }
    return settings;
}

function getSettingsContainer() {
    return document.getElementById("extensions_settings")
        || document.getElementById("extensions_settings2");
}

function getContextSafe() {
    try {
        if (typeof getContext === "function") {
            return getContext();
        }
    } catch (error) {
        console.warn("[st-local-statusbar] getContext import failed:", error);
    }

    try {
        if (globalThis.SillyTavern?.getContext) {
            return globalThis.SillyTavern.getContext();
        }
    } catch (error) {
        console.warn("[st-local-statusbar] SillyTavern.getContext failed:", error);
    }

    return null;
}

function normalizeTextForMatch(text) {
    return String(text || "").replace(/\s+/g, "");
}

function stripHtmlToText(html) {
    const div = document.createElement("div");
    div.innerHTML = String(html || "").replace(/<\s*br\s*\/?>/gi, "\n");
    return div.textContent || div.innerText || "";
}

function stripMarkdownCodeFence(content) {
    return String(content || "")
        .replace(/^\s*```(?:html)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeScriptString(value) {
    return String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/<\/script/gi, "<\\/script");
}

function extractStatusBlock(rawMessage) {
    const match = String(rawMessage || "").match(/<[Ss]tatus(?:[Bb]lock)?>([\s\S]*?)<\/[Ss]tatus(?:[Bb]lock)?>/);
    return match ? stripHtmlToText(match[1]).trim() : "";
}

function extractCotBlock(rawMessage) {
    const source = String(rawMessage || "");
    const regex = /([\s\S]*)(<\/think>|<\/thinking>)/gi;
    let match = null;
    let lastContent = "";

    while ((match = regex.exec(source)) !== null) {
        lastContent = match[1] || "";
    }

    if (!lastContent) {
        return "";
    }

    return stripHtmlToText(lastContent).trim();
}

function buildStatusSrcdoc(fragment, initialMessage = "") {
    const bridge = statusBridgeScript.replace("__STLSB_INITIAL_MESSAGE__", escapeScriptString(initialMessage));
    if (fragment.includes("<head>")) {
        return `<!doctype html><html lang="zh-CN">${fragment.replace("<head>", `<head>${bridge}`)}</html>`;
    }
    return `<!doctype html><html lang="zh-CN"><head>${bridge}</head>${fragment}</html>`;
}

function buildCotSrcdoc(fragment, content = "") {
    return String(fragment || "").replace(/\$1/g, escapeHtml(content));
}

async function loadStatusFragment() {
    if (statusFragmentCache !== null) {
        return statusFragmentCache;
    }
    statusFragmentCache = stripMarkdownCodeFence(await $.get(fileUrl("statusbar.fragment.html")));
    return statusFragmentCache;
}

async function loadCotFragment() {
    if (cotFragmentCache !== null) {
        return cotFragmentCache;
    }
    cotFragmentCache = stripMarkdownCodeFence(await $.get(fileUrl("cot.html")));
    return cotFragmentCache;
}

function getCharacterMessageElements() {
    return Array.from(document.querySelectorAll('#chat .mes[is_user="false"]')).reverse();
}

function getRawMessageByDomMessage(domMessage) {
    const mesId = domMessage?.getAttribute("mesid");
    const swipeId = Number(domMessage?.getAttribute("swipeid") || "0");
    const context = getContextSafe();
    const chat = Array.isArray(context?.chat) ? context.chat : null;

    if (chat && mesId !== null && typeof mesId !== "undefined") {
        const item = chat[Number(mesId)];
        const swipeText = Array.isArray(item?.swipes) ? item.swipes[Number.isFinite(swipeId) ? swipeId : 0] : "";
        const raw = swipeText || item?.mes || item?.message || item?.text || "";
        if (typeof raw === "string") {
            return raw;
        }
    }

    return "";
}

function getCharacterMessageSignature() {
    return getCharacterMessageElements().map((mes) => {
        const mesId = mes.getAttribute("mesid") || "";
        const text = mes.querySelector(".mes_text")?.textContent || "";
        return `${mesId}::${text.trim()}`;
    }).join("||");
}

function getStatusTextForMessage(rawMessage, mesText) {
    const extracted = extractStatusBlock(rawMessage);
    if (extracted) {
        return extracted;
    }

    if (!rawMessage) {
        const text = mesText?.innerText || mesText?.textContent || "";
        const contentText = mesText?.querySelector("content")?.textContent || "";
        if (contentText && text.includes(contentText)) {
            const idx = text.indexOf(contentText);
            const rest = text.slice(idx + contentText.length).trim();
            if (rest) {
                return rest;
            }
        }
    }

    return "";
}

function getCotTextForMessage(rawMessage) {
    return extractCotBlock(rawMessage);
}

function getCotAnchorText(mesText) {
    const text = mesText?.textContent || "";
    const match = text.match(/<\/thinking>|<\/think>/i);
    return match ? match[0] : "";
}

function getTextNodesForMatch(container, ignoredClasses = []) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) {
                return NodeFilter.FILTER_REJECT;
            }
            if (ignoredClasses.some((className) => parent.closest(`.${className}`))) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const nodes = [];
    let node = walker.nextNode();
    while (node) {
        nodes.push(node);
        node = walker.nextNode();
    }
    return nodes;
}

function restoreHiddenSource(hidden) {
    if (!(hidden instanceof Element)) {
        return;
    }

    const fragment = document.createDocumentFragment();
    while (hidden.firstChild) {
        fragment.appendChild(hidden.firstChild);
    }
    hidden.replaceWith(fragment);
}

function trimBreakAfterHidden(hidden) {
    if (!(hidden instanceof Element)) {
        return;
    }

    let nextNode = hidden.nextSibling;
    while (nextNode && nextNode.nodeType === Node.TEXT_NODE && !String(nextNode.nodeValue || "").trim()) {
        nextNode = nextNode.nextSibling;
    }

    if (nextNode instanceof HTMLBRElement) {
        nextNode.remove();
    }
}

function unwrapElementPreservingChildren(element) {
    if (!(element instanceof Element)) {
        return;
    }

    const fragment = document.createDocumentFragment();
    while (element.firstChild) {
        fragment.appendChild(element.firstChild);
    }
    element.replaceWith(fragment);
}

function normalizeCotFollowingList(hidden) {
    if (!(hidden instanceof Element)) {
        return;
    }

    let nextNode = hidden.nextSibling;
    while (nextNode && nextNode.nodeType === Node.TEXT_NODE && !String(nextNode.nodeValue || "").trim()) {
        const emptyNode = nextNode;
        nextNode = nextNode.nextSibling;
        emptyNode.remove();
    }

    if (nextNode instanceof HTMLBRElement) {
        const br = nextNode;
        nextNode = nextNode.nextSibling;
        br.remove();
    }

    while (nextNode && nextNode.nodeType === Node.TEXT_NODE && !String(nextNode.nodeValue || "").trim()) {
        const emptyNode = nextNode;
        nextNode = nextNode.nextSibling;
        emptyNode.remove();
    }

    if (!(nextNode instanceof HTMLUListElement || nextNode instanceof HTMLOListElement)) {
        return;
    }

    const list = nextNode;
    const items = Array.from(list.children).filter((child) => child instanceof HTMLLIElement);
    if (!items.length) {
        return;
    }

    for (const item of items) {
        unwrapElementPreservingChildren(item);
    }
    unwrapElementPreservingChildren(list);
}

function ensureHiddenCotBlock(mesText, hiddenClass, ignoredClasses) {
    const existingHiddenNodes = Array.from(mesText.querySelectorAll(`.${hiddenClass}`));
    if (existingHiddenNodes.length) {
        return existingHiddenNodes[0];
    }

    const textNodes = getTextNodesForMatch(mesText, ignoredClasses);
    const chars = [];
    for (const node of textNodes) {
        const value = node.nodeValue || "";
        for (let offset = 0; offset < value.length; offset += 1) {
            chars.push({ char: value[offset], node, offset });
        }
    }

    const rawText = chars.map((item) => item.char).join("");
    const markerMatch = rawText.match(/<\/thinking>|<\/think>/i);
    if (!markerMatch) {
        return null;
    }

    const markerIndex = markerMatch.index ?? -1;
    if (markerIndex < 0) {
        return null;
    }

    const endIndex = markerIndex + markerMatch[0].length - 1;
    const endPos = chars[endIndex];
    if (!endPos) {
        return null;
    }

    const range = document.createRange();
    range.setStart(mesText, 0);
    range.setEnd(endPos.node, endPos.offset + 1);

    const hidden = document.createElement("span");
    hidden.className = hiddenClass;
    hidden.hidden = true;
    hidden.appendChild(range.extractContents());
    range.insertNode(hidden);
    return hidden;
}

function ensureHiddenMatchedText(mesText, sourceText, hiddenClass, ignoredClasses) {
    const target = normalizeTextForMatch(sourceText);
    if (!target) {
        return null;
    }

    const existingHiddenNodes = Array.from(mesText.querySelectorAll(`.${hiddenClass}`));
    if (existingHiddenNodes.length) {
        const exactHidden = existingHiddenNodes.find((hidden) => normalizeTextForMatch(hidden.textContent) === target);
        existingHiddenNodes
            .filter((hidden) => hidden !== exactHidden)
            .forEach((hidden) => restoreHiddenSource(hidden));

        if (exactHidden) {
            return exactHidden;
        }
    }

    const textNodes = getTextNodesForMatch(mesText, ignoredClasses);
    const chars = [];
    for (const node of textNodes) {
        const value = node.nodeValue || "";
        for (let offset = 0; offset < value.length; offset += 1) {
            const char = value[offset];
            if (/\s/.test(char)) {
                continue;
            }
            chars.push({ char, node, offset });
        }
    }

    const haystack = chars.map((item) => item.char).join("");
    const start = haystack.indexOf(target);
    if (start < 0) {
        return null;
    }

    const end = start + target.length - 1;
    const startPos = chars[start];
    const endPos = chars[end];
    if (!startPos || !endPos) {
        return null;
    }

    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset + 1);

    const hidden = document.createElement("span");
    hidden.className = hiddenClass;
    hidden.hidden = true;
    hidden.appendChild(range.extractContents());
    range.insertNode(hidden);
    return hidden;
}

function getStatusHostByMesId(mesId) {
    return document.querySelector(`.${statusHostClass}[data-mes-id="${CSS.escape(String(mesId))}"]`);
}

function getCotHostByMesId(mesId) {
    return document.querySelector(`.${cotHostClass}[data-mes-id="${CSS.escape(String(mesId))}"]`);
}

function createStatusHost(mesId) {
    const host = document.createElement("span");
    host.className = statusHostClass;
    host.dataset.mesId = String(mesId);
    host.setAttribute("data-name", "本地状态栏");
    host.innerHTML = `
        <iframe
            class="${statusFrameClass}"
            title="本地状态栏"
            scrolling="no"
            loading="eager"
            referrerpolicy="no-referrer"
        ></iframe>
    `;

    const frame = host.querySelector("iframe");
    if (frame) {
        frame.dataset.mesId = String(mesId);
    }
    return host;
}

function createCotHost(mesId) {
    const host = document.createElement("span");
    host.className = cotHostClass;
    host.dataset.mesId = String(mesId);
    host.setAttribute("data-name", "Cot美化");
    host.innerHTML = `
        <iframe
            class="${cotFrameClass}"
            title="Cot美化"
            scrolling="no"
            loading="eager"
            referrerpolicy="no-referrer"
        ></iframe>
    `;

    const frame = host.querySelector("iframe");
    if (frame) {
        frame.dataset.mesId = String(mesId);
    }
    return host;
}

function updateFrameHeight(frame) {
    if (!frame) {
        return;
    }

    try {
        const doc = frame.contentDocument;
        if (!doc) {
            return;
        }

        const root = doc.documentElement;
        const body = doc.body;
        if (root) {
            root.style.margin = "0";
            root.style.padding = "0";
            root.style.overflow = "hidden";
        }
        if (body) {
            body.style.margin = "0";
            body.style.padding = "0";
            body.style.overflow = "hidden";
        }

        const primary = doc.querySelector(".status-panel, .aether-collapsible");
        const primaryRect = primary?.getBoundingClientRect();
        const primaryHeight = primaryRect ? Math.ceil(primaryRect.height) : 0;
        const fallbackHeight = Math.ceil(Math.max(
            body?.firstElementChild?.getBoundingClientRect?.().height || 0,
            body?.scrollHeight || 0,
            root?.scrollHeight || 0,
        ));
        const height = Math.max(primaryHeight || fallbackHeight, 24);
        frame.style.height = `${height}px`;
    } catch (error) {
        console.warn("[st-local-statusbar] Failed to resize iframe:", error);
    }
}

function cleanupFrame(frame) {
    if (!frame) {
        return;
    }

    try {
        frame.__resizeObserver?.disconnect?.();
    } catch (error) {
        console.warn("[st-local-statusbar] Failed to disconnect ResizeObserver:", error);
    }
}

function destroyHost(host) {
    if (!host) {
        return;
    }

    const frame = host.querySelector("iframe");
    cleanupFrame(frame);
    host.remove();
}

function bindFrame(frame, onLoad) {
    if (!frame || frame.dataset.bound === "1") {
        return;
    }

    frame.dataset.bound = "1";
    const scheduleResize = () => {
        window.requestAnimationFrame(() => updateFrameHeight(frame));
    };

    frame.addEventListener("load", () => {
        onLoad?.(frame);
        scheduleResize();

        try {
            frame.__resizeObserver?.disconnect?.();
            const observer = new ResizeObserver(() => scheduleResize());
            const doc = frame.contentDocument;
            if (doc?.documentElement) {
                observer.observe(doc.documentElement);
            }
            if (doc?.body) {
                observer.observe(doc.body);
            }
            frame.__resizeObserver = observer;
        } catch (error) {
            console.warn("[st-local-statusbar] ResizeObserver unavailable:", error);
        }
    });
}

function syncStatusFrameMessage(frame, rawMessage, force = false) {
    if (!frame || !ensureSettings().enabled || !rawMessage) {
        return;
    }

    if (!force && frame.__stlsbLastMessage === rawMessage) {
        return;
    }

    try {
        const win = frame.contentWindow;
        if (!win?.__STLSB_BRIDGE__) {
            return;
        }

        win.__STLSB_BRIDGE__.message = rawMessage;
        frame.__stlsbLastMessage = rawMessage;

        if (typeof win.execParseStatusBlock === "function") {
            win.execParseStatusBlock();
        }
        updateFrameHeight(frame);
    } catch (error) {
        console.warn("[st-local-statusbar] Failed to sync raw message into iframe:", error);
    }
}

function getAllStatusFrames() {
    return Array.from(document.querySelectorAll(`.${statusFrameClass}`));
}

function getAllCotFrames() {
    return Array.from(document.querySelectorAll(`.${cotFrameClass}`));
}

function clearHiddenNodes(mesText, selector) {
    Array.from(mesText.querySelectorAll(selector)).forEach((hidden) => restoreHiddenSource(hidden));
}

function cleanupMessageState(messageElement) {
    if (!messageElement) {
        return;
    }

    const mesId = messageElement.getAttribute("mesid");
    if (mesId !== null && typeof mesId !== "undefined") {
        destroyHost(getStatusHostByMesId(mesId));
        destroyHost(getCotHostByMesId(mesId));
    }

    const mesText = messageElement.querySelector(".mes_text");
    if (mesText) {
        clearHiddenNodes(mesText, `.${statusHiddenSourceClass}`);
        clearHiddenNodes(mesText, `.${cotHiddenSourceClass}`);
    }
}

function clearAllMountedDecorations() {
    getCharacterMessageElements().forEach((mes) => cleanupMessageState(mes));
    Array.from(document.querySelectorAll(`.${statusHostClass}, .${cotHostClass}`)).forEach((host) => destroyHost(host));
}

function applyStatusbarSettingsToFrame(frame) {
    const win = frame?.contentWindow;
    if (!win) {
        return;
    }

    const settings = ensureSettings();
    try {
        win.localStorage.setItem("statusPanelAutoExpand", String(Boolean(settings.autoExpand)));
        win.localStorage.setItem("statusPanelMaxWidthPct", String(settings.panelWidth));
        win.localStorage.setItem("statusPanelTextScalePct", String(settings.textScale));
        win.localStorage.setItem("statusPanelTextWeight", String(settings.textWeight));
        win.localStorage.setItem("statusPanelTextAlign", settings.textAlign);

        if (typeof win.applyPanelWidth === "function") win.applyPanelWidth();
        if (typeof win.applyTextScale === "function") win.applyTextScale();
        if (typeof win.applyTextWeight === "function") win.applyTextWeight();
        if (typeof win.applyTextAlign === "function") win.applyTextAlign();
        if (typeof win.applyStartupCollapseState === "function") win.applyStartupCollapseState();

        updateFrameHeight(frame);
        window.requestAnimationFrame(() => updateFrameHeight(frame));
    } catch (error) {
        console.warn("[st-local-statusbar] Failed to apply statusbar settings:", error);
    }
}

function applyStatusbarSettingsToAllFrames() {
    getAllStatusFrames().forEach((frame) => applyStatusbarSettingsToFrame(frame));
}

async function mountStatusbarForMessage(mes, statusFragment) {
    const settings = ensureSettings();
    const mesId = mes.getAttribute("mesid");
    const mesText = mes.querySelector(".mes_text");
    if (!mesId || !mesText) {
        return;
    }

    if (!settings.enabled) {
        destroyHost(getStatusHostByMesId(mesId));
        clearHiddenNodes(mesText, `.${statusHiddenSourceClass}`);
        return;
    }

    const rawMessage = getRawMessageByDomMessage(mes);
    const statusText = getStatusTextForMessage(rawMessage, mesText);
    if (!statusText) {
        destroyHost(getStatusHostByMesId(mesId));
        clearHiddenNodes(mesText, `.${statusHiddenSourceClass}`);
        return;
    }

    const hidden = ensureHiddenMatchedText(
        mesText,
        statusText,
        statusHiddenSourceClass,
        [statusHostClass, statusHiddenSourceClass, cotHostClass, cotHiddenSourceClass],
    );
    if (!hidden) {
        destroyHost(getStatusHostByMesId(mesId));
        clearHiddenNodes(mesText, `.${statusHiddenSourceClass}`);
        return;
    }

    let host = getStatusHostByMesId(mesId);
    if (!host) {
        host = createStatusHost(mesId);
    }

    if (host.parentElement !== mesText || host.nextSibling !== hidden) {
        hidden.before(host);
    }

    const frame = host.querySelector(`.${statusFrameClass}`);
    if (!frame) {
        return;
    }

    bindFrame(frame, (currentFrame) => {
        syncStatusFrameMessage(currentFrame, currentFrame.__stlsbRawMessage || "", true);
        applyStatusbarSettingsToFrame(currentFrame);
        currentFrame.classList.add("st-local-statusbar-frame-ready");
    });
    frame.__stlsbRawMessage = rawMessage;

    const version = `${statusFragment.length}:${statusFragment.charCodeAt(0) || 0}`;
    if (frame.dataset.fragmentVersion !== version) {
        frame.dataset.fragmentVersion = version;
        delete frame.__stlsbLastMessage;
        frame.classList.remove("st-local-statusbar-frame-ready");
        frame.srcdoc = buildStatusSrcdoc(statusFragment, rawMessage);
    } else {
        applyStatusbarSettingsToFrame(frame);
        syncStatusFrameMessage(frame, rawMessage);
    }
}

async function mountCotForMessage(mes, cotFragment) {
    const settings = ensureSettings();
    const mesId = mes.getAttribute("mesid");
    const mesText = mes.querySelector(".mes_text");
    if (!mesId || !mesText) {
        return;
    }

    if (!settings.cotEnabled) {
        destroyHost(getCotHostByMesId(mesId));
        clearHiddenNodes(mesText, `.${cotHiddenSourceClass}`);
        return;
    }

    const rawMessage = getRawMessageByDomMessage(mes);
    const cotText = getCotTextForMessage(rawMessage);
    if (!cotText) {
        destroyHost(getCotHostByMesId(mesId));
        clearHiddenNodes(mesText, `.${cotHiddenSourceClass}`);
        return;
    }

    if (!getCotAnchorText(mesText)) {
        destroyHost(getCotHostByMesId(mesId));
        clearHiddenNodes(mesText, `.${cotHiddenSourceClass}`);
        return;
    }

    const hidden = ensureHiddenCotBlock(
        mesText,
        cotHiddenSourceClass,
        [statusHostClass, statusHiddenSourceClass, cotHostClass, cotHiddenSourceClass],
    );
    if (!hidden) {
        destroyHost(getCotHostByMesId(mesId));
        clearHiddenNodes(mesText, `.${cotHiddenSourceClass}`);
        return;
    }
    trimBreakAfterHidden(hidden);
    normalizeCotFollowingList(hidden);

    let host = getCotHostByMesId(mesId);
    if (!host) {
        host = createCotHost(mesId);
    }

    if (host.parentElement !== mesText || host.nextSibling !== hidden) {
        hidden.before(host);
    }

    const frame = host.querySelector(`.${cotFrameClass}`);
    if (!frame) {
        return;
    }

    bindFrame(frame, (currentFrame) => {
        currentFrame.classList.add("st-local-cot-frame-ready");
        updateFrameHeight(currentFrame);
    });

    const version = `${cotFragment.length}:${cotFragment.charCodeAt(0) || 0}:${cotText.length}`;
    if (frame.dataset.fragmentVersion !== version || frame.__stlCotText !== cotText) {
        frame.dataset.fragmentVersion = version;
        frame.__stlCotText = cotText;
        frame.classList.remove("st-local-cot-frame-ready");
        frame.srcdoc = buildCotSrcdoc(cotFragment, cotText);
    } else {
        updateFrameHeight(frame);
    }
}

async function ensureMounted() {
    const statusFragment = await loadStatusFragment();
    const cotFragment = await loadCotFragment();
    const activeMesIds = new Set();

    for (const mes of getCharacterMessageElements()) {
        const mesId = mes.getAttribute("mesid");
        const mesText = mes.querySelector(".mes_text");
        if (!mesId || !mesText) {
            continue;
        }

        activeMesIds.add(String(mesId));
        await mountStatusbarForMessage(mes, statusFragment);
        await mountCotForMessage(mes, cotFragment);
    }

    Array.from(document.querySelectorAll(`.${statusHostClass}, .${cotHostClass}`)).forEach((host) => {
        const mesId = host.dataset.mesId || "";
        if (!activeMesIds.has(mesId)) {
            destroyHost(host);
        }
    });
}

function queueMount(delay = 80) {
    if (mountTimer) {
        clearTimeout(mountTimer);
    }

    mountTimer = window.setTimeout(() => {
        ensureMounted().catch((error) => {
            console.error("[st-local-statusbar] Failed to mount:", error);
        });
    }, delay);
}

function onEnabledInput(event) {
    ensureSettings().enabled = Boolean($(event.target).prop("checked"));
    saveSettingsDebounced();
    queueMount(0);
}

function onCotEnabledInput(event) {
    ensureSettings().cotEnabled = Boolean($(event.target).prop("checked"));
    saveSettingsDebounced();
    queueMount(0);
}

function onReloadClick() {
    statusFragmentCache = null;
    cotFragmentCache = null;
    getAllStatusFrames().forEach((frame) => {
        delete frame.dataset.fragmentVersion;
        delete frame.__stlsbLastMessage;
    });
    getAllCotFrames().forEach((frame) => {
        delete frame.dataset.fragmentVersion;
        delete frame.__stlCotText;
    });
    queueMount(0);

    if (typeof toastr !== "undefined") {
        toastr.success("已重新载入本地状态栏", "本地状态栏");
    }
}

function onStatusbarSettingInput() {
    const settings = ensureSettings();
    settings.autoExpand = Boolean($(`#${autoExpandInputId}`).prop("checked"));
    settings.panelWidth = Number($(`#${widthInputId}`).val() || defaultSettings.panelWidth);
    settings.textScale = Number($(`#${textScaleInputId}`).val() || defaultSettings.textScale);
    settings.textWeight = Number($(`#${textWeightInputId}`).val() || defaultSettings.textWeight);
    settings.textAlign = String($(`#${textAlignInputId}`).val() || defaultSettings.textAlign);
    saveSettingsDebounced();
    applyStatusbarSettingsToAllFrames();
}

function installDomObserver() {
    if (domObserver) {
        return;
    }

    const isRelevantNode = (node) => {
        const el = node instanceof Element ? node : node?.parentElement;
        if (!el) {
            return false;
        }
        if (el.closest?.(`.${statusHostClass}, .${statusHiddenSourceClass}, .${cotHostClass}, .${cotHiddenSourceClass}`)) {
            return false;
        }
        return Boolean(
            el.matches?.('#chat .mes[is_user="false"] .mes_text, #chat .mes[is_user="false"] .mes_text *')
            || el.closest?.('#chat .mes[is_user="false"] .mes_text')
        );
    };

    domObserver = new MutationObserver((mutations) => {
        const hasRelevantChange = mutations.some((mutation) => {
            if (isRelevantNode(mutation.target)) {
                return true;
            }
            const added = Array.from(mutation.addedNodes || []);
            const removed = Array.from(mutation.removedNodes || []);
            return [...added, ...removed].some((node) => isRelevantNode(node));
        });

        if (!hasRelevantChange) {
            return;
        }

        const onlyOwnChanges = mutations.every((mutation) => {
            const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
            if (target?.closest?.(`.${statusHostClass}, .${statusHiddenSourceClass}, .${cotHostClass}, .${cotHiddenSourceClass}`)) {
                return true;
            }

            const added = Array.from(mutation.addedNodes || []);
            const removed = Array.from(mutation.removedNodes || []);
            return [...added, ...removed].every((node) => {
                const el = node instanceof Element ? node : node?.parentElement;
                return Boolean(el?.closest?.(`.${statusHostClass}, .${statusHiddenSourceClass}, .${cotHostClass}, .${cotHiddenSourceClass}`));
            });
        });

        if (onlyOwnChanges) {
            return;
        }

        const nextSignature = getCharacterMessageSignature();
        if (nextSignature === lastCharacterMessageSignature) {
            return;
        }

        lastCharacterMessageSignature = nextSignature;
        queueMount(80);
    });

    const chatRoot = document.getElementById("chat");
    if (!chatRoot) {
        return;
    }

    domObserver.observe(chatRoot, {
        childList: true,
        subtree: true,
        characterData: true,
    });
}

async function initSettingsUi() {
    if (document.getElementById(enabledInputId)) {
        return;
    }

    const settingsHtml = await $.get(fileUrl("settings.html"));
    const container = getSettingsContainer();
    if (!container) {
        throw new Error("Settings container not found");
    }

    $(container).append(settingsHtml);
    $(`#${enabledInputId}`).on("change", onEnabledInput);
    $(`#${cotEnabledInputId}`).on("change", onCotEnabledInput);
    $(`#${autoExpandInputId}`).on("change", onStatusbarSettingInput);
    $(`#${widthInputId}, #${textScaleInputId}, #${textWeightInputId}`).on("input change", onStatusbarSettingInput);
    $(`#${textAlignInputId}`).on("change", onStatusbarSettingInput);
    $(`#${reloadButtonId}`).on("click", onReloadClick);
}

function syncSettingsUi() {
    const settings = ensureSettings();
    $(`#${enabledInputId}`).prop("checked", settings.enabled);
    $(`#${cotEnabledInputId}`).prop("checked", settings.cotEnabled);
    $(`#${autoExpandInputId}`).prop("checked", Boolean(settings.autoExpand));
    $(`#${widthInputId}`).val(settings.panelWidth);
    $(`#${textScaleInputId}`).val(settings.textScale);
    $(`#${textWeightInputId}`).val(settings.textWeight);
    $(`#${textAlignInputId}`).val(settings.textAlign);
}

jQuery(async () => {
    ensureSettings();
    await initSettingsUi();
    syncSettingsUi();
    lastCharacterMessageSignature = getCharacterMessageSignature();
    installDomObserver();
    queueMount(0);
});
