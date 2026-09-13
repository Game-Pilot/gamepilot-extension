(() => {
  const key = "gamepilot.energySaver";
  const root = document.documentElement;
  const style = document.createElement("style");
  style.textContent = `
    html[data-gamepilot-energy="on"][data-gamepilot-energy-ready="true"] .viewport-host > canvas { visibility: hidden !important; }
    html[data-gamepilot-energy="on"][data-gamepilot-energy-ready="true"] .viewport-host { background: #101820 !important; }
    html[data-gamepilot-energy="on"][data-gamepilot-energy-ready="true"] .viewport-host::after {
      content: "Economia de energia · cenário oculto";
      position: absolute; inset: 40% 12px auto; text-align: center;
      color: #91b9ab; font: 14px system-ui; pointer-events: none;
    }
    html[data-gamepilot-energy="on"] .slot-cooldown { background: none !important; }
    html[data-gamepilot-energy="on"] .viewport-host,
    html[data-gamepilot-energy="on"] .hud-slot {
      box-shadow: none !important; filter: none !important; backdrop-filter: none !important;
      transition: none !important; animation: none !important;
    }
  `;
  document.head.append(style);
  let enabled = false;
  const leaseKey = "gamepilot.energyBenchmark";
  const documentId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  let lease = null;
  let leaseTimer = null;
  try { enabled = sessionStorage.getItem(key) === "on"; } catch {}
  // A document reload must never preserve a temporary benchmark setting.
  try {
    const interrupted = JSON.parse(sessionStorage.getItem(leaseKey) || "null");
    if (interrupted && typeof interrupted.original === "boolean") {
      enabled = interrupted.original;
      sessionStorage.setItem(key, enabled ? "on" : "off");
      sessionStorage.removeItem(leaseKey);
    }
  } catch {}
  function apply(value) {
    enabled = value;
    root.setAttribute("data-gamepilot-energy", enabled ? "on" : "off");
  }
  apply(enabled);
  function restore() {
    if (!lease) return;
    apply(lease.original);
    sessionStorage.setItem(key, enabled ? "on" : "off");
    sessionStorage.removeItem(leaseKey);
    lease = null;
    clearTimeout(leaseTimer);
  }
  function state() {
    document.dispatchEvent(new Event("gamepilot-energy-probe"));
    let renderer = null;
    try { renderer = JSON.parse(root.getAttribute("data-gamepilot-energy-stats") || "null"); } catch {}
    return { ok: true, enabled, ready: root.getAttribute("data-gamepilot-energy-ready") === "true",
      renderer,
      documentId, locked: Boolean(lease), visible: document.visibilityState === "visible",
      title: document.title, width: globalThis.innerWidth, height: globalThis.innerHeight,
      hunting: Boolean(document.querySelector?.("#nav-leave-hunt")?.getClientRects().length) };
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "energy-benchmark-begin") {
      if (lease || typeof message.runId !== "string" || !state().ready) { respond({ ok: false, error: "Benchmark indisponível ou já em andamento." }); return; }
      lease = { runId: message.runId, original: enabled };
      try { sessionStorage.setItem(leaseKey, JSON.stringify(lease)); }
      catch { lease = null; respond({ ok: false, error: "Não foi possível salvar a restauração." }); return; }
      leaseTimer = setTimeout(() => { try { restore(); } catch {} }, 180000);
      respond(state()); return;
    }
    if (message?.type === "energy-benchmark-end") {
      if (lease && lease.runId !== message.runId) { respond({ ok: false, error: "Benchmark diferente em andamento." }); return; }
      try { restore(); respond(state()); } catch { respond({ ok: false, error: "Falha ao restaurar a preferência." }); }
      return;
    }
    if (message?.type !== "energy-saver-state" && message?.type !== "energy-saver-set") return;
    const ready = root.getAttribute("data-gamepilot-energy-ready") === "true";
    if (message.type === "energy-saver-set") {
      if ((lease && message.runId !== lease.runId) || (!lease && message.runId)) { respond({ ok: false, error: "Aguarde o benchmark terminar." }); return; }
      if (typeof message.enabled !== "boolean") { respond({ ok: false, error: "Opção inválida." }); return; }
      if (message.enabled && !ready) { respond({ ok: false, error: "Recarregue o jogo para carregar o modo econômico." }); return; }
      try { if (!lease) sessionStorage.setItem(key, message.enabled ? "on" : "off"); }
      catch { respond({ ok: false, error: "Não foi possível salvar a preferência desta aba." }); return; }
      apply(message.enabled);
    }
    respond(state());
  });
})();
