let mode = "idle";
let banner;
let automationEnabled = false;
let automationConfig = {};
let automationActions = [];
let automationPayload = {};
let automationBusy = false;
let commandBusy = false;
let activeCommand = Promise.resolve();
let interrupting = false;
let stateRequestPending = false;
let runtimeMessagingAvailable = true;
let stateIntervalId = null;
let lastOperationError = null;
let lastReturnAt = 0;
let lastTrainingAttemptAt = 0;
let arrowSwitchBusy = false;
let arrowSwitchTimer = null;
let lastArrowSwitchAttemptAt = 0;
const RETURN_COOLDOWN_MS = 30000; // min gap between auto-return attempts
const TRAINING_RETRY_MS = 30000;
const ARROW_SWITCH_RETRY_MS = 1000;
const RECOVERY_CONFIRM_MS = 5000;
let recoveryNoticeSent = false;
let characterSelectionSince = 0;
let hunteraPageTitle = document.title;
let characterPageTitle = null;

function updateCharacterPageTitle(characterName) {
  const name = String(characterName || "").trim();
  const nextTitle = name ? `${name} — Huntera` : null;
  if (nextTitle) {
    characterPageTitle = nextTitle;
    if (document.title !== nextTitle) document.title = nextTitle;
    return;
  }
  if (characterPageTitle && document.title === characterPageTitle) document.title = hunteraPageTitle;
  characterPageTitle = null;
}

// Huntera is a SPA and may rewrite <title> after navigation. Remember its most
// recent native title, then immediately restore the character label while the
// character remains selected.
new MutationObserver(() => {
  if (!characterPageTitle) {
    hunteraPageTitle = document.title;
    return;
  }
  if (document.title !== characterPageTitle) {
    hunteraPageTitle = document.title;
    document.title = characterPageTitle;
  }
}).observe(document.head, { childList: true, subtree: true, characterData: true });

// A stable per-tab connection key. Reloads in the same tab must reuse the same
// key so the API updates a single agent_connections row instead of leaving a
// new "connected" ghost behind on every reload. sessionStorage is scoped to the
// tab and survives reloads but not a fresh tab, which is exactly the lifetime we
// want. A closed tab's row is reaped server-side by its stale last_seen_at.
function stableConnectionKey() {
  const fresh = () => globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const existing = sessionStorage.getItem("gamepilot.connectionKey");
    if (existing) return existing;
    const created = fresh();
    sessionStorage.setItem("gamepilot.connectionKey", created);
    return created;
  } catch {
    return fresh();
  }
}
const connectionKey = stableConnectionKey();

// Persist the automation state per tab so an extension reload or an F5 mid-hunt
// doesn't silently disable the auto-return. sessionStorage is tab-scoped and
// survives a page reload, so the restored state keeps the ongoing hunt managed
// (auto-return, potion cycle) without needing a manual Stop+Start. Synced on
// every state post; restored once on load, before the first post.
const AUTOMATION_KEY = "gamepilot.automation";
function persistAutomationState() {
  try {
    sessionStorage.setItem(AUTOMATION_KEY, JSON.stringify({ automationEnabled, automationConfig, automationActions, automationPayload, mode, lastOperationError }));
  } catch { /* storage unavailable */ }
}
function restoreAutomationState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(AUTOMATION_KEY) || "null");
    if (!saved || typeof saved !== "object") return;
    automationEnabled = Boolean(saved.automationEnabled);
    automationConfig = saved.automationConfig && typeof saved.automationConfig === "object" ? saved.automationConfig : {};
    automationActions = Array.isArray(saved.automationActions) ? saved.automationActions : [];
    automationPayload = saved.automationPayload && typeof saved.automationPayload === "object" ? saved.automationPayload : {};
    if (saved.mode) mode = saved.mode;
    lastOperationError = saved.lastOperationError || null;
  } catch { /* ignore corrupt state */ }
}

function showBanner(text) {
  if (!banner) {
    banner = document.createElement("div");
    banner.setAttribute("data-gamepilot-banner", "");
    banner.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;padding:8px 12px;border-radius:8px;background:#172033;color:#d8f3ff;font:12px system-ui;box-shadow:0 4px 16px #0006";
    document.documentElement.appendChild(banner);
  }
  banner.textContent = `GamePilot · ${text}`;
}

function isInvalidatedExtensionContext(error) {
  return /extension context invalidated/i.test(error?.message || "");
}

function stopRuntimeMessaging() {
  runtimeMessagingAvailable = false;
  stateRequestPending = false;
  if (stateIntervalId !== null) {
    clearInterval(stateIntervalId);
    stateIntervalId = null;
  }
}

// Reloading an unpacked extension invalidates the old content-script context
// before Chrome reloads the game tab. In that short window sendMessage throws
// synchronously, so checking runtime.lastError only inside the callback is not
// enough. Centralize the guard so stale timers and socket events become no-ops.
function sendRuntimeMessage(message, callback) {
  if (!runtimeMessagingAvailable) return false;
  try {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (isInvalidatedExtensionContext(error)) stopRuntimeMessaging();
      callback?.(response, error || null);
    });
    return true;
  } catch (error) {
    if (isInvalidatedExtensionContext(error)) stopRuntimeMessaging();
    callback?.(undefined, error);
    return false;
  }
}

function sendEvent(event) {
  return new Promise((resolve) => {
    const sent = sendRuntimeMessage(
      { type: "agent-event", connectionKey, event },
      (response, error) => resolve(response || { ok: false, error: error?.message || "Extensão indisponível" })
    );
    if (!sent) resolve({ ok: false, error: "Extensão indisponível" });
  });
}

async function reportCommand(command, commandId, status = "completed", errorMessage = null) {
  if (!commandId) return;
  await sendEvent({ type: "command.executed", message: `Comando ${command} recebido pela extensão`, details: { command, commandId, status, errorMessage } });
}

function appliedActionRules(rules, configured) {
  const appliedKeys = new Set((configured?.actions || []).map((item) => item.actionKey));
  return (Array.isArray(rules) ? rules : []).filter((rule) => appliedKeys.has(rule.actionKey || rule.action_key));
}

async function sellAndCloseStore(adapter, loot = {}) {
  let result;
  try {
    result = await adapter?.sellItems?.(loot) || { ok: false, error: "Adaptador Huntera não carregado" };
  } catch (error) {
    result = { ok: false, error: error.message || "Não foi possível destinar o loot" };
  }
  try {
    const closed = await adapter?.closeStore?.();
    if (closed?.ok === false && result.ok) return { ...result, ok: false, error: closed.error || "Não foi possível fechar a loja" };
  } catch (error) {
    if (result.ok) return { ...result, ok: false, error: error.message || "Não foi possível fechar a loja" };
  }
  return result;
}

async function handleCommand(command, commandId, payload = {}) {
  if (!command) return;
  const adapter = globalThis.GamePilotAdapters?.huntera;
  let result = { ok: false, error: "Adaptador Huntera não carregado" };
  try {
    if (command === "prepare-group") {
      automationEnabled = false;
      mode = "preparing";
      showBanner(payload.group?.role === "leader" ? "criando party e enviando convites" : "aguardando convite da party");
      result = await adapter?.prepareGroup?.(payload) || result;
      if (result.ok) {
        mode = "idle";
        await sendEvent({ type: payload.group?.phase === "initialize" ? "group.initialized" : "group.party-ready", message: payload.group?.phase === "initialize" ? "Personagem disponível para preparar a party" : "Party preparada no Huntera", details: { payload, party: result.party } });
      }
    } else if (command === "start" && payload.operation === "training") {
      automationEnabled = false;
      automationPayload = { ...automationPayload, ...payload };
      mode = "starting";
      showBanner("iniciando Online Training");
      result = await adapter?.startTraining?.(payload) || result;
      if (result.ok) {
        mode = "training";
        await sendEvent({ type: "training.started", message: result.alreadyTraining ? "Treino online já estava ativo" : "Treino online iniciado", details: { payload, skill: result.skill, mode: "online" } });
      }
    } else if ((command === "start" || command === "start-hunt") && payload.operation === "group-hunt") {
      const nextActions = Array.isArray(payload.actions) ? payload.actions : [];
      automationConfig = payload.hunt || {}; automationPayload = payload; mode = "starting"; showBanner(payload.group?.role === "leader" ? "iniciando caçada com o time" : "aguardando convite da caçada em grupo");
      lastReturnAt = 0;
      const currentState = adapter?.readState?.();
      const selected = currentState?.characterSelection
        ? await adapter?.selectCharacter?.(payload.characterName || payload.character_name || payload.character?.name) || { ok: false, error: "Não foi possível selecionar o personagem para reconectar" }
        : { ok: true };
      const configured = selected.ok ? await adapter?.configureActions?.(nextActions) || { ok: true, configured: 0 } : selected;
      if (configured.ok) { automationEnabled = true; automationActions = appliedActionRules(nextActions, configured); automationPayload = payload; }
      else automationEnabled = false;
      result = configured.ok
        ? payload.group?.role === "leader"
          ? await adapter?.startGroupHunt?.(payload) || result
          : await adapter?.acceptGroupHunt?.(payload) || result
        : configured;
      if (configured.ok && (configured.configured || configured.skipped?.length)) await sendEvent({ type: "actions.configured", message: `${configured.configured || 0} ação(ões) configurada(s)${configured.skipped?.length ? `; ${configured.skipped.length} indisponível(is) ignorada(s)` : ""}`, details: { configured: configured.configured || 0, skipped: configured.skipped || [], actions: automationActions } });
      if (result.ok) { mode = "hunting"; recoveryNoticeSent = false; await sendEvent({ type: "group.hunt-started", message: "Caçada com o time iniciada", details: { payload, team: true } }); }
    } else if (command === "start" || command === "start-hunt") {
      const nextActions = Array.isArray(payload.actions) ? payload.actions : [];
      automationConfig = payload.hunt || {}; automationPayload = payload; mode = "starting"; showBanner("aplicando ações e iniciando caçada");
      lastReturnAt = 0;
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
    } else if (command === "configure-loot") {
      showBanner("sincronizando gestão de loot da conta");
      result = await adapter?.configureAccountLoot?.(payload.loot || {}) || result;
      if (result.ok) {
        automationPayload = { ...automationPayload, loot: payload.loot || {} };
        await sendEvent({ type: "loot.configured", message: "Gestão de loot sincronizada nesta aba", details: { ...result, source: payload.source || "command" } });
      }
    } else if (command === "configure-actions") {
      const nextActions = Array.isArray(payload.actions) ? payload.actions : [];
      showBanner("atualizando ações do personagem");
      const configured = await adapter?.configureActions?.(nextActions) || { ok: true, configured: 0 };
      if (configured.ok) { automationActions = appliedActionRules(nextActions, configured); automationPayload = { ...automationPayload, ...payload, actions: automationActions }; }
      result = configured;
      if (configured.ok) await sendEvent({ type: "actions.configured", message: `${configured.configured || 0} ação(ões) atualizada(s)${configured.skipped?.length ? `; ${configured.skipped.length} indisponível(is) ignorada(s)` : ""}`, details: { configured: configured.configured || 0, skipped: configured.skipped || [], actions: automationActions, live: true } });
    } else if (command === "stop" && payload.operation === "training") {
      mode = "returning";
      showBanner("parando Online Training");
      result = await adapter?.stopTraining?.() || result;
      if (result.ok) {
        mode = "idle";
        await sendEvent({ type: "training.stopped", message: result.alreadyStopped ? "Treino já estava parado" : "Treino online encerrado", details: { payload } });
      }
    } else if (command === "stop" || command === "return-town") {
      if (adapter?.readState?.().training?.active) {
        const stopped = await adapter.stopTraining();
        if (!stopped.ok) throw new Error(stopped.error);
      }
      automationEnabled = false; automationActions = []; automationPayload = {}; lastReturnAt = 0; mode = "returning"; showBanner(command === "stop" ? "parando operação" : "retornando para a cidade"); result = await adapter?.leaveHunt?.(payload) || result;
      if (result.ok) { mode = command === "stop" ? "idle" : "returning"; await sendEvent({ type: "hunt.returned", message: result.alreadyOut ? "Personagem já estava fora da caçada" : "Personagem retornou para a cidade", details: { payload, command } }); }
    } else if (command === "open-store") {
      mode = "selling"; showBanner("abrindo loja"); result = await adapter?.openStore?.({ ...payload, autoLeave: true }) || result;
      if (result.ok) await sendEvent({ type: "shop.opened", message: result.alreadyOpen ? "Loja já estava aberta" : "Loja aberta pela extensão", details: { payload } });
    } else if (command === "sell-items") {
      mode = "selling"; showBanner("destinando o loot conforme a política da conta"); result = await sellAndCloseStore(adapter, payload.loot || automationPayload?.loot || {});
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
      if (synced.closeAfterSync) {
        const closed = await adapter?.closeBestiary?.();
        if (closed?.ok === false) throw new Error(closed.error || "Não foi possível fechar o Bestiary após sincronizar");
      }
      result = synced;
      mode = previousMode;
    } else if (command === "bestiary-next") {
      const previousHunt = automationConfig;
      const nextActions = Array.isArray(payload.actions) ? payload.actions : [];
      automationEnabled = false;
      // Keep the next bestiary target visible while the character returns and
      // sells. Without this, live reports describe only a generic operation
      // until the next hunt has already started.
      automationPayload = payload;
      automationConfig = payload.hunt || previousHunt || {};
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
        const sold = await sellAndCloseStore(adapter, payload.loot || automationPayload?.loot || {});
        if (!sold.ok) throw new Error(sold.error || "Não foi possível vender o loot");
        await sendEvent({ type: "items.sold", message: sold.message || `Loot vendido antes do próximo monstro`, details: { ...sold, automatic: true } });
        automationActions = nextActions;
        lastReturnAt = 0;
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
  if (!result.ok) { lastOperationError = { command, message: result.error, at: new Date().toISOString() }; mode = "error"; await sendEvent({ type: "automation.error", message: result.error, details: { command, commandId, status: "failed", errorMessage: result.error } }); }
  else if (command === "stop") mode = "idle";
  else if (mode === "error") mode = adapter?.readState?.().inHunt ? "hunting" : "idle"; // a later success clears a stale error banner
  showBanner(result.ok ? `${command} concluído` : result.error);
  await reportCommand(command, commandId, result.ok ? "completed" : "failed", result.ok ? null : result.error);
}

function thresholdReached(gameState) {
  const backpack = gameState?.backpack?.percent;
  const threshold = Number(automationConfig.backpackReturnPercent || 85);
  if (backpack == null || backpack < threshold) return false;
  // At/above the threshold, return — unless we tried recently. This cooldown
  // replaces the old "armed" boolean, which stuck forever when a sale failed and
  // the backpack never dropped back below the threshold to re-arm, silently
  // disabling all further returns.
  return Date.now() - lastReturnAt >= RETURN_COOLDOWN_MS;
}

function arrowSwitchSettings(config = {}) {
  const source = config.arrowSwitching && typeof config.arrowSwitching === "object"
    ? config.arrowSwitching
    : config.settings?.arrowSwitching;
  if (!source || source.enabled !== true) return null;
  const singleTargetArrowId = Number(source.singleTargetArrowId);
  const multiTargetArrowId = Number(source.multiTargetArrowId);
  if (!Number.isInteger(singleTargetArrowId) || singleTargetArrowId <= 0 || !Number.isInteger(multiTargetArrowId) || multiTargetArrowId <= 0) return null;
  return {
    enabled: true,
    singleTargetArrowId,
    multiTargetArrowId,
    multiTargetMinCreatures: Math.max(1, Math.min(20, Number(source.multiTargetMinCreatures) || 2))
  };
}

async function runArrowSwitchCycle(gameState) {
  const settings = arrowSwitchSettings(automationConfig);
  const creatureCount = Number(gameState?.creaturesOnScreen?.count);
  if (!automationEnabled || !settings || arrowSwitchBusy || commandBusy || automationBusy || !gameState?.inHunt) return;
  if (gameState?.socket?.fresh !== true || gameState?.ammunition?.kind !== "arrow" || !Number.isFinite(creatureCount)) return;
  const desiredItemId = creatureCount >= settings.multiTargetMinCreatures ? settings.multiTargetArrowId : settings.singleTargetArrowId;
  if (Number(gameState?.ammunition?.arrow) === desiredItemId || Date.now() - lastArrowSwitchAttemptAt < ARROW_SWITCH_RETRY_MS) return;
  arrowSwitchBusy = true;
  lastArrowSwitchAttemptAt = Date.now();
  const adapter = globalThis.GamePilotAdapters?.huntera;
  try {
    const switched = await adapter?.selectAmmo?.(desiredItemId, "arrow");
    if (!switched?.ok) throw new Error(switched?.error || "Não foi possível trocar a flecha");
    await sendEvent({
      type: "ammo.switched",
      message: `Flecha ajustada para ${creatureCount} criatura(s) na tela`,
      details: { creatureCount, itemId: desiredItemId, threshold: settings.multiTargetMinCreatures }
    });
  } catch (error) {
    await sendEvent({ type: "ammo.switch-failed", message: error.message, details: { creatureCount, itemId: desiredItemId } });
  } finally {
    arrowSwitchBusy = false;
  }
}

function scheduleArrowSwitchCycle() {
  if (arrowSwitchTimer !== null) clearTimeout(arrowSwitchTimer);
  arrowSwitchTimer = setTimeout(() => {
    arrowSwitchTimer = null;
    const gameState = globalThis.GamePilotAdapters?.huntera?.readState?.();
    void runArrowSwitchCycle(gameState);
  }, 180);
}

async function runAutomationCycle(gameState) {
  if (!automationEnabled || automationBusy || commandBusy || !gameState?.inHunt || !thresholdReached(gameState)) return;
  automationBusy = true;
  lastReturnAt = Date.now();
  const adapter = globalThis.GamePilotAdapters?.huntera;
  try {
    mode = "returning"; showBanner("limite atingido; retornando");
    const returned = await adapter?.leaveHunt?.();
    if (!returned?.ok) throw new Error(returned?.error || "Não foi possível sair da caçada");
    await sendEvent({ type: "hunt.returned", message: "Limite atingido; personagem retornou para vender", details: { reason: "threshold", gameState } });
    mode = "selling"; const opened = await adapter?.openStore?.({ autoLeave: false });
    if (!opened?.ok) throw new Error(opened?.error || "Não foi possível abrir a loja");
    await sendEvent({ type: "shop.opened", message: "Loja aberta para o ciclo automático", details: { automatic: true } });
    const sold = await sellAndCloseStore(adapter, automationPayload?.loot || {});
    if (!sold?.ok) throw new Error(sold?.error || "Não foi possível vender os itens");
    await sendEvent({ type: "items.sold", message: sold.message || `Ciclo vendeu ${sold.sold || 0} ação(ões)`, details: { ...sold, automatic: true } });
    if (!automationEnabled) return;
    if (automationPayload?.operation === "group-hunt") {
      automationEnabled = false;
      mode = "idle";
      await sendEvent({ type: "group.member-returned", message: "Personagem voltou e vendeu; aguardando o grupo antes de retomar", details: { automatic: true, group: automationPayload.group || null } });
      return;
    }
    mode = "starting";
    const configured = await adapter?.configureActions?.(automationActions) || { ok: true, configured: 0 };
    if (!configured.ok) throw new Error(configured.error || "Não foi possível reaplicar as ações do personagem");
    const started = await adapter?.startHunt?.(automationPayload);
    if (!started?.ok) throw new Error(started?.error || "Não foi possível retomar a caçada");
    mode = "hunting";
    await sendEvent({ type: "hunt.started", message: "Caçada retomada automaticamente", details: { automatic: true } });
  } catch (error) {
    mode = "error"; await sendEvent({ type: "automation.error", message: error.message, details: { status: "failed", errorMessage: error.message, automatic: true } });
  } finally {
    automationBusy = false;
  }
}

async function runAutoTrainingCycle(gameState) {
  const training = automationPayload?.training;
  const staminaMs = Number(gameState?.staminaMs);
  if (!automationEnabled || automationBusy || commandBusy || !training?.autoWhenStaminaEmpty) return;
  if (!Number.isFinite(staminaMs) || staminaMs > 0 || gameState?.inHunt || !gameState?.inTown || gameState?.training?.active) return;
  if (Date.now() - lastTrainingAttemptAt < TRAINING_RETRY_MS) return;
  lastTrainingAttemptAt = Date.now();
  automationBusy = true;
  const adapter = globalThis.GamePilotAdapters?.huntera;
  try {
    mode = "starting";
    showBanner("stamina encerrada; iniciando Online Training");
    const started = await adapter?.startTraining?.({ training, characterName: gameState?.character?.name });
    if (!started?.ok) throw new Error(started?.error || "Não foi possível iniciar o Online Training");
    automationEnabled = false;
    mode = "training";
    await sendEvent({ type: "training.started", message: "Stamina encerrada; Online Training iniciado automaticamente", details: { automatic: true, skill: started.skill, mode: "online" } });
  } catch (error) {
    mode = "error";
    await sendEvent({ type: "automation.error", message: error.message, details: { automatic: true, operation: "training", status: "failed", errorMessage: error.message } });
  } finally {
    automationBusy = false;
    persistAutomationState();
  }
}

let lastStatePostAt = 0;

function operationReport(gameState) {
  const bestiary = automationPayload?.bestiary?.enabled ? automationPayload.bestiary : null;
  const group = automationPayload?.operation === "group-hunt" ? automationPayload.group || {} : null;
  const training = gameState?.training?.active || automationPayload?.operation === "training";
  const activeMode = gameState?.shopOpen ? "selling"
    : gameState?.training?.active ? "training"
      : mode === "reconnecting" ? "reconnecting"
        : mode === "returning" ? "returning"
          : mode === "selling" ? "selling"
            : mode === "starting" ? "starting"
              : gameState?.inHunt ? "hunting"
                : mode;
  const type = bestiary ? "bestiary"
    : group ? "group-hunt"
      : training ? "training"
        : automationEnabled || ["starting", "hunting", "returning", "selling", "reconnecting"].includes(activeMode) ? "hunt"
          : null;
  if (!type) return null;
  const liveBestiary = gameState?.bestiaryLive;
  const sameBestiaryTarget = bestiary && liveBestiary?.monsterKey === bestiary.monsterKey;
  return {
    type,
    phase: activeMode,
    hunt: automationConfig || null,
    bestiary: bestiary ? {
      ...bestiary,
      ...(sameBestiaryTarget && liveBestiary?.killCount != null ? { killCount: liveBestiary.killCount } : {})
    } : null,
    group: group ? { id: group.id || null, name: group.name || null, role: group.role || null } : null
  };
}

function sendState() {
  if (!runtimeMessagingAvailable) return;
  lastStatePostAt = Date.now();
  persistAutomationState();
  const adapter = globalThis.GamePilotAdapters?.huntera;
  const gameState = adapter?.readState?.() || { gameKey: "huntera", detected: false, page: location.pathname };
  updateCharacterPageTitle(gameState.detected ? gameState.character?.name : null);
  // Transient command modes must not outlive the UI state they describe. This
  // clears a stale `selling` after the shop closes (or after a reload), which
  // previously hid a real training-update behind a false "Vendendo" status.
  if (!commandBusy && !automationBusy) {
    if (gameState.shopOpen) mode = "selling";
    else if (gameState.inHunt) mode = "hunting";
    else if (gameState.training?.active) mode = "training";
    else if (mode === "error" && gameState.detected && gameState.inTown) mode = "idle";
    else if (["selling", "hunting", "returning", "starting", "training"].includes(mode)) mode = "idle";
  }
  // During an F5 the SPA can briefly expose its character-selection shell before
  // restoring the active hunt. Only recover when that state remains stable and
  // there is no evidence of a loaded character or hunt.
  const recoveryCandidate = gameState.characterSelection && !gameState.detected && !gameState.inHunt;
  if (recoveryCandidate && !characterSelectionSince) characterSelectionSince = Date.now();
  if (!recoveryCandidate) characterSelectionSince = 0;
  if (recoveryCandidate && automationEnabled && Date.now() - characterSelectionSince >= RECOVERY_CONFIRM_MS) {
    if (!recoveryNoticeSent) {
      recoveryNoticeSent = true;
      mode = "reconnecting";
      showBanner("conexão perdida; selecionando personagem");
      void sendEvent({ type: "connection.lost", message: "Huntera voltou para a tela de personagens", details: { character: automationPayload.characterName || automationPayload.character?.name || null } });
    }
  } else if ((gameState.detected || gameState.inHunt) && recoveryNoticeSent) {
    recoveryNoticeSent = false;
    void sendEvent({ type: "connection.restored", message: "Personagem carregado novamente no Huntera", details: { character: gameState.character?.name || null } });
  }
  void runAutoTrainingCycle(gameState);
  void runArrowSwitchCycle(gameState);
  void runAutomationCycle(gameState);
  const reportedGameState = { ...gameState, gamepilot: { automationEnabled, hunt: automationConfig, bestiary: automationPayload.bestiary || null, operation: operationReport(gameState), lastError: lastOperationError } };
  // Busy tabs still ask for stop/return interrupts; the worker requests only
  // those commands. A normal command must remain queued until we are idle.
  const wantsCommand = !commandBusy && !automationBusy;
  if (stateRequestPending || interrupting) return;
  stateRequestPending = true;
  sendRuntimeMessage({ type: "page-state", wantsCommand, state: { url: location.href, title: document.title, observedAt: new Date().toISOString(), mode, gameKey: "huntera", connectionKey, gameState: reportedGameState } }, (response, runtimeError) => {
    stateRequestPending = false;
    if (isInvalidatedExtensionContext(runtimeError)) return;
    if (runtimeError) return showBanner("extensão conectada; API offline");
    if (!response?.ok) return showBanner("erro de conexão com a API");
    if (response.command) {
      commandBusy = true;
      const interrupt = ["stop", "return-town"].includes(response.command);
      if (interrupt) {
        interrupting = true;
        automationEnabled = false;
        globalThis.GamePilotAdapters?.huntera?.cancelPending?.();
      }
      const previous = activeCommand;
      activeCommand = (async () => {
        await previous.catch(() => {});
        // Automation may be unwinding a cancelled adapter wait.
        while (automationBusy) await new Promise((resolve) => setTimeout(resolve, 50));
        commandBusy = true;
        try { await handleCommand(response.command, response.commandId, response.payload); }
        finally { commandBusy = false; interrupting = false; }
      })().catch((error) => { showBanner(error.message || "Falha ao executar comando"); });
    } else {
      showBanner(`conectado · ${mode}`);
    }
  });
}

// Best-effort notice so the API can retire this connection immediately when the
// tab closes, instead of waiting for its last_seen_at to go stale. The server
// staleness sweep is the real guarantee; this just makes the common case fast.
window.addEventListener("pagehide", () => {
  sendRuntimeMessage({ type: "agent-disconnect", connectionKey });
});

// The 3s timer below is throttled to ~1/min by Chrome while the tab is in the
// background, which stalled the live state and made the dashboard read
// "Extensão desconectada · sem sinal" even mid-hunt. WebSocket message delivery
// is NOT throttled, so we also post state (and run the automation cycle) when the
// game socket speaks — calling sendState directly from the event, throttled by
// timestamp rather than a timer, so it keeps flowing when the tab is backgrounded.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "gamepilot-huntera-socket") return;
  if (event.data.kind !== "message" && event.data.kind !== "connection") return;
  if (event.data.kind === "message" && ["creature-appear", "creature-disappear", "creature-resync", "ammo-selection"].includes(event.data.message?.type)) scheduleArrowSwitchCycle();
  if (Date.now() - lastStatePostAt >= 2500) sendState();
});

restoreAutomationState();
showBanner("extensão carregada");
sendState();
if (runtimeMessagingAvailable) stateIntervalId = setInterval(sendState, 3000);
