let mode = "idle";
let banner;

function showBanner(text) {
  if (!banner) {
    banner = document.createElement("div");
    banner.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;padding:8px 12px;border-radius:8px;background:#172033;color:#d8f3ff;font:12px system-ui;box-shadow:0 4px 16px #0006";
    document.documentElement.appendChild(banner);
  }
  banner.textContent = `GamePilot · ${text}`;
}

function reportCommand(command, commandId, status = "completed", errorMessage = null) {
  if (!commandId) return;
  chrome.runtime.sendMessage({
    type: "agent-event",
    event: {
      type: "command.executed",
      message: `Comando ${command} recebido pela extensão`,
      details: { command, commandId, status, errorMessage }
    }
  });
}

async function handleCommand(command, commandId, payload = {}) {
  if (command === "start-test") {
    mode = "test-running";
    showBanner("comando iniciar recebido");
    reportCommand(command, commandId);
  }
  if (command === "stop-test") {
    mode = "idle";
    showBanner("comando parar recebido");
    reportCommand(command, commandId);
  }
  if (command === "open-store") {
    const adapter = globalThis.GamePilotAdapters?.huntera;
    const result = await adapter?.openStore?.(payload) || { ok: false, error: "Ação abrir loja ainda não mapeada" };
    showBanner(result.ok ? "loja aberta" : result.error);
    reportCommand(command, commandId, result.ok ? "completed" : "failed", result.ok ? null : result.error);
  }
}

function sendState() {
  const adapter = globalThis.GamePilotAdapters?.huntera;
  const gameState = adapter?.readState?.() || { gameKey: "huntera", detected: false, page: location.pathname };
  chrome.runtime.sendMessage({
    type: "page-state",
    state: { url: location.href, title: document.title, mode, gameKey: "huntera", gameState }
  }, (response) => {
    if (chrome.runtime.lastError) return showBanner("extensão conectada; API offline");
    if (!response?.ok) return showBanner("erro de conexão com a API");
    void handleCommand(response.command, response.commandId, response.payload);
    if (!response.command) showBanner(`conectado · ${mode}`);
  });
}

showBanner("extensão carregada");
sendState();
setInterval(sendState, 3000);
