const API = "http://127.0.0.1:4317";
const TOKEN = "dev-agent-token";

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-gamepilot-agent": TOKEN,
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`API ${response.status}`);
  return response.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "page-state") return;

  (async () => {
    const state = { ...message.state, tabId: sender.tab?.id };
    await api("/api/v1/agent/state", { method: "POST", body: JSON.stringify(state) });
    const command = await api("/api/v1/agent/commands");
    sendResponse({ ok: true, command: command.command });
  })().catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
