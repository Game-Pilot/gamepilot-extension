// The unpacked production build talks to the GamePilot API. Local development
// can temporarily point this URL to http://127.0.0.1:4317.
const API = "https://gamepilot-api.iancosta.dev";
const WEB = API.includes("127.0.0.1") || API.includes("localhost")
  ? "http://127.0.0.1:3000"
  : "https://gamepilot-web.iancosta.dev";
const DEVICE_TOKEN_KEY = "gamepilot.deviceToken";
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Não foi possível configurar o painel lateral", error));
const INSTALLATION_ID_KEY = "gamepilot.installationId";
const API_TIMEOUT_MS = 7000;
const API_RETRY_DELAYS_MS = [250, 750];
const SOCKET_URL = `${API.replace(/^http/, "ws")}/api/v1/agent/socket`;
const SOCKET_PROTOCOL = "gamepilot-v1";
let agentSocket = null;
let socketOpening = null;
let socketWanted = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let socketKeepAlive = null;
const pendingSocketMessages = new Map();
const connectionTabs = new Map();
const pushedCommandIds = new Map();

const PAGE_WATCH_KEY = "gamepilot.pageWatch";
const PAGE_WATCH_ALARM = "gamepilot-page-watch";
let pageWatchQueue = Promise.resolve();

// Serialize session storage updates so concurrent tabs cannot erase each other.
function updatePageWatch(action) {
  pageWatchQueue = pageWatchQueue.then(async () => {
    const stored = await chrome.storage.session.get(PAGE_WATCH_KEY);
    const pages = stored[PAGE_WATCH_KEY] || {};
    await action(pages);
    await chrome.storage.session.set({ [PAGE_WATCH_KEY]: pages });
  }).catch((error) => console.warn("Falha no monitor da aba", error));
  return pageWatchQueue;
}

async function recoverSilentPages(pages) {
  const now = Date.now();
  for (const [id, page] of Object.entries(pages)) {
    if (now - page.lastSeen < 30000 || now - (page.lastFocus || 0) < 120000) continue;
    let tab;
    try { tab = await chrome.tabs.get(Number(id)); }
    catch { delete pages[id]; continue; }
    if (!tab.url?.startsWith("https://huntera.com.br/")) { delete pages[id]; continue; }
    page.lastFocus = now;
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (error) { console.warn("Não foi possível focar a aba do jogo", error); }
    // Recover one window per check, avoiding a focus race between silent tabs.
    break;
  }
}

if (chrome.alarms) {
  // One minute also supports the manifest's minimum Chrome version (116).
  chrome.alarms.create(PAGE_WATCH_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === PAGE_WATCH_ALARM) void updatePageWatch(recoverSilentPages);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void updatePageWatch((pages) => { delete pages[tabId]; });
  });
}

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${WEB}/extension-version.json?at=${Date.now()}`, { cache: "no-store", signal: controller.signal });
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
  } finally {
    clearTimeout(timeout);
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

function failPendingSocketMessages(error) {
  for (const pending of pendingSocketMessages.values()) {
    clearTimeout(pending.timeout);
    pending.reject(Object.assign(error, { sent: true }));
  }
  pendingSocketMessages.clear();
}

function scheduleSocketReconnect() {
  if (!socketWanted || reconnectTimer !== null) return;
  const base = Math.min(30000, 500 * (2 ** Math.min(reconnectAttempt, 6)));
  const delay = Math.round(base * (0.75 + Math.random() * 0.5));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void openAgentSocket().catch(() => scheduleSocketReconnect());
  }, delay);
}

function stopSocket() {
  socketWanted = false;
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  if (socketKeepAlive !== null) clearInterval(socketKeepAlive);
  reconnectTimer = null;
  socketKeepAlive = null;
  socketOpening = null;
  const socket = agentSocket;
  agentSocket = null;
  if (socket && socket.readyState < 2) socket.close(1000, "reset");
  failPendingSocketMessages(new Error("Canal WebSocket reiniciado"));
}

async function openAgentSocket() {
  socketWanted = true;
  if (agentSocket?.readyState === WebSocket.OPEN) return agentSocket;
  if (socketOpening) return socketOpening;
  if (typeof WebSocket === "undefined") throw Object.assign(new Error("WebSocket indisponível"), { sent: false });
  const token = await deviceToken();
  if (!token) throw Object.assign(new Error("Extensão não pareada"), { sent: false });

  socketOpening = new Promise((resolve, reject) => {
    const socket = new WebSocket(SOCKET_URL, [SOCKET_PROTOCOL, `gamepilot-device.${token}`]);
    agentSocket = socket;
    let opened = false;
    const openingTimeout = setTimeout(() => {
      if (!opened) socket.close(4000, "timeout");
    }, API_TIMEOUT_MS);
    socket.onopen = () => {
      opened = true;
      clearTimeout(openingTimeout);
      reconnectAttempt = 0;
      socketOpening = null;
      if (socketKeepAlive !== null) clearInterval(socketKeepAlive);
      socketKeepAlive = setInterval(() => {
        void socketRequest("ping", {}, 5000).catch(() => {
          if (socket.readyState < 2) socket.close(4001, "keepalive");
        });
      }, 20000);
      resolve(socket);
    };
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "command" && message.commandId && message.connectionKey) {
        const previousAt = pushedCommandIds.get(message.commandId) || 0;
        if (Date.now() - previousAt < 300000) return;
        const tabId = connectionTabs.get(message.connectionKey);
        if (!Number.isInteger(tabId)) return;
        pushedCommandIds.set(message.commandId, Date.now());
        chrome.tabs.sendMessage(tabId, {
          type: "agent-command", command: message.command, commandId: message.commandId,
          payload: message.payload || {}, redelivered: message.redelivered === true
        }, (response) => {
          if (chrome.runtime.lastError || response?.accepted !== true) pushedCommandIds.delete(message.commandId);
        });
        return;
      }
      const pending = pendingSocketMessages.get(message.replyTo);
      if (!pending) return;
      pendingSocketMessages.delete(message.replyTo);
      clearTimeout(pending.timeout);
      if (message.ok === false) pending.reject(Object.assign(new Error(message.error || "Falha no WebSocket"), { sent: true }));
      else pending.resolve(message);
    };
    socket.onerror = () => {
      if (!opened) reject(Object.assign(new Error("Não foi possível abrir o WebSocket"), { sent: false }));
    };
    socket.onclose = () => {
      clearTimeout(openingTimeout);
      if (agentSocket === socket) agentSocket = null;
      if (socketOpening) {
        socketOpening = null;
        if (!opened) reject(Object.assign(new Error("WebSocket fechado antes de conectar"), { sent: false }));
      }
      if (socketKeepAlive !== null) clearInterval(socketKeepAlive);
      socketKeepAlive = null;
      failPendingSocketMessages(new Error("WebSocket desconectado"));
      scheduleSocketReconnect();
    };
  });
  return socketOpening;
}

async function socketRequest(type, payload = {}, timeoutMs = 15000) {
  const socket = await openAgentSocket();
  const id = randomId("message");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingSocketMessages.delete(id);
      reject(Object.assign(new Error("WebSocket demorou demais para confirmar"), { sent: true }));
    }, timeoutMs);
    pendingSocketMessages.set(id, { resolve, reject, timeout });
    try { socket.send(JSON.stringify({ id, type, ...payload })); }
    catch (error) {
      pendingSocketMessages.delete(id);
      clearTimeout(timeout);
      reject(Object.assign(error, { sent: false }));
    }
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

// Every request has a deadline so one stalled network call cannot freeze the
// content script's heartbeat forever. Retries are opt-in: state updates are
// idempotent, while command polling is deliberately never retried because the
// first response may already have claimed a command on the server.
async function api(path, options = {}, reliability = {}) {
  const token = await deviceToken();
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };
  if (token) headers["x-gamepilot-device"] = token;
  const retries = Math.max(0, Math.min(API_RETRY_DELAYS_MS.length, Number(reliability.retries) || 0));
  const timeoutMs = Math.max(1000, Number(reliability.timeoutMs) || API_TIMEOUT_MS);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${API}${path}`, { ...options, headers, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || `API ${response.status}`);
        error.retryable = retryableStatus(response.status);
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error("API demorou demais para responder") : error;
      const mayRetry = attempt < retries && (error?.name === "AbortError" || error?.retryable === true || error instanceof TypeError);
      if (!mayRetry) throw lastError;
      await wait(API_RETRY_DELAYS_MS[attempt]);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
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
  stopSocket();
  void openAgentSocket().catch(() => {});
  return { ...(await pairedDeviceStatus()), version: await extensionVersionStatus() };
}

async function pairedDeviceStatus() {
  const token = await deviceToken();
  if (!token) return { status: "unpaired", environment: environmentView(), account: null, device: null, connections: [] };
  return { ...(await api("/api/v1/extension/device-status", {}, { retries: 1 })), status: "paired", environment: environmentView() };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "focus-game-for-return") {
    if (!Number.isInteger(sender.tab?.id) || !sender.url?.startsWith("https://huntera.com.br/")) return;
    (async () => {
      const tab = await chrome.tabs.get(sender.tab.id);
      if (!tab.url?.startsWith("https://huntera.com.br/")) throw new Error("A aba saiu do Huntera");
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "page-alive") {
    if (!Number.isInteger(sender.tab?.id) || !sender.url?.startsWith("https://huntera.com.br/")) return;
    void updatePageWatch((pages) => {
      const previous = pages[sender.tab.id];
      pages[sender.tab.id] = { lastSeen: Date.now(), lastFocus: previous?.lastFocus || 0 };
    });
    sendResponse({ ok: true });
    return;
  }
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
      try {
        await socketRequest("event", { event, connectionKey: message.connectionKey || null });
      } catch (error) {
        // Falling back is safe only before a frame was sent. Once sent, the
        // server may already have committed it and its acknowledgement was lost.
        if (error.sent) throw error;
        await api("/api/v1/agent/event", { method: "POST", body: JSON.stringify(event) });
      }
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "agent-disconnect") {
    (async () => {
      const disconnect = {
        connectionKey: message.connectionKey || null,
        connectionInstanceId: message.connectionInstanceId || null,
        disconnectedAt: message.disconnectedAt || new Date().toISOString()
      };
      try { await socketRequest("disconnect", disconnect, 5000); }
      catch { await api("/api/v1/agent/disconnect", { method: "POST", body: JSON.stringify(disconnect) }); }
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type !== "page-state") return;

  (async () => {
    const state = { ...message.state, tabId: sender.tab?.id };
    if (state.connectionKey && Number.isInteger(state.tabId)) connectionTabs.set(state.connectionKey, state.tabId);
    let command;
    try {
      command = await socketRequest("state", { state, wantsCommand: message.wantsCommand !== false });
    } catch {
      const stateResult = await api("/api/v1/agent/state", { method: "POST", body: JSON.stringify(state) }, { retries: 2 });
      // HTTP remains a repair path when a proxy or network blocks WebSockets.
      const query = `?connectionKey=${encodeURIComponent(state.connectionKey || "")}${message.wantsCommand === false ? "&interruptOnly=true" : ""}&redeliver=true`;
      command = await api(`/api/v1/agent/commands${query}`);
      if (stateResult.lootConfig) command.lootConfig = stateResult.lootConfig;
    }
    sendResponse({
      ok: true,
      command: command.command,
      commandId: command.commandId,
      payload: command.payload || {},
      lootConfig: command.lootConfig || null
    });
  })().catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
