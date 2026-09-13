(() => {
  const KEY = "gamepilot.benchmark";
  const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const required = ["Timestamp", "TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "JSHeapUsedSize"];
  function metrics(response) {
    const values = Object.fromEntries((response?.metrics || []).map(item => [item.name, item.value]));
    for (const name of required) if (!Number.isFinite(values[name]) || values[name] < 0) throw new Error(`Métrica indisponível: ${name}`);
    return values;
  }
  function interval(before, after) {
    const seconds = after.Timestamp - before.Timestamp;
    if (seconds <= 0) throw new Error("Relógio de medição inválido.");
    for (const name of required.slice(1, 5)) if (after[name] < before[name]) throw new Error("Contadores reiniciados; a página pode ter sido recarregada.");
    return { seconds, busySeconds: after.TaskDuration - before.TaskDuration,
      scriptSeconds: after.ScriptDuration - before.ScriptDuration,
      layoutSeconds: after.LayoutDuration - before.LayoutDuration,
      styleSeconds: after.RecalcStyleDuration - before.RecalcStyleDuration,
      heapMiB: after.JSHeapUsedSize / 1048576 };
  }
  function summarize(samples) {
    const seconds = samples.reduce((sum, sample) => sum + sample.seconds, 0);
    const rate = (key, factor) => factor * samples.reduce((sum, sample) => sum + sample[key], 0) / seconds;
    return { seconds, busyPercent: rate("busySeconds", 100), scriptMsPerSecond: rate("scriptSeconds", 1000),
      layoutMsPerSecond: rate("layoutSeconds", 1000), styleMsPerSecond: rate("styleSeconds", 1000),
      heapMiB: average(samples.map(sample => sample.heapMiB)) };
  }
  function comparison(phases) {
    const [a, b, c] = phases.map(phase => phase.summary);
    const baseline = (a.busyPercent + c.busyPercent) / 2;
    const baselineDriftPoints = Math.abs(a.busyPercent - c.busyPercent);
    return { baselineBusyPercent: baseline, enabledBusyPercent: b.busyPercent,
      changePoints: b.busyPercent - baseline,
      changePercent: baseline > 0 ? 100 * (b.busyPercent / baseline - 1) : null,
      baselineDriftPoints,
      unstable: baselineDriftPoints > Math.max(3, baseline * 0.2) };
  }

  function createController(api, options = {}) {
    const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const now = options.now || Date.now;
    const sampleCount = options.sampleCount || 30;
    const warmupCount = options.warmupCount ?? 5;
    let current = null;
    let finishing = null;
    let starting = false;
    const timeout = (promise) => {
      if (options.noTimeout) return promise;
      let timer;
      return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("A aba não respondeu a tempo.")), 8000); })]).finally(() => clearTimeout(timer));
    };
    const persist = record => api.storage.session.set({ [KEY]: record });
    const page = async (tabId, message) => {
      const response = await timeout(api.tabs.sendMessage(tabId, message));
      if (!response?.ok) throw new Error(response?.error || "A aba não responde. Recarregue o Huntera após atualizar a extensão.");
      return response;
    };
    const command = (record, method, params) => timeout(api.debugger.sendCommand({ tabId: record.tabId }, method, params));
    async function validate(record, expectedMode) {
      if (record.cancel) throw new Error(record.cancel);
      const tab = await api.tabs.get(record.tabId);
      if (!tab.active || tab.url !== record.url) throw new Error("A aba foi trocada ou navegou; comparação interrompida.");
      const state = await page(record.tabId, { type: "energy-saver-state" });
      if (state.documentId !== record.documentId || state.title !== record.title) throw new Error("A página ou personagem mudou; comparação interrompida.");
      if (state.hunting !== record.hunting) throw new Error("A caçada começou ou terminou; comparação interrompida.");
      if (!state.visible || state.width !== record.width || state.height !== record.height) throw new Error("A visibilidade ou tamanho da página mudou; comparação interrompida.");
      if (!state.locked || (typeof expectedMode === "boolean" && state.enabled !== expectedMode)) throw new Error("O modo econômico mudou fora do benchmark.");
      if (!state.ready || state.renderer?.strategy !== record.strategy) throw new Error("O renderizador econômico não está disponível nesta página.");
      return state;
    }
    async function cleanup(record) {
      const warnings = [];
      if (record.leased) {
        try {
          const state = await page(record.tabId, { type: "energy-benchmark-end", runId: record.runId });
          if (state.enabled !== record.original) throw new Error("Estado restaurado diferente do inicial.");
        } catch (error) { warnings.push(`Restauração não confirmada: ${error.message} A página tem restauração de emergência após 3 minutos ou recarga.`); }
      }
      if (record.attached) {
        try { await timeout(api.debugger.detach({ tabId: record.tabId })); }
        catch (error) { warnings.push(`Fim da depuração não confirmado: ${error.message}`); }
      }
      return warnings;
    }
    // Persisted recovery also runs when the service worker is restarted. The
    // content script stores the original setting independently as a fallback.
    const ready = (async () => {
      const saved = (await api.storage.session.get(KEY))[KEY];
      if (saved?.running) {
        saved.warnings = await cleanup(saved);
        saved.running = false; saved.status = "interrupted";
        saved.error = "A extensão reiniciou durante o benchmark. Execute novamente.";
        await persist(saved);
      }
    })();

    async function execute(record) {
      try {
        await command(record, "Performance.enable", { timeDomain: "timeTicks" });
        for (const [index, enabled] of [false, true, false].entries()) {
          await validate(record);
          await page(record.tabId, { type: "energy-saver-set", enabled, runId: record.runId });
          record.phase = index; record.stage = "warmup"; record.progress = 0;
          await persist(record);
          for (let i = 0; i < warmupCount; i++) { await wait(1000); await validate(record, enabled); }
          const renderBefore = (await validate(record, enabled)).renderer;
          let before = metrics(await command(record, "Performance.getMetrics"));
          const samples = [];
          record.stage = "measuring";
          for (let i = 0; i < sampleCount; i++) {
            await wait(1000);
            await validate(record, enabled);
            const after = metrics(await command(record, "Performance.getMetrics"));
            samples.push(interval(before, after)); before = after;
            record.progress = i + 1;
            await persist(record);
          }
          const renderAfter = (await validate(record, enabled)).renderer;
          const renderFrames = renderAfter.framesSeen - renderBefore.framesSeen;
          const skippedFrames = renderAfter.framesSkipped - renderBefore.framesSkipped;
          if (!(renderFrames > 0) || (enabled ? skippedFrames !== renderFrames : skippedFrames !== 0)) {
            throw new Error("Não foi possível confirmar a renderização esperada nesta fase. Resultado descartado.");
          }
          record.phases.push({ label: index === 1 ? "Ligado" : index === 0 ? "Desligado — antes" : "Desligado — depois", enabled, renderFrames, skippedFrames, samples, summary: summarize(samples) });
        }
        record.comparison = comparison(record.phases);
        record.status = "complete";
      } catch (error) {
        record.status = record.cancel ? "cancelled" : "failed";
        record.error = error.message;
      } finally {
        record.stage = "restoring";
        record.warnings = await cleanup(record);
        record.running = false; record.finishedAt = new Date(now()).toISOString();
        try { await persist(record); } finally { current = null; }
      }
    }

    async function start(tabId) {
      await ready;
      if (current || starting) throw new Error("Já existe um benchmark em andamento.");
      starting = true;
      let record;
      try {
        const tab = await api.tabs.get(tabId);
        if (!tab.active || new URL(tab.url).origin !== "https://huntera.com.br") throw new Error("Selecione uma aba ativa do Huntera.");
        const state = await page(tabId, { type: "energy-saver-state" });
        if (!state.ready || !state.documentId || !state.visible || state.locked) throw new Error("Mantenha o Huntera visível e recarregue o jogo após atualizar a extensão.");
        if (state.renderer?.strategy !== "scene-visibility-v2") throw new Error("Recarregue a extensão e o jogo para usar o renderizador econômico atualizado.");
        const targets = await api.debugger.getTargets();
        if (targets.some(target => target.tabId === tabId && target.attached)) throw new Error("A aba já está em depuração. Feche o DevTools ou encerre a outra sessão antes de medir.");
        record = { runId: `${now()}-${Math.random()}`, tabId, url: tab.url, title: state.title,
          documentId: state.documentId, width: state.width, height: state.height, hunting: state.hunting,
          strategy: state.renderer.strategy, extensionVersion: api.runtime?.getManifest?.().version || null,
          original: state.enabled, running: true, status: "running", phase: 0, stage: "preparing", progress: 0,
          sampleCount, warmupCount, phases: [], startedAt: new Date(now()).toISOString(),
          scope: "Alvo CDP da aba: thread principal e heap JS. Não mede CPU total do processo, RAM total, GPU ou workers separados. Contextos que compartilham o renderer podem contribuir.",
          method: "Performance.getMetrics timeTicks; delta TaskDuration / delta Timestamp. A/B/A, 5 s de estabilização e 30 intervalos de 1 s por fase; sem coleta forçada de lixo." };
        // Save restoration intent before changing any state.
        record.leased = true;
        await persist(record);
        await page(tabId, { type: "energy-benchmark-begin", runId: record.runId });
        // Do not race attach with a timeout: a late success would otherwise
        // create an attached debugger after cleanup believed attach failed.
        await api.debugger.attach({ tabId }, "1.3");
        record.attached = true;
        current = record;
        // Chrome may display a debugger infobar and resize the viewport.
        // Establish geometry after that UI settles, before any measured phase.
        await wait(1000);
        const attachedState = await page(tabId, { type: "energy-saver-state" });
        record.width = attachedState.width; record.height = attachedState.height;
        await validate(record);
        await persist(record);
        finishing = execute(record);
        // execute handles measurement failures and cleanup. A storage failure
        // must not become an unhandled rejection in the service worker.
        finishing.catch(() => {});
        return { ok: true };
      } catch (error) {
        if (record) {
          record.warnings = await cleanup(record);
          record.running = false; record.status = "failed"; record.error = error.message;
          await persist(record);
        }
        current = null;
        throw error;
      } finally { starting = false; }
    }
    async function handle(message) {
      await ready;
      if (message.type === "benchmark-start") {
        if (!Number.isInteger(message.tabId)) throw new Error("Aba inválida.");
        return start(message.tabId);
      }
      if (message.type === "benchmark-cancel") {
        if (current) current.cancel = "Benchmark cancelado pelo usuário.";
        return { ok: true };
      }
      return { ok: true, record: (await api.storage.session.get(KEY))[KEY] || null };
    }
    api.debugger.onDetach.addListener(source => {
      if (current?.tabId === source.tabId && current.stage !== "restoring") {
        current.attached = false;
        current.cancel = "A sessão de depuração foi encerrada; comparação interrompida.";
      }
    });
    return { handle, settled: () => finishing, ready };
  }
  globalThis.GamePilotBenchmark = { createController, metrics, interval, summarize, comparison };
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    const controller = createController(chrome);
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (!["benchmark-start", "benchmark-state", "benchmark-cancel"].includes(message?.type)) return;
      // Content scripts and external web pages cannot initiate debugger access.
      if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("popup.html")) {
        respond({ ok: false, error: "Abra o benchmark pelo painel da extensão." }); return;
      }
      controller.handle(message).then(respond, error => respond({ ok: false, error: error.message }));
      return true;
    });
  }
})();
