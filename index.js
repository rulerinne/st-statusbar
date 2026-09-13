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
let remountTimer = null;
let domObserver = null;
let domObserverRoot = null;
let initialRetryTimers = [];
let eventHooksInstalled = false;
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

function stripMarkdownEmphasis(text) {
    return String(text || "")
        .replace(/(^|[\s(（\[【{])([*_]{1,3})(?=\S)([\s\S]*?\S)\2(?=$|[\s),，.。!?！？;；:：\]】}）])/g, "$1$3");
}

function getNormalizedMatchCandidates(text) {
    const candidates = [
        normalizeTextForMatch(text),
        normalizeTextForMatch(stripMarkdownEmphasis(text)),
        normalizeTextForMatch(stripDanglingMarkdownEdgeSymbols(text)),
        normalizeTextForMatch(stripMarkdownEmphasis(stripDanglingMarkdownEdgeSymbols(text))),
    ].filter(Boolean);
    return Array.from(new Set(candidates));
}

function stripDanglingMarkdownEdgeSymbols(text) {
    return String(text || "")
        .replace(/^[\s*_~`]+/, "")
        .replace(/[\s*_~`]+$/, "")
        .trim();
}

function stripHtmlToText(html) {
    const div = document.createElement("div");
    div.innerHTML = String(html || "").replace(/<\s*br\s*\/?>/gi, "\n");
    return div.textContent || div.innerText || "";
}

function normalizeExtractedStatusContent(content) {
    return stripDanglingMarkdownEdgeSymbols(stripHtmlToText(content)).trim();
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
    const match = String(rawMessage || "").match(/<(Status|StatusBlock|Status_block)>\s*([\s\S]*?)\s*<\/\1>/i);
    return match ? normalizeExtractedStatusContent(match[2]) : "";
}

// Scan tag boundaries once; never include prose preceding a complete block.
// Older replies may omit the opening tag, so keep that leading-block format.
function findCotBlocks(source) {
    const blocks = [];
    const tags = /<\/?(think|thinking)\s*>/gi;
    let opening = null;
    let sawOpening = false;
    for (const tag of String(source || "").matchAll(tags)) {
        if (tag[0][1] !== "/") {
            opening = { start: tag.index, contentStart: tag.index + tag[0].length, name: tag[1].toLowerCase() };
            sawOpening = true;
        } else if (opening && opening.name === tag[1].toLowerCase()) {
            blocks.push({ start: opening.start, end: tag.index + tag[0].length, contentStart: opening.contentStart, contentEnd: tag.index });
            opening = null;
        } else if (!sawOpening && blocks.length === 0) {
            blocks.push({ start: 0, end: tag.index + tag[0].length, contentStart: 0, contentEnd: tag.index, legacy: true });
        }
    }
    return blocks;
}

function extractCotBlock(rawMessage) {
    const source = String(rawMessage || "");
    return findCotBlocks(source)
        .map((block) => cotSourceToText(source.slice(block.contentStart, block.contentEnd)))
        .filter(Boolean).join("\n\n");
}

function cotSourceToText(source) {
    // Preserve literal tag references such as <info> inside reasoning text.
    const div = document.createElement("div");
    div.innerHTML = String(source || "")
        .replace(/<\s*br\s*\/?>/gi, "\n")
        .replace(/<\/?(?:b|strong|em|i|u|s|del|span|p|div)\b[^>]*>/gi, "")
        .replace(/</g, "&lt;");
    return (div.textContent || "").trim();
}

function buildStatusSrcdoc(fragment, initialMessage = "") {
    const bridge = statusBridgeScript.replace("__STLSB_INITIAL_MESSAGE__", escapeScriptString(initialMessage));
    if (fragment.includes("<head>")) {
        return `<!doctype html><html lang="zh-CN">${fragment.replace("<head>", `<head>${bridge}`)}</html>`;
    }
    return `<!doctype html><html lang="zh-CN"><head>${bridge}</head>${fragment}</html>`;
}

function buildCotSrcdoc(fragment, content = "") {
    return String(fragment || "").replace(/\$1/g, () => escapeHtml(content));
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

function getChatRoot() {
    return document.getElementById("chat");
}

function getRawMessageByDomMessage(domMessage) {
    const mesId = domMessage?.getAttribute("mesid");
    const context = getContextSafe();
    const chat = Array.isArray(context?.chat) ? context.chat : null;

    if (chat && mesId !== null && typeof mesId !== "undefined") {
        const item = chat[Number(mesId)];
        const swipeId = Number(domMessage?.getAttribute("swipeid") ?? item?.swipe_id ?? 0);
        const swipeText = Array.isArray(item?.swipes) ? item.swipes[Number.isFinite(swipeId) ? swipeId : 0] : "";
        const raw = item?.mes ?? item?.message ?? item?.text ?? swipeText ?? "";
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

const cotTextCache = new WeakMap();
function getCotTextForMessage(rawMessage, mesText = null) {
    if (rawMessage) {
        const cached = mesText && cotTextCache.get(mesText);
        if (cached?.raw === rawMessage) return cached.text;
        const text = extractCotBlock(rawMessage);
        if (mesText) cotTextCache.set(mesText, { raw: rawMessage, text });
        return text;
    }
    const elements = Array.from(mesText?.querySelectorAll("think, thinking") || []);
    if (elements.length) return elements.map((el) => stripHtmlToText(el.innerHTML).trim()).join("\n\n");
    return extractCotBlock(mesText?.textContent || "");
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

function ensureHiddenCotBlock(mesText, hiddenClass, ignoredClasses, rawMessage = "", cotText = "") {
    const existingHiddenNodes = Array.from(mesText.querySelectorAll(`.${hiddenClass}`));
    if (existingHiddenNodes.length) {
        return existingHiddenNodes[0];
    }

    // Some renderers leave real HTML elements; others escape the tags as text.
    for (const element of mesText.querySelectorAll("think, thinking")) {
        if (ignoredClasses.some((name) => element.closest(`.${name}`))) continue;
        const hidden = document.createElement("span");
        hidden.className = hiddenClass;
        hidden.hidden = true;
        element.before(hidden);
        hidden.appendChild(element);
    }

    const nodes = getTextNodesForMatch(mesText, ignoredClasses);
    const rawText = nodes.map((node) => node.nodeValue || "").join("");
    // Store offsets per text node instead of allocating an object per character.
    const positions = [];
    let offset = 0;
    for (const node of nodes) {
        positions.push({ node, start: offset, end: offset + node.length });
        offset += node.length;
    }
    const ranges = findCotBlocks(rawText).map((block) => {
        const start = positions.find((pos) => pos.end > block.start);
        const end = positions.find((pos) => pos.end >= block.end);
        if (!start || !end) return null;
        const range = document.createRange();
        range.setStart(start.node, block.start - start.start);
        range.setEnd(end.node, block.end - end.start);
        return { range, legacy: block.legacy };
    }).filter(Boolean);
    for (const { range, legacy } of ranges.reverse()) {
        const hidden = document.createElement("span");
        hidden.className = hiddenClass;
        hidden.hidden = true;
        if (legacy) hidden.dataset.legacyCot = "1";
        hidden.appendChild(range.extractContents());
        range.insertNode(hidden);
    }
    const taggedHidden = mesText.querySelector(`.${hiddenClass}`);
    if (taggedHidden) return taggedHidden;

    // Regex/Markdown preprocessing may remove the tags before they reach DOM.
    // First try an exact normalized content match, allowing Markdown list syntax
    // and the configured removal of angle brackets around literal tag references.
    const variants = [cotText, stripHtmlToText(cotText), cotText.replace(/[<>]/g, "")];
    const candidates = new Set();
    for (const variant of variants) {
        const plain = variant.replace(/^[ \t]*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/gm, "")
            .replace(/\*\*|__|`/g, "");
        for (const value of [variant, plain]) {
            if (!value.trim()) continue;
            candidates.add(`thinking\n${value}`);
            candidates.add(`think\n${value}`);
            candidates.add(value);
        }
    }
    const normalizedDomText = normalizeTextForMatch(rawText);
    for (const candidate of candidates) {
        if (!getNormalizedMatchCandidates(candidate).some((target) => normalizedDomText.includes(target))) continue;
        const matched = ensureHiddenMatchedText(mesText, candidate, hiddenClass, ignoredClasses);
        if (matched) return matched;
    }

    // If formatting also changed the text, only use a structural boundary when
    // the raw message proves that a single CoT is the entire leading section.
    const blocks = findCotBlocks(rawMessage);
    if (blocks.length !== 1 || rawMessage.slice(0, blocks[0].start).trim()) return null;
    const suffix = rawMessage.slice(blocks[0].end).trim().replace(/^(?:<\/(?:think|thinking)\s*>\s*)+/i, "");
    const contentElements = Array.from(mesText.querySelectorAll("content"));
    const contentAnchor = /^<content\s*>/i.test(suffix) && contentElements.length === 1 ? contentElements[0] : null;
    if (suffix && !contentAnchor) return null;
    const range = document.createRange();
    range.selectNodeContents(mesText);
    if (contentAnchor) {
        let boundary = contentAnchor;
        while (boundary.parentElement !== mesText && !boundary.previousSibling) boundary = boundary.parentElement;
        range.setEndBefore(boundary);
    }
    if (!range.toString().trim()) return null;
    const hidden = document.createElement("span");
    hidden.className = hiddenClass;
    hidden.hidden = true;
    hidden.appendChild(range.extractContents());
    range.insertNode(hidden);
    return hidden;
}

function ensureHiddenMatchedText(mesText, sourceText, hiddenClass, ignoredClasses) {
    const targets = getNormalizedMatchCandidates(sourceText);
    if (!targets.length) {
        return null;
    }

    const existingHiddenNodes = Array.from(mesText.querySelectorAll(`.${hiddenClass}`));
    if (existingHiddenNodes.length) {
        const exactHidden = existingHiddenNodes.find((hidden) => {
            const hiddenText = normalizeTextForMatch(hidden.textContent);
            return targets.includes(hiddenText);
        });
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
    const target = targets.find((candidate) => haystack.includes(candidate));
    if (!target) {
        return null;
    }

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
    if (!frame?.isConnected) {
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
        const fallbackHeight = primaryHeight ? 0 : Math.ceil(Math.max(
            body?.firstElementChild?.getBoundingClientRect?.().height || 0,
            body?.scrollHeight || 0,
            root?.scrollHeight || 0,
        ));
        const height = Math.max(primaryHeight || fallbackHeight, 24);
        if (frame.__stlsbLastHeight !== height) {
            frame.__stlsbLastHeight = height;
            frame.style.height = `${height}px`;
        }
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
        if (frame.__stlsbResizeRaf) window.cancelAnimationFrame(frame.__stlsbResizeRaf);
        frame.__stlsbResizeRaf = null;
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
        if (frame.__stlsbResizeRaf) return;
        frame.__stlsbResizeRaf = window.requestAnimationFrame(() => {
            frame.__stlsbResizeRaf = null;
            updateFrameHeight(frame);
        });
    };

    frame.addEventListener("load", () => {
        if (!frame.isConnected) return;
        if (frame.contentWindow) frame.contentWindow.__STLSB_SCHEDULE_RESIZE__ = scheduleResize;
        onLoad?.(frame);
        scheduleResize();

        try {
            frame.__resizeObserver?.disconnect?.();
            const observer = new ResizeObserver(() => scheduleResize());
            const doc = frame.contentDocument;
            const cotPanel = doc?.querySelector(".aether-collapsible");
            if (cotPanel) {
                observer.observe(cotPanel);
            } else if (doc?.documentElement) {
                observer.observe(doc.documentElement);
            }
            if (!cotPanel && doc?.body) {
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
        clearCotPrefixLayout(mesText);
        clearCotBoundaryLayout(mesText);
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

    if (host.parentElement !== hidden.parentElement || host.nextSibling !== hidden) {
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
    const cotText = getCotTextForMessage(rawMessage, mesText);
    if (!cotText) {
        destroyHost(getCotHostByMesId(mesId));
        clearHiddenNodes(mesText, `.${cotHiddenSourceClass}`);
        return;
    }

    const hidden = ensureHiddenCotBlock(
        mesText,
        cotHiddenSourceClass,
        [statusHostClass, statusHiddenSourceClass, cotHostClass, cotHiddenSourceClass],
        rawMessage,
        cotText,
    );
    if (!hidden) {
        destroyHost(getCotHostByMesId(mesId));
        clearHiddenNodes(mesText, `.${cotHiddenSourceClass}`);
        return;
    }
    if (hidden.dataset.legacyCot === "1") {
        trimBreakAfterHidden(hidden);
        normalizeCotFollowingList(hidden);
    }

    let host = getCotHostByMesId(mesId);
    if (!host) {
        host = createCotHost(mesId);
    }

    if (host.parentElement !== hidden.parentElement || host.nextSibling !== hidden) {
        hidden.before(host);
    }

    const frame = host.querySelector(`.${cotFrameClass}`);
    if (!frame) {
        return;
    }

    bindFrame(frame, (currentFrame) => {
        currentFrame.contentWindow?.setCotContent?.(currentFrame.__stlCotText || "");
        currentFrame.classList.add("st-local-cot-frame-ready");
        updateFrameHeight(currentFrame);
    });

    const version = `${cotFragment.length}:${cotFragment.charCodeAt(0) || 0}`;
    const textChanged = frame.__stlCotText !== cotText;
    frame.__stlCotText = cotText;
    if (frame.dataset.fragmentVersion !== version || frame.__stlCotFragment !== cotFragment) {
        frame.dataset.fragmentVersion = version;
        frame.__stlCotFragment = cotFragment;
        frame.classList.remove("st-local-cot-frame-ready");
        frame.srcdoc = buildCotSrcdoc(cotFragment, cotText);
    } else if (textChanged) {
        // Keep the document, expansion state and inner scroll position alive.
        frame.contentWindow?.setCotContent?.(cotText);
    }
}

function clearCotPrefixLayout(mesText) {
    mesText.querySelectorAll('.st-local-cot-prefix-space').forEach(restoreHiddenSource);
    mesText.querySelectorAll('.st-local-cot-prefix-empty').forEach(el => el.classList.remove('st-local-cot-prefix-empty'));
}

function applyCotPrefixLayout(mes) {
    const mesText = mes.querySelector('.mes_text');
    if (!mesText) return;
    const host = mesText.querySelector(`.${cotHostClass}`);
    if (!host) { clearCotPrefixLayout(mesText); return; }
    const empty = node => {
        if (node.nodeType === Node.TEXT_NODE) return !node.textContent.trim();
        if (node.nodeType === Node.COMMENT_NODE) return true;
        // Do not hide media, controls, icons or arbitrary custom components.
        if (!(node instanceof Element) || !node.matches('p, blockquote, div, span, br, ul, ol, li')) return false;
        if (node.matches('[role], [tabindex], [contenteditable], [onclick]') || node.classList.contains(cotHiddenSourceClass)) return false;
        return Array.from(node.childNodes).every(empty);
    };
    const selected = new Set();
    let child = host;
    while (child && child !== mesText) {
        let node = child.previousSibling;
        while (node && empty(node)) {
            const previous = node.previousSibling;
            if (node.nodeType === Node.TEXT_NODE) {
                const wrapper = document.createElement('span');
                wrapper.className = 'st-local-cot-prefix-space';
                node.before(wrapper);
                wrapper.appendChild(node);
                selected.add(wrapper);
            } else if (node instanceof Element) {
                if (!node.classList.contains('st-local-cot-prefix-space')) node.classList.add('st-local-cot-prefix-empty');
                selected.add(node);
            }
            node = previous;
        }
        if (node) break;
        child = child.parentElement;
    }
    mesText.querySelectorAll('.st-local-cot-prefix-empty').forEach(el => {
        if (!selected.has(el)) el.classList.remove('st-local-cot-prefix-empty');
    });
    mesText.querySelectorAll('.st-local-cot-prefix-space').forEach(el => {
        if (!selected.has(el)) restoreHiddenSource(el);
    });
}

function clearCotBoundaryLayout(mesText) {
    mesText.querySelectorAll('.st-local-cot-leading-gap').forEach(restoreHiddenSource);
    mesText.querySelectorAll('.st-local-cot-list-shell').forEach(el => el.classList.remove('st-local-cot-list-shell'));
}

function applyCotBoundaryLayout(mes) {
    const mesText = mes.querySelector('.mes_text');
    if (!mesText) return;
    const content = mesText.querySelector('content');
    const source = mesText.querySelector(`.${cotHiddenSourceClass}`);
    const raw = getRawMessageByDomMessage(mes);
    const blocks = findCotBlocks(raw);
    const last = blocks[blocks.length - 1];
    const suffix = last ? raw.slice(last.end).replace(/^(?:\s*<\/(?:think|thinking)\s*>)+/i, '') : '';
    if (!content || !source || !/^\s*<content\s*>/i.test(suffix)) {
        clearCotBoundaryLayout(mesText);
        return;
    }
    // Only style the ancestor list left by Markdown, never lists inside CONTENT.
    let child = content;
    for (let parent = content.parentElement; parent && parent !== mesText; parent = parent.parentElement) {
        const preceding = [];
        for (let node = parent.firstChild; node && node !== child; node = node.nextSibling) preceding.push(node);
        const blank = node => node.nodeType === Node.TEXT_NODE ? !node.textContent.trim()
            : node instanceof HTMLBRElement || node.classList?.contains('st-local-cot-leading-gap');
        if (!preceding.every(blank)) break;
        if (parent.matches('li, ul, ol')) {
            if (!parent.classList.contains('st-local-cot-list-shell')) parent.classList.add('st-local-cot-list-shell');
            const fresh = preceding.filter(node => !node.classList?.contains('st-local-cot-leading-gap'));
            if (fresh.length) {
                const hidden = document.createElement('span');
                hidden.className = 'st-local-cot-leading-gap';
                hidden.hidden = true;
                fresh[0].before(hidden);
                fresh.forEach(node => hidden.appendChild(node));
            }
        }
        child = parent;
    }
}

function applyNarrativeIndent(mes) {
    const mesText = mes.querySelector(".mes_text");
    if (!mesText) return;
    const markerClass = "st-local-narrative-indent-marker";
    const selected = new Set();
    const raw = getRawMessageByDomMessage(mes);
    const endCot = Array.from(raw.matchAll(/<\/(?:think|thinking)\s*>/gi)).pop();
    const suffix = endCot ? raw.slice(endCot.index + endCot[0].length) : "";
    const hasStatus = /<(?:StatusBlock|Status_block|Status)\s*>/i.test(suffix);
    // Remove the old block-level rule: Markdown may use one P for many lines.
    for (const el of mesText.querySelectorAll(".st-local-narrative-indent")) el.classList.remove("st-local-narrative-indent");
    if (hasStatus) {
        const sources = mesText.querySelectorAll(`.${cotHiddenSourceClass}, think, thinking`);
        const start = sources[sources.length - 1];
        const end = mesText.querySelector(`.${statusHiddenSourceClass}, statusblock, status_block, status`);
        const owned = `.${cotHostClass}, .${cotHiddenSourceClass}, .${statusHostClass}, .${statusHiddenSourceClass}, .${markerClass}, .st-local-cot-leading-gap, .st-local-cot-prefix-empty, .st-local-cot-prefix-space, pre, code, table, script, style`;
        const explicitContent = /^\s*<content\s*>/i.test(suffix);
        const walker = document.createTreeWalker(mesText, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (node instanceof Element && node.matches(owned)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        const starts = [];
        let atStart = true;
        let previousBlock = null;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node instanceof HTMLBRElement) { atStart = true; continue; }
            if (node.nodeType !== Node.TEXT_NODE) continue;
            const content = explicitContent && node.parentElement.closest("content");
            const after = start && Boolean(start.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
            const before = end && Boolean(end.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING);
            if (!(after && before) && !content) continue;
            const block = node.parentElement.closest("p, div, content, li, blockquote, h1, h2, h3, h4, h5, h6");
            if (block !== previousBlock) atStart = true;
            previousBlock = block;
            const text = node.nodeValue || "";
            for (let offset = 0; offset < text.length; offset++) {
                if (text[offset] === "\n" || text[offset] === "\r") { atStart = true; continue; }
                if (/\s/.test(text[offset])) continue;
                if (atStart) starts.push({ node, offset });
                atStart = false;
            }
        }
        // Empty inline markers indent explicit paragraph starts, not wrapped
        // display lines. No chat text or existing highlighted elements are replaced.
        for (const { node, offset } of starts.reverse()) {
            const text = offset ? node.splitText(offset) : node;
            let marker = text.previousSibling;
            if (!(marker instanceof Element) || !marker.classList.contains(markerClass)) {
                marker = document.createElement("span");
                marker.className = markerClass;
                marker.setAttribute("aria-hidden", "true");
                text.before(marker);
            }
            selected.add(marker);
        }
    }
    for (const marker of mesText.querySelectorAll(`.${markerClass}`)) {
        if (!selected.has(marker)) marker.remove();
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
        applyCotPrefixLayout(mes);
        applyCotBoundaryLayout(mes);
        applyNarrativeIndent(mes);

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

function queueInitialMountRetries() {
    initialRetryTimers.forEach((timer) => clearTimeout(timer));
    initialRetryTimers = [120, 350, 800, 1500, 3000].map((delay) => window.setTimeout(() => {
        installDomObserver();
        installEventHooks();
        queueMount(0);
    }, delay));
}

// Generation and editing emit several events for one visible change.
function queueEventRemount(delay = 250) {
    if (remountTimer) clearTimeout(remountTimer);
    remountTimer = window.setTimeout(() => {
        remountTimer = null;
        lastCharacterMessageSignature = "";
        queueMount(0);
    }, delay);
}

function installEventHooks() {
    if (eventHooksInstalled) {
        return;
    }

    const context = getContextSafe();
    const eventSource = context?.eventSource || globalThis.eventSource;
    if (!eventSource || typeof eventSource.on !== "function") {
        return;
    }

    const remount = () => queueEventRemount();

    [
        "app_ready",
        "chat_changed",
        "chat_id_changed",
        "message_received",
        "message_updated",
        "message_swiped",
        "generation_ended",
    ].forEach((eventName) => eventSource.on(eventName, remount));
    eventHooksInstalled = true;
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
    const chatRoot = getChatRoot();
    const observeRoot = chatRoot || document.body;
    if (!observeRoot) {
        return false;
    }

    if (domObserver && domObserverRoot === observeRoot) {
        return;
    }

    const isRelevantNode = (node) => {
        const el = node instanceof Element ? node : node?.parentElement;
        if (!el) {
            return false;
        }
        if (!chatRoot) {
            return Boolean(
                el.id === "chat"
                || el.querySelector?.("#chat")
            );
        }
        if (el.closest?.(`.${statusHostClass}, .${statusHiddenSourceClass}, .${cotHostClass}, .${cotHiddenSourceClass}`)) {
            return false;
        }
        return Boolean(
            el.matches?.('#chat .mes[is_user="false"], #chat .mes[is_user="false"] .mes_text, #chat .mes[is_user="false"] .mes_text *')
            || el.querySelector?.('.mes[is_user="false"], .mes[is_user="false"] .mes_text')
            || el.closest?.('#chat .mes[is_user="false"]')
            || el.closest?.('#chat .mes[is_user="false"] .mes_text')
        );
    };

    domObserver?.disconnect?.();
    domObserver = new MutationObserver((mutations) => {
        const chatAppeared = !chatRoot && getChatRoot();
        if (chatAppeared) {
            installDomObserver();
            lastCharacterMessageSignature = "";
            queueMount(0);
            queueEventRemount();
            return;
        }

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
            if (mutation.type === "characterData") return false;
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

    domObserver.observe(observeRoot, {
        childList: true,
        subtree: true,
        characterData: Boolean(chatRoot),
    });
    domObserverRoot = observeRoot;
    return true;
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
    installEventHooks();
    queueMount(0);
    queueInitialMountRetries();
});
