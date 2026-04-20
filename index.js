import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "st-local-statusbar";
const extensionBaseUrl = new URL(".", import.meta.url);
const hostClass = "st-local-statusbar-host";
const frameClass = "st-local-statusbar-frame";
const hiddenSourceClass = "st-local-statusbar-hidden-source";
const enabledInputId = "st_local_statusbar_enabled";
const reloadButtonId = "st_local_statusbar_reload";
const autoExpandInputId = "st_local_statusbar_auto_expand";
const widthInputId = "st_local_statusbar_width";
const textScaleInputId = "st_local_statusbar_text_scale";
const textWeightInputId = "st_local_statusbar_text_weight";
const textAlignInputId = "st_local_statusbar_text_align";

const defaultSettings = {
    enabled: true,
    autoExpand: true,
    panelWidth: 100,
    textScale: 95,
    textWeight: 500,
    textAlign: "right",
};

const bridgeScript = `
<script>
window.__STLSB_BRIDGE__ = window.__STLSB_BRIDGE__ || { message: "__STLSB_INITIAL_MESSAGE__" };
window.eventSource = { on: () => {} };
window.getCurrentMessageId = () => 0;
window.getChatMessages = () => [{ message: window.__STLSB_BRIDGE__.message || "" }];
</script>`;

let fragmentCache = null;
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

function extractStatusBlock(rawMessage) {
    const match = String(rawMessage || "").match(/<[Ss]tatus(?:[Bb]lock)?>([\s\S]*?)<\/[Ss]tatus(?:[Bb]lock)?>/);
    return match ? stripHtmlToText(match[1]).trim() : "";
}

function escapeScriptString(value) {
    return String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/<\/script/gi, "<\\/script");
}

function buildSrcdoc(fragment, initialMessage = "") {
    const bridge = bridgeScript.replace("__STLSB_INITIAL_MESSAGE__", escapeScriptString(initialMessage));
    if (fragment.includes("<head>")) {
        return `<!doctype html><html lang="zh-CN">${fragment.replace("<head>", `<head>${bridge}`)}</html>`;
    }
    return `<!doctype html><html lang="zh-CN"><head>${bridge}</head>${fragment}</html>`;
}

async function loadFragment() {
    if (fragmentCache !== null) {
        return fragmentCache;
    }
    fragmentCache = await $.get(fileUrl("statusbar.fragment.html"));
    return fragmentCache;
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

function getTextNodesForMatch(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) {
                return NodeFilter.FILTER_REJECT;
            }
            if (parent.closest(`.${hostClass}, .${hiddenSourceClass}`)) {
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

function ensureHiddenStatusText(mesText, statusText) {
    const target = normalizeTextForMatch(statusText);
    if (!target) {
        return null;
    }

    const existingHiddenNodes = Array.from(mesText.querySelectorAll(`.${hiddenSourceClass}`));
    if (existingHiddenNodes.length) {
        const exactHidden = existingHiddenNodes.find((hidden) => normalizeTextForMatch(hidden.textContent) === target);
        existingHiddenNodes
            .filter((hidden) => hidden !== exactHidden)
            .forEach((hidden) => restoreHiddenSource(hidden));

        if (exactHidden) {
            return exactHidden;
        }
    }

    const textNodes = getTextNodesForMatch(mesText);
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
    hidden.className = hiddenSourceClass;
    hidden.hidden = true;
    hidden.appendChild(range.extractContents());
    range.insertNode(hidden);
    return hidden;
}

function getHostByMesId(mesId) {
    return document.querySelector(`.${hostClass}[data-mes-id="${CSS.escape(String(mesId))}"]`);
}

function getFrameByMesId(mesId) {
    return document.querySelector(`.${frameClass}[data-mes-id="${CSS.escape(String(mesId))}"]`);
}

function createHost(mesId) {
    const host = document.createElement("div");
    host.className = hostClass;
    host.dataset.mesId = String(mesId);
    host.setAttribute("data-name", "本地状态栏");
    host.innerHTML = `
        <div class="st-local-statusbar-shell">
            <iframe
                class="${frameClass}"
                title="本地状态栏"
                scrolling="no"
                loading="eager"
                referrerpolicy="no-referrer"
            ></iframe>
        </div>
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

        const panel = doc.querySelector(".status-panel");
        const panelRect = panel?.getBoundingClientRect();
        const panelHeight = panelRect ? Math.ceil(panelRect.height) : 0;
        const fallbackHeight = Math.ceil(Math.max(
            body?.firstElementChild?.getBoundingClientRect?.().height || 0,
            body?.scrollHeight || 0,
            root?.scrollHeight || 0,
        ));
        const height = Math.max(panelHeight || fallbackHeight, 24);
        frame.style.height = `${height}px`;
    } catch (error) {
        console.warn("[st-local-statusbar] Failed to resize iframe:", error);
    }
}

function syncFrameMessage(frame, rawMessage, force = false) {
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

function getAllFrames() {
    return Array.from(document.querySelectorAll(`.${frameClass}`));
}

function cleanupFrame(frame) {
    if (!frame) {
        return;
    }

    try {
        frame.__statusbarResizeObserver?.disconnect?.();
    } catch (error) {
        console.warn("[st-local-statusbar] Failed to disconnect ResizeObserver:", error);
    }
}

function destroyHost(host) {
    if (!host) {
        return;
    }

    const frame = host.querySelector(`.${frameClass}`);
    cleanupFrame(frame);
    host.remove();
}

function cleanupMessageState(messageElement) {
    if (!messageElement) {
        return;
    }

    const mesId = messageElement.getAttribute("mesid");
    if (mesId !== null && typeof mesId !== "undefined") {
        destroyHost(getHostByMesId(mesId));
    }

    const mesText = messageElement.querySelector(".mes_text");
    if (mesText) {
        Array.from(mesText.querySelectorAll(`.${hiddenSourceClass}`)).forEach((hidden) => restoreHiddenSource(hidden));
    }
}

function clearAllMountedStatusbars() {
    getCharacterMessageElements().forEach((mes) => cleanupMessageState(mes));
    Array.from(document.querySelectorAll(`.${hostClass}`)).forEach((host) => destroyHost(host));
}

function bindFrame(frame) {
    if (!frame || frame.dataset.bound === "1") {
        return;
    }

    frame.dataset.bound = "1";
    const scheduleResize = () => {
        window.requestAnimationFrame(() => updateFrameHeight(frame));
    };

    frame.addEventListener("load", () => {
        scheduleResize();
        syncFrameMessage(frame, frame.__stlsbRawMessage || "", true);
        applyStatusbarSettingsToFrame(frame);
        frame.classList.add("st-local-statusbar-frame-ready");

        try {
            frame.__statusbarResizeObserver?.disconnect?.();
            const observer = new ResizeObserver(() => scheduleResize());
            const doc = frame.contentDocument;
            if (doc?.documentElement) {
                observer.observe(doc.documentElement);
            }
            if (doc?.body) {
                observer.observe(doc.body);
            }
            frame.__statusbarResizeObserver = observer;
        } catch (error) {
            console.warn("[st-local-statusbar] ResizeObserver unavailable:", error);
        }
    });
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
    getAllFrames().forEach((frame) => applyStatusbarSettingsToFrame(frame));
}

async function ensureMounted() {
    const settings = ensureSettings();
    if (!settings.enabled) {
        clearAllMountedStatusbars();
        return;
    }

    const fragment = await loadFragment();
    const version = `${fragment.length}:${fragment.charCodeAt(0) || 0}`;
    const activeMesIds = new Set();

    for (const mes of getCharacterMessageElements()) {
        const mesId = mes.getAttribute("mesid");
        const mesText = mes.querySelector(".mes_text");

        if (!mesId || !mesText) {
            continue;
        }

        activeMesIds.add(String(mesId));
        const rawMessage = getRawMessageByDomMessage(mes);
        const statusText = getStatusTextForMessage(rawMessage, mesText);

        if (!statusText) {
            cleanupMessageState(mes);
            continue;
        }

        const hidden = ensureHiddenStatusText(mesText, statusText);
        if (!hidden) {
            cleanupMessageState(mes);
            continue;
        }

        let host = getHostByMesId(mesId);
        if (!host) {
            host = createHost(mesId);
        }

        if (host.parentElement !== mesText || host.nextSibling !== hidden) {
            hidden.before(host);
        }

        const frame = host.querySelector(`.${frameClass}`);
        if (!frame) {
            continue;
        }

        bindFrame(frame);
        frame.__stlsbRawMessage = rawMessage;

        if (frame.dataset.fragmentVersion !== version) {
            frame.dataset.fragmentVersion = version;
            delete frame.__stlsbLastMessage;
            frame.classList.remove("st-local-statusbar-frame-ready");
            frame.srcdoc = buildSrcdoc(fragment, rawMessage);
        } else {
            applyStatusbarSettingsToFrame(frame);
            syncFrameMessage(frame, rawMessage);
        }
    }

    Array.from(document.querySelectorAll(`.${hostClass}`)).forEach((host) => {
        const mesId = host.dataset.mesId || "";
        if (activeMesIds.has(mesId)) {
            return;
        }
        destroyHost(host);
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

    if (ensureSettings().enabled) {
        queueMount(0);
        return;
    }

    clearAllMountedStatusbars();
}

function onReloadClick() {
    fragmentCache = null;
    getAllFrames().forEach((frame) => {
        delete frame.dataset.fragmentVersion;
        delete frame.__stlsbLastMessage;
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
        if (el.closest?.(`.${hostClass}, .${hiddenSourceClass}`)) {
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
            if (target?.closest?.(`.${hostClass}, .${hiddenSourceClass}`)) {
                return true;
            }

            const added = Array.from(mutation.addedNodes || []);
            const removed = Array.from(mutation.removedNodes || []);
            return [...added, ...removed].every((node) => {
                const el = node instanceof Element ? node : node?.parentElement;
                return Boolean(el?.closest?.(`.${hostClass}, .${hiddenSourceClass}`));
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
    $(`#${autoExpandInputId}`).on("change", onStatusbarSettingInput);
    $(`#${widthInputId}, #${textScaleInputId}, #${textWeightInputId}`).on("input change", onStatusbarSettingInput);
    $(`#${textAlignInputId}`).on("change", onStatusbarSettingInput);
    $(`#${reloadButtonId}`).on("click", onReloadClick);
}

function syncSettingsUi() {
    const settings = ensureSettings();
    $(`#${enabledInputId}`).prop("checked", settings.enabled);
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
