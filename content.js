let mode = "idle";
let banner;
let automationEnabled = false;
let automationConfig = {};
let automationBusy = false;

function showBanner(text) {
  if (!banner) {
    banner = document.createElement("div");
    banner.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;padding:8px 12px;border-radius:8px;background:#172033;color:#d8f3ff;font:12px system-ui;box-shadow:0 4px 16px #0006";
    document.documentElement.appendChild(banner);
  }
  banner.textContent = `GamePilot · ${text}`;
}

function sendEvent(event) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type: "agent-event", event }, (response) => resolve(response)));
}

async function reportCommand(command, commandId, status = "completed", errorMessage = null) {
  if (!commandId) return;
  await sendEvent({ type: "command.executed", message: `Comando ${command} recebido pela extensão`, details: { command, commandId, status, errorMessage } });
}

async function handleCommand(command, commandId, payload = {}) {
  if (!command) return;
  const adapter = globalThis.GamePilotAdapters?.huntera;
  let result = { ok: false, error: "Adaptador Huntera não carregado" };
  try {
    if (command === "start" || command === "start-hunt") {
      automationEnabled = true; automationConfig = payload.hunt || {}; mode = "starting"; showBanner("iniciando caçada"); result = await adapter?.startHunt?.(payload) || result;
      if (result.ok) { mode = "hunting"; await sendEvent({ type: "hunt.started", message: result.alreadyStarted ? "Caçada já estava em andamento" : "Caçada iniciada", details: { payload } }); }
    } else if (command === "stop" || command === "return-town") {
      automationEnabled = false; mode = "returning"; showBanner(command === "stop" ? "parando operação" : "retornando para a cidade"); result = await adapter?.leaveHunt?.(payload) || result;
      if (result.ok) { mode = command === "stop" ? "idle" : "returning"; await sendEvent({ type: "hunt.returned", message: result.alreadyOut ? "Personagem já estava fora da caçada" : "Personagem retornou para a cidade", details: { payload } }); }
    } else if (command === "open-store") {
      mode = "selling"; showBanner("abrindo loja"); result = await adapter?.openStore?.({ ...payload, autoLeave: true }) || result;
      if (result.ok) await sendEvent({ type: "shop.opened", message: result.alreadyOpen ? "Loja já estava aberta" : "Loja aberta pela extensão", details: { payload } });
    } else if (command === "sell-items") {
      mode = "selling"; showBanner("vendendo itens comuns"); result = await adapter?.sellItems?.(payload) || result;
      if (result.ok) await sendEvent({ type: "items.sold", message: result.message || `Venda concluída: ${result.sold || 0} ação(ões)`, details: { ...result, payload } });
    } else if (command === "read-state") {
      result = { ok: true };
    } else {
      result = { ok: false, error: `Comando ${command} não suportado` };
    }
  } catch (error) {
    result = { ok: false, error: error.message || "Falha inesperada" };
  }
  if (!result.ok) { mode = "error"; await sendEvent({ type: "automation.error", message: result.error, details: { command, commandId, status: "failed", errorMessage: result.error } }); }
  else if (command === "stop") mode = "idle";
  showBanner(result.ok ? `${command} concluído` : result.error);
  await reportCommand(command, commandId, result.ok ? "completed" : "failed", result.ok ? null : result.error);
}

function thresholdReached(gameState) {
  const health = gameState?.resources?.health?.percent;
  const mana = gameState?.resources?.mana?.percent;
  const backpack = gameState?.backpack?.percent;
  return (health != null && health <= Number(automationConfig.minHealthPercent || 35))
    || (mana != null && mana <= Number(automationConfig.minManaPercent || 20))
    || (backpack != null && backpack >= Number(automationConfig.backpackReturnPercent || 85));
}

async function runAutomationCycle(gameState) {
  if (!automationEnabled || automationBusy || !gameState?.inHunt || !thresholdReached(gameState)) return;
  automationBusy = true;
  const adapter = globalThis.GamePilotAdapters?.huntera;
  try {
    mode = "returning"; showBanner("limite atingido; retornando");
    const returned = await adapter?.leaveHunt?.();
    if (!returned?.ok) throw new Error(returned?.error || "Não foi possível sair da caçada");
    await sendEvent({ type: "hunt.returned", message: "Limite atingido; personagem retornou para vender", details: { reason: "threshold", gameState } });
    mode = "selling"; const opened = await adapter?.openStore?.({ autoLeave: false });
    if (!opened?.ok) throw new Error(opened?.error || "Não foi possível abrir a loja");
    await sendEvent({ type: "shop.opened", message: "Loja aberta para o ciclo automático", details: { automatic: true } });
    const sold = await adapter?.sellItems?.();
    if (!sold?.ok) throw new Error(sold?.error || "Não foi possível vender os itens");
    await sendEvent({ type: "items.sold", message: sold.message || `Ciclo vendeu ${sold.sold || 0} ação(ões)`, details: { ...sold, automatic: true } });
    await adapter?.closeStore?.();
    if (!automationEnabled) return;
    mode = "starting"; const started = await adapter?.startHunt?.();
    if (!started?.ok) throw new Error(started?.error || "Não foi possível retomar a caçada");
    mode = "hunting";
    await sendEvent({ type: "hunt.started", message: "Caçada retomada automaticamente", details: { automatic: true } });
  } catch (error) {
    mode = "error"; await sendEvent({ type: "automation.error", message: error.message, details: { status: "failed", errorMessage: error.message, automatic: true } });
  } finally {
    automationBusy = false;
  }
}

function sendState() {
  const adapter = globalThis.GamePilotAdapters?.huntera;
  const gameState = adapter?.readState?.() || { gameKey: "huntera", detected: false, page: location.pathname };
  void runAutomationCycle(gameState);
  chrome.runtime.sendMessage({ type: "page-state", state: { url: location.href, title: document.title, mode, gameKey: "huntera", gameState } }, (response) => {
    if (chrome.runtime.lastError) return showBanner("extensão conectada; API offline");
    if (!response?.ok) return showBanner("erro de conexão com a API");
    void handleCommand(response.command, response.commandId, response.payload);
    if (!response.command) showBanner(`conectado · ${mode}`);
  });
}

showBanner("extensão carregada");
sendState();
setInterval(sendState, 3000);
