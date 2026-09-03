// The unpacked production build talks to the Railway API. Local development
// can temporarily point this URL to http://127.0.0.1:4317.
const API = "https://gamepilot-api-production.up.railway.app";
// Fallback only for local development. Production uses the paired device token.
const TOKEN = "dev-agent-token";
const DEVICE_TOKEN_KEY = "gamepilot.deviceToken";
const INSTALLATION_ID_KEY = "gamepilot.installationId";

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

async function api(path, options = {}, { allowLegacy = true } = {}) {
  const token = await deviceToken();
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };
  if (token) headers["x-gamepilot-device"] = token;
  else if (allowLegacy) headers["x-gamepilot-agent"] = TOKEN;
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
  }, { allowLegacy: false });
  await storageSet({ [DEVICE_TOKEN_KEY]: data.deviceToken });
  return data;
}

async function pairedDeviceStatus() {
  const token = await deviceToken();
  if (!token) return { status: "unpaired", device: null, connections: [] };
  return api("/api/v1/extension/device-status", {}, { allowLegacy: false });
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
    (async () => sendResponse({ ok: true, ...(await pairedDeviceStatus()) }))()
      .catch((error) => sendResponse({ ok: false, error: error.message }));
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

  if (message.type !== "page-state") return;

  (async () => {
    const state = { ...message.state, tabId: sender.tab?.id };
    await api("/api/v1/agent/state", { method: "POST", body: JSON.stringify(state) });
    const query = state.connectionKey ? `?connectionKey=${encodeURIComponent(state.connectionKey)}` : "";
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
