(() => {
  const start = document.querySelector("#benchmark-start");
  const cancel = document.querySelector("#benchmark-cancel");
  const status = document.querySelector("#benchmark-status");
  const result = document.querySelector("#benchmark-result");
  const download = document.querySelector("#benchmark-export");
  let record = null;
  let pending = false;
  let refreshing = false;
  let rendered = "";
  let actionError = "";
  const number = value => Number.isFinite(value) ? value.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : "—";
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "A extensão não respondeu.");
    return response;
  }
  function render() {
    start.disabled = pending || Boolean(record?.running);
    cancel.hidden = !record?.running;
    download.hidden = !record || record.running;
    if (record?.running) {
      const phase = ["Desligado — antes", "Ligado", "Desligado — depois"][record.phase] || "Preparando";
      status.textContent = `${record.title} · ${phase} · ${record.stage === "measuring" ? `${record.progress}/${record.sampleCount} amostras` : record.stage === "restoring" ? "Restaurando sua escolha…" : "Estabilizando…"}`;
    } else {
      status.textContent = record?.status === "complete" ? `${record.title} · benchmark concluído.` : record?.error || "Mede o trabalho da página e sua memória JavaScript, sem enviar dados à API.";
    }
    if (actionError) status.textContent = actionError;
    const signature = record ? `${record.runId}:${record.running}:${record.status}` : "empty";
    if (rendered === signature) return;
    rendered = signature;
    result.replaceChildren();
    result.hidden = !record || record.running;
    if (result.hidden) return;
    if (record.phases?.length) {
      const table = document.createElement("table");
      const caption = document.createElement("caption"); caption.textContent = "Trabalho da thread principal e heap JavaScript"; table.append(caption);
      const header = document.createElement("tr");
      for (const label of ["Fase", "Ocupação", "Heap JS"]) { const cell = document.createElement("th"); cell.textContent = label; cell.scope = "col"; header.append(cell); }
      const head = document.createElement("thead"); head.append(header); table.append(head);
      const body = document.createElement("tbody");
      for (const phase of record.phases) {
        const row = document.createElement("tr");
        for (const value of [phase.label, `${number(phase.summary.busyPercent)}%`, `${number(phase.summary.heapMiB)} MiB`]) {
          const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
        }
        body.append(row);
      }
      table.append(body); result.append(table);
    }
    const addNote = text => { const p = document.createElement("p"); p.className = "note"; p.textContent = text; result.append(p); };
    if (record.status === "complete" && record.comparison) {
      const c = record.comparison;
      addNote(`Ao ligar, a ocupação mudou ${number(c.changePoints)} pontos percentuais (${number(c.changePercent)}% relativo) contra a média das duas fases desligadas.`);
      addNote(c.unstable ? "Resultado instável: as duas fases desligadas variaram bastante. Repita antes de atribuir a diferença ao toggle." : "Uma execução é exploratória. Repita para verificar se a diferença se mantém.");
    } else addNote("Execução incompleta: não use as fases parciais como uma comparação concluída.");
    for (const warning of record.warnings || []) addNote(warning);
    addNote("Não é CPU total do computador, RAM total ou GPU. Outros contextos no mesmo renderer podem contribuir; workers separados não estão incluídos. Layout e scripts detalhados estão no JSON.");
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try { record = (await send({ type: "benchmark-state" })).record; render(); }
    catch (error) { status.textContent = error.message; }
    finally { refreshing = false; }
  }
  start.addEventListener("click", async () => {
    actionError = ""; pending = true; render();
    try {
      const { id: windowId } = await chrome.windows.getCurrent();
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (!tab?.id) throw new Error("Selecione o Huntera nesta janela.");
      await send({ type: "benchmark-start", tabId: tab.id });
      await refresh();
    } catch (error) { actionError = error.message; status.textContent = actionError; }
    finally { pending = false; start.disabled = Boolean(record?.running); }
  });
  cancel.addEventListener("click", async () => {
    actionError = "";
    cancel.disabled = true;
    try { await send({ type: "benchmark-cancel" }); status.textContent = "Cancelando e restaurando sua escolha…"; }
    catch (error) { actionError = error.message; status.textContent = actionError; }
    finally { cancel.disabled = false; }
  });
  download.addEventListener("click", () => {
    if (!record || record.running) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url;
    link.download = `gamepilot-benchmark-${record.tabId}-${record.startedAt.replace(/[:.]/g, "-")}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  refresh();
  setInterval(refresh, 1000);
})();
