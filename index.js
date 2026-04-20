import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "st-local-statusbar";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const fragmentUrl = `${extensionFolderPath}/statusbar.fragment.html`;

const hostId = "st-local-statusbar-host";
const frameId = "st-local-statusbar-frame";
const enabledInputId = "st_local_statusbar_enabled";
const reloadButtonId = "st_local_statusbar_reload";

const defaultSettings = {
    enabled: true,
};

let fragmentCache = null;
let mountTimer = null;
let domObserver = null;

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

function buildSrcdoc(fragment) {
    return `<!doctype html><html lang="zh-CN">${fragment}</html>`;
}

async function loadFragment() {
    if (fragmentCache !== null) {
        return fragmentCache;
    }
    fragmentCache = await $.get(fragmentUrl);
    return fragmentCache;
}

function getChatMountTarget() {
    const chat = document.getElementById("chat");
    if (!chat || !chat.parentElement) {
        return null;
    }
    return { chat, parent: chat.parentElement };
}

function getHost() {
    return document.getElementById(hostId);
}

function getFrame() {
    return document.getElementById(frameId);
}

function applyEnabledState() {
    const host = getHost();
    if (!host) {
        return;
    }
    host.hidden = !ensureSettings().enabled;
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
            120,
        );
        frame.style.height = `${height}px`;
    } catch (error) {
        console.warn("[st-local-statusbar] Failed to resize iframe:", error);
    }
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

        try {
            if (frame.__statusbarResizeObserver) {
                frame.__statusbarResizeObserver.disconnect();
            }

            const ro = new ResizeObserver(() => scheduleResize());
            const doc = frame.contentDocument;
            if (doc?.documentElement) {
                ro.observe(doc.documentElement);
            }
            if (doc?.body) {
                ro.observe(doc.body);
            }
            frame.__statusbarResizeObserver = ro;
        } catch (error) {
            console.warn("[st-local-statusbar] ResizeObserver unavailable:", error);
        }

        if (frame.__statusbarHeightTimer) {
            clearInterval(frame.__statusbarHeightTimer);
        }
        frame.__statusbarHeightTimer = window.setInterval(scheduleResize, 800);
    });
}

function createHost() {
    const host = document.createElement("div");
    host.id = hostId;
    host.className = "st-local-statusbar-host";
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

async function ensureMounted() {
    const settings = ensureSettings();
    const mount = getChatMountTarget();
    if (!mount) {
        return;
    }

    let host = getHost();
    if (!host) {
        host = createHost();
    }

    if (host.parentElement !== mount.parent || host.nextElementSibling !== mount.chat) {
        mount.parent.insertBefore(host, mount.chat);
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
        frame.srcdoc = buildSrcdoc(fragment);
    } else {
        updateFrameHeight(frame);
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
    const settings = ensureSettings();
    settings.enabled = Boolean($(event.target).prop("checked"));
    saveSettingsDebounced();
    applyEnabledState();
    if (settings.enabled) {
        queueMount(0);
    }
}

function onReloadClick() {
    fragmentCache = null;
    const frame = getFrame();
    if (frame) {
        delete frame.dataset.fragmentVersion;
    }
    queueMount(0);
    toastr.success("已重新载入本地状态栏", "本地状态栏");
}

function installDomObserver() {
    if (domObserver) {
        return;
    }
    domObserver = new MutationObserver(() => queueMount());
    domObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

async function initSettingsUi() {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings2").append(settingsHtml);
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
    queueMount(0);
});
