// The unpacked production build talks to the GamePilot API. Local development
// can temporarily point this URL to http://127.0.0.1:4317.
const API = "https://gamepilot-api.iancosta.dev";
const WEB = API.includes("127.0.0.1") || API.includes("localhost")
  ? "http://127.0.0.1:3000"
  : "https://gamepilot-web.iancosta.dev";
const DEVICE_TOKEN_KEY = "gamepilot.deviceToken";
const INSTALLATION_ID_KEY = "gamepilot.installationId";

function environmentView() {
  const hostname = new URL(API).hostname;
  const local = hostname === "127.0.0.1" || hostname === "localhost";
  return { key: local ? "local" : "production", label: local ? "Desenvolvimento local" : "Produção" };
}

function compareVersions(left, right) {
  const leftParts = String(left || "0").split(".").map((part) => Number(part) || 0);
  const rightParts = String(right || "0").split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

async function extensionVersionStatus() {
  const installed = chrome.runtime.getManifest().version;
  try {
    const response = await fetch(`${WEB}/extension-version.json?at=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Versão ${response.status}`);
    const data = await response.json();
    const latest = String(data?.version || "").trim() || null;
    const comparison = latest ? compareVersions(installed, latest) : 0;
    return {
      installed,
      latest,
      updateAvailable: Boolean(latest) && comparison < 0,
      aheadOfPublished: Boolean(latest) && comparison > 0
    };
  } catch {
    return { installed, latest: null, updateAvailable: false, aheadOfPublished: false };
  }
}

function storageGet(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, (value) => resolve(value?.[key] || null)));
}

function storageSet(values) {
  return new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve();
  }));
}

function randomId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function installationId() {
  const current = await storageGet(INSTALLATION_ID_KEY);
  if (current) return current;
  const created = randomId("installation");
  await storageSet({ [INSTALLATION_ID_KEY]: created });
  return created;
}

async function deviceToken() {
  return storageGet(DEVICE_TOKEN_KEY);
}

async function api(path, options = {}) {
  const token = await deviceToken();
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };
  if (token) headers["x-gamepilot-device"] = token;
  const response = await fetch(`${API}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `API ${response.status}`);
  return data;
}

async function pairDevice(code) {
  const data = await api("/api/v1/extension/pair", {
    method: "POST",
    body: JSON.stringify({
      code: String(code || "").trim().toUpperCase(),
      installationId: await installationId(),
      name: "Chrome",
      browser: "Chrome",
      extensionVersion: chrome.runtime.getManifest().version
    })
  });
  await storageSet({ [DEVICE_TOKEN_KEY]: data.deviceToken });
  return { ...(await pairedDeviceStatus()), version: await extensionVersionStatus() };
}

async function pairedDeviceStatus() {
  const token = await deviceToken();
  if (!token) return { status: "unpaired", environment: environmentView(), account: null, device: null, connections: [] };
  return { ...(await api("/api/v1/extension/device-status")), status: "paired", environment: environmentView() };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "pair-device") {
    (async () => {
      const data = await pairDevice(message.code);
      sendResponse({ ok: true, ...data });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "device-status") {
    (async () => {
      const version = await extensionVersionStatus();
      try {
        sendResponse({ ok: true, ...(await pairedDeviceStatus()), version });
      } catch (error) {
        sendResponse({ ok: false, error: error.message, environment: environmentView(), version });
      }
    })();
    return true;
  }

  if (message.type === "agent-event") {
    (async () => {
      const event = { ...(message.event || {}), connectionKey: message.connectionKey || null };
      await api("/api/v1/agent/event", { method: "POST", body: JSON.stringify(event) });
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "agent-disconnect") {
    (async () => {
      await api("/api/v1/agent/disconnect", { method: "POST", body: JSON.stringify({ connectionKey: message.connectionKey || null }) });
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type !== "page-state") return;

  (async () => {
    const state = { ...message.state, tabId: sender.tab?.id };
    await api("/api/v1/agent/state", { method: "POST", body: JSON.stringify(state) });
    // Busy tabs only receive stop/return interrupts. Normal commands remain
    // queued until the content script finishes its current operation.
    const query = `?connectionKey=${encodeURIComponent(state.connectionKey || "")}${message.wantsCommand === false ? "&interruptOnly=true" : ""}`;
    const command = await api(`/api/v1/agent/commands${query}`);
    sendResponse({
      ok: true,
      command: command.command,
      commandId: command.commandId,
      payload: command.payload || {}
    });
  })().catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
