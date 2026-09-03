let mode = "idle";
let banner;
let automationEnabled = false;
let automationConfig = {};
let automationActions = [];
let automationPayload = {};
let automationBusy = false;
let backpackThresholdArmed = true;
let recoveryNoticeSent = false;
const connectionKey = globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function showBanner(text) {
  if (!banner) {
    banner = document.createElement("div");
    banner.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;padding:8px 12px;border-radius:8px;background:#172033;color:#d8f3ff;font:12px system-ui;box-shadow:0 4px 16px #0006";
    document.documentElement.appendChild(banner);
  }
  banner.textContent = `GamePilot · ${text}`;
}

function sendEvent(event) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type: "agent-event", connectionKey, event }, (response) => resolve(response)));
}

async function reportCommand(command, commandId, status = "completed", errorMessage = null) {
  if (!commandId) return;
  await sendEvent({ type: "command.executed", message: `Comando ${command} recebido pela extensão`, details: { command, commandId, status, errorMessage } });
}

function appliedActionRules(rules, configured) {
  const appliedKeys = new Set((configured?.actions || []).map((item) => item.actionKey));
  return (Array.isArray(rules) ? rules : []).filter((rule) => appliedKeys.has(rule.actionKey || rule.action_key));
}

async function handleCommand(command, commandId, payload = {}) {
  if (!command) return;
  const adapter = globalThis.GamePilotAdapters?.huntera;
  let result = { ok: false, error: "Adaptador Huntera não carregado" };
  try {
    if (command === "start" || command === "start-hunt") {
      const nextActions = Array.isArray(payload.actions) ? payload.actions : [];
      automationConfig = payload.hunt || {}; mode = "starting"; showBanner("aplicando ações e iniciando caçada");
      backpackThresholdArmed = true;
      const currentState = adapter?.readState?.();
      const selected = currentState?.characterSelection
        ? await adapter?.selectCharacter?.(payload.characterName || payload.character_name || payload.character?.name) || { ok: false, error: "Não foi possível selecionar o personagem para reconectar" }
        : { ok: true };
      const configured = selected.ok ? await adapter?.configureActions?.(nextActions) || { ok: true, configured: 0 } : selected;
      if (configured.ok) { automationEnabled = true; automationActions = appliedActionRules(nextActions, configured); automationPayload = payload; }
      else automationEnabled = false;
      result = configured.ok ? await adapter?.startHunt?.(payload) || result : configured;
      if (configured.ok && (configured.configured || configured.skipped?.length)) await sendEvent({ type: "actions.configured", message: `${configured.configured || 0} ação(ões) configurada(s)${configured.skipped?.length ? `; ${configured.skipped.length} indisponível(is) ignorada(s)` : ""}`, details: { configured: configured.configured || 0, skipped: configured.skipped || [], actions: automationActions } });
      if (result.ok) { mode = "hunting"; recoveryNoticeSent = false; await sendEvent({ type: "hunt.started", message: result.alreadyStarted ? "Caçada já estava em andamento" : payload.resume ? "Caçada retomada após reconexão" : "Caçada iniciada", details: { payload, reconnected: Boolean(payload.resume) } }); }
    } else if (command === "configure-actions") {
      const nextActions = Array.isArray(payload.actions) ? payload.actions : [];
      showBanner("atualizando ações do personagem");
      const configured = await adapter?.configureActions?.(nextActions) || { ok: true, configured: 0 };
      if (configured.ok) { automationActions = appliedActionRules(nextActions, configured); automationPayload = { ...automationPayload, ...payload, actions: automationActions }; }
      result = configured;
      if (configured.ok) await sendEvent({ type: "actions.configured", message: `${configured.configured || 0} ação(ões) atualizada(s)${configured.skipped?.length ? `; ${configured.skipped.length} indisponível(is) ignorada(s)` : ""}`, details: { configured: configured.configured || 0, skipped: configured.skipped || [], actions: automationActions, live: true } });
    } else if (command === "stop" || command === "return-town") {
      automationEnabled = false; automationActions = []; automationPayload = {}; backpackThresholdArmed = true; mode = "returning"; showBanner(command === "stop" ? "parando operação" : "retornando para a cidade"); result = await adapter?.leaveHunt?.(payload) || result;
      if (result.ok) { mode = command === "stop" ? "idle" : "returning"; await sendEvent({ type: "hunt.returned", message: result.alreadyOut ? "Personagem já estava fora da caçada" : "Personagem retornou para a cidade", details: { payload, command } }); }
    } else if (command === "open-store") {
      mode = "selling"; showBanner("abrindo loja"); result = await adapter?.openStore?.({ ...payload, autoLeave: true }) || result;
      if (result.ok) await sendEvent({ type: "shop.opened", message: result.alreadyOpen ? "Loja já estava aberta" : "Loja aberta pela extensão", details: { payload } });
    } else if (command === "sell-items") {
      mode = "selling"; showBanner("consultando o leilão e preparando a venda"); result = await adapter?.sellItems?.(payload.hunt || automationConfig) || result;
      if (result.ok) await sendEvent({ type: "items.sold", message: result.message || `Venda concluída: ${result.sold || 0} ação(ões)`, details: { ...result, payload } });
    } else if (command === "sync-bestiary") {
      const previousMode = mode;
      mode = "syncing";
      showBanner("lendo o progresso do Bestiary");
      const synced = await adapter?.syncBestiary?.() || { ok: false, error: "Adaptador Huntera não carregou" };
      if (!synced.ok) throw new Error(synced.error || "Não foi possível sincronizar o Bestiary");
      const eventResponse = await sendEvent({
        type: "bestiary.synced",
        message: `${synced.entries.length} entrada(s) do Bestiary sincronizada(s)`,
        details: {
          command, commandId, status: "completed", characterId: payload.characterId || null,
          entries: synced.entries, pages: synced.pages, source: synced.source, gameState: adapter.readState()
        }
      });
      if (eventResponse?.ok === false) throw new Error(eventResponse.error || "A API recusou a sincronização do Bestiary");
      result = synced;
      mode = previousMode;
    } else if (command === "bestiary-next") {
      const previousHunt = automationConfig;
      const nextActions = Array.isArray(payload.actions) ? payload.actions : [];
      automationEnabled = false;
      automationBusy = true;
      try {
        mode = "returning"; showBanner("bestiário concluído; retornando para avançar");
        const returned = await adapter?.leaveHunt?.() || { ok: false, error: "Adaptador Huntera não carregou" };
        if (!returned.ok) throw new Error(returned.error || "Não foi possível sair da caçada concluída");
        await sendEvent({ type: "hunt.returned", message: "Retornou para avançar no bestiário", details: { automatic: true, bestiary: payload.bestiary || null } });
        mode = "selling";
        const opened = await adapter?.openStore?.({ autoLeave: false });
        if (!opened?.ok) throw new Error(opened?.error || "Não foi possível abrir a loja para o bestiário");
        await sendEvent({ type: "shop.opened", message: "Loja aberta para o avanço do bestiário", details: { automatic: true } });
        const sold = await adapter?.sellItems?.(previousHunt) || { ok: false, error: "Não foi possível vender o loot" };
        if (!sold.ok) throw new Error(sold.error || "Não foi possível vender o loot");
        await sendEvent({ type: "items.sold", message: sold.message || `Loot vendido antes do próximo monstro`, details: { ...sold, automatic: true } });
        await adapter?.closeStore?.();
        automationConfig = payload.hunt || {};
        automationActions = nextActions;
        automationPayload = payload;
        backpackThresholdArmed = true;
        mode = "starting";
        const configured = await adapter?.configureActions?.(nextActions) || { ok: true, configured: 0 };
        if (!configured.ok) throw new Error(configured.error || "Não foi possível reaplicar as ações do personagem");
        automationActions = appliedActionRules(nextActions, configured);
        const started = await adapter?.startHunt?.(payload);
        if (!started?.ok) throw new Error(started?.error || "Não foi possível iniciar o próximo monstro");
        automationEnabled = true;
        mode = "hunting";
        await sendEvent({ type: "hunt.started", message: `Próximo monstro do bestiário iniciado`, details: { automatic: true, bestiary: payload.bestiary || null } });
        result = { ok: true, started, bestiary: payload.bestiary || null };
      } finally {
        automationBusy = false;
      }
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
  const backpack = gameState?.backpack?.percent;
  const threshold = Number(automationConfig.backpackReturnPercent || 85);
  if (backpack == null) return false;
  if (backpack < threshold) backpackThresholdArmed = true;
  return backpackThresholdArmed && backpack >= threshold;
}

async function runAutomationCycle(gameState) {
  if (!automationEnabled || automationBusy || !gameState?.inHunt || !thresholdReached(gameState)) return;
  automationBusy = true;
  backpackThresholdArmed = false;
  const adapter = globalThis.GamePilotAdapters?.huntera;
  try {
    mode = "returning"; showBanner("limite atingido; retornando");
    const returned = await adapter?.leaveHunt?.();
    if (!returned?.ok) throw new Error(returned?.error || "Não foi possível sair da caçada");
    await sendEvent({ type: "hunt.returned", message: "Limite atingido; personagem retornou para vender", details: { reason: "threshold", gameState } });
    mode = "selling"; const opened = await adapter?.openStore?.({ autoLeave: false });
    if (!opened?.ok) throw new Error(opened?.error || "Não foi possível abrir a loja");
    await sendEvent({ type: "shop.opened", message: "Loja aberta para o ciclo automático", details: { automatic: true } });
    const sold = await adapter?.sellItems?.(automationConfig);
    if (!sold?.ok) throw new Error(sold?.error || "Não foi possível vender os itens");
    await sendEvent({ type: "items.sold", message: sold.message || `Ciclo vendeu ${sold.sold || 0} ação(ões)`, details: { ...sold, automatic: true } });
    await adapter?.closeStore?.();
    if (!automationEnabled) return;
    mode = "starting";
    const configured = await adapter?.configureActions?.(automationActions) || { ok: true, configured: 0 };
    if (!configured.ok) throw new Error(configured.error || "Não foi possível reaplicar as ações do personagem");
    const started = await adapter?.startHunt?.(automationPayload);
    if (!started?.ok) throw new Error(started?.error || "Não foi possível retomar a caçada");
    mode = "hunting";
    await sendEvent({ type: "hunt.started", message: "Caçada retomada automaticamente", details: { automatic: true } });
  } catch (error) {
    if (adapter?.readState?.().inHunt) backpackThresholdArmed = true;
    mode = "error"; await sendEvent({ type: "automation.error", message: error.message, details: { status: "failed", errorMessage: error.message, automatic: true } });
  } finally {
    automationBusy = false;
  }
}

function sendState() {
  const adapter = globalThis.GamePilotAdapters?.huntera;
  const gameState = adapter?.readState?.() || { gameKey: "huntera", detected: false, page: location.pathname };
  if (gameState.characterSelection && automationEnabled) {
    if (!recoveryNoticeSent) {
      recoveryNoticeSent = true;
      mode = "reconnecting";
      showBanner("conexão perdida; selecionando personagem");
      void sendEvent({ type: "connection.lost", message: "Huntera voltou para a tela de personagens", details: { character: automationPayload.characterName || automationPayload.character?.name || null } });
    }
  } else if (gameState.detected && recoveryNoticeSent) {
    recoveryNoticeSent = false;
    void sendEvent({ type: "connection.restored", message: "Personagem carregado novamente no Huntera", details: { character: gameState.character?.name || null } });
  }
  void runAutomationCycle(gameState);
  const reportedGameState = { ...gameState, gamepilot: { automationEnabled, hunt: automationConfig, bestiary: automationPayload.bestiary || null } };
  chrome.runtime.sendMessage({ type: "page-state", state: { url: location.href, title: document.title, observedAt: new Date().toISOString(), mode, gameKey: "huntera", connectionKey, gameState: reportedGameState } }, (response) => {
    if (chrome.runtime.lastError) return showBanner("extensão conectada; API offline");
    if (!response?.ok) return showBanner("erro de conexão com a API");
    void handleCommand(response.command, response.commandId, response.payload);
    if (!response.command) showBanner(`conectado · ${mode}`);
  });
}

showBanner("extensão carregada");
sendState();
setInterval(sendState, 3000);
