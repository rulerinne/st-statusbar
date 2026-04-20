import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "st-local-statusbar";
const extensionBaseUrl = new URL(".", import.meta.url);
const hostId = "st-local-statusbar-host";
const frameId = "st-local-statusbar-frame";
const enabledInputId = "st_local_statusbar_enabled";
const reloadButtonId = "st_local_statusbar_reload";
const hiddenSourceClass = "st-local-statusbar-hidden-source";

const defaultSettings = {
    enabled: true,
};

const bridgeScript = `
<script>
window.__STLSB_BRIDGE__ = window.__STLSB_BRIDGE__ || { message: "" };
window.getCurrentMessageId = () => 0;
window.getChatMessages = () => [{ message: window.__STLSB_BRIDGE__.message || "" }];
</script>`;

let fragmentCache = null;
let mountTimer = null;
let syncTimer = null;
let domObserver = null;
let eventSourceInstalled = false;

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

function getHost() {
    return document.getElementById(hostId);
}

function getFrame() {
    return document.getElementById(frameId);
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

function buildSrcdoc(fragment) {
    if (fragment.includes("<head>")) {
        return `<!doctype html><html lang="zh-CN">${fragment.replace("<head>", `<head>${bridgeScript}`)}</html>`;
    }
    return `<!doctype html><html lang="zh-CN"><head>${bridgeScript}</head>${fragment}</html>`;
}

async function loadFragment() {
    if (fragmentCache !== null) {
        return fragmentCache;
    }
    fragmentCache = await $.get(fileUrl("statusbar.fragment.html"));
    return fragmentCache;
}

function getCurrentRawMessage() {
    try {
        if (typeof window.getCurrentMessageId !== "function" || typeof window.getChatMessages !== "function") {
            return "";
        }
        const data = window.getChatMessages(window.getCurrentMessageId());
        const messageObj = Array.isArray(data) ? data[0] : data;
        return typeof messageObj?.message === "string" ? messageObj.message : "";
    } catch (error) {
        console.warn("[st-local-statusbar] Failed to read current raw message:", error);
        return "";
    }
}

function getCurrentMessageElement() {
    let id = null;
    try {
        id = typeof window.getCurrentMessageId === "function" ? window.getCurrentMessageId() : null;
    } catch (error) {
        id = null;
    }

    if (id !== null && typeof id !== "undefined") {
        const escapedId = CSS.escape(String(id));
        const selectors = [
            `#chat .mes[mesid="${escapedId}"]`,
            `#chat .mes[data-mes-id="${escapedId}"]`,
            `#chat .mes[data-message-id="${escapedId}"]`,
        ];
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) {
                return el;
            }
        }
    }

    const messages = Array.from(document.querySelectorAll("#chat .mes"));
    return messages.length ? messages[messages.length - 1] : null;
}

function getTextNodesForMatch(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) {
                return NodeFilter.FILTER_REJECT;
            }
            if (parent.closest(`#${hostId}, .${hiddenSourceClass}`)) {
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

function hideStatusTextInMessage(mesText, statusText) {
    const existingHidden = mesText.querySelector(`.${hiddenSourceClass}`);
    if (existingHidden) {
        return existingHidden;
    }

    const target = normalizeTextForMatch(statusText);
    if (!target) {
        return null;
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

function placeHostInRenderedMessage(host, rawMessage) {
    const statusText = extractStatusBlock(rawMessage);
    if (!statusText) {
        return false;
    }

    const candidates = [];
    const currentMesText = getCurrentMessageElement()?.querySelector(".mes_text");
    if (currentMesText) {
        candidates.push(currentMesText);
    }
    candidates.push(...Array.from(document.querySelectorAll("#chat .mes_text")).reverse());

    const seen = new Set();
    for (const mesText of candidates) {
        if (!mesText || seen.has(mesText)) {
            continue;
        }
        seen.add(mesText);

        const hidden = hideStatusTextInMessage(mesText, statusText);
        if (!hidden) {
            continue;
        }

        if (host.parentElement !== mesText || host.nextSibling !== hidden) {
            hidden.before(host);
        }
        return true;
    }

    return false;
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
        const height = Math.max(
            root?.scrollHeight || 0,
            body?.scrollHeight || 0,
            root?.offsetHeight || 0,
            body?.offsetHeight || 0,
            140,
        );
        frame.style.height = `${height}px`;
    } catch (error) {
        console.warn("[st-local-statusbar] Failed to resize iframe:", error);
    }
}

function syncFrameMessage(force = false) {
    const frame = getFrame();
    if (!frame || !ensureSettings().enabled) {
        return;
    }

    const rawMessage = getCurrentRawMessage();
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

function queueSync(delay = 60, force = false) {
    if (syncTimer) {
        clearTimeout(syncTimer);
    }
    syncTimer = window.setTimeout(() => syncFrameMessage(force), delay);
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
        syncFrameMessage(true);

        try {
            if (frame.__statusbarResizeObserver) {
                frame.__statusbarResizeObserver.disconnect();
            }

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

        if (frame.__statusbarHeightTimer) {
            clearInterval(frame.__statusbarHeightTimer);
        }
        frame.__statusbarHeightTimer = window.setInterval(() => {
            scheduleResize();
            syncFrameMessage();
        }, 1000);
    });
}

function createHost() {
    const host = document.createElement("div");
    host.id = hostId;
    host.className = "st-local-statusbar-host";
    host.setAttribute("data-name", "本地状态栏");
    host.innerHTML = `
        <div class="st-local-statusbar-shell">
            <iframe
                id="${frameId}"
                class="st-local-statusbar-frame"
                title="本地状态栏"
                scrolling="no"
                loading="eager"
                referrerpolicy="no-referrer"
            ></iframe>
        </div>
    `;
    return host;
}

function applyEnabledState() {
    const host = getHost();
    if (!host) {
        return;
    }
    host.style.display = ensureSettings().enabled ? "" : "none";
}

async function ensureMounted() {
    const settings = ensureSettings();
    const rawMessage = getCurrentRawMessage();

    let host = getHost();
    if (!host) {
        host = createHost();
    }

    const placedInMessage = placeHostInRenderedMessage(host, rawMessage);
    if (!placedInMessage && host.parentElement !== document.body) {
        document.body.appendChild(host);
    }

    applyEnabledState();
    if (!settings.enabled) {
        return;
    }

    const frame = host.querySelector("iframe");
    bindFrame(frame);

    const fragment = await loadFragment();
    const version = `${fragment.length}:${fragment.charCodeAt(0) || 0}`;
    if (frame.dataset.fragmentVersion !== version) {
        frame.dataset.fragmentVersion = version;
        delete frame.__stlsbLastMessage;
        frame.srcdoc = buildSrcdoc(fragment);
    } else {
        updateFrameHeight(frame);
        queueSync(0, true);
    }
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
    applyEnabledState();
    if (ensureSettings().enabled) {
        queueMount(0);
        queueSync(120, true);
    }
}

function onReloadClick() {
    fragmentCache = null;
    const frame = getFrame();
    if (frame) {
        delete frame.dataset.fragmentVersion;
        delete frame.__stlsbLastMessage;
    }
    queueMount(0);
    if (typeof toastr !== "undefined") {
        toastr.success("已重新载入本地状态栏", "本地状态栏");
    }
}

function installDomObserver() {
    if (domObserver) {
        return;
    }
    domObserver = new MutationObserver(() => {
        queueMount();
        queueSync(120);
    });
    domObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

function installEventSourceHooks() {
    if (eventSourceInstalled) {
        return;
    }
    const evtSrc = window.eventSource;
    if (!evtSrc || typeof evtSrc.on !== "function") {
        return;
    }
    const trigger = () => {
        queueMount(50);
        queueSync(100);
    };
    ["generation_ended", "message_updated", "chat_id_changed", "message_sent"].forEach((eventName) => {
        evtSrc.on(eventName, trigger);
    });
    eventSourceInstalled = true;
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
    $(`#${enabledInputId}`).on("input", onEnabledInput);
    $(`#${reloadButtonId}`).on("click", onReloadClick);
}

function syncSettingsUi() {
    const settings = ensureSettings();
    $(`#${enabledInputId}`).prop("checked", settings.enabled);
}

jQuery(async () => {
    ensureSettings();
    await initSettingsUi();
    syncSettingsUi();
    installDomObserver();
    installEventSourceHooks();
    queueMount(0);
    queueSync(150, true);
});
