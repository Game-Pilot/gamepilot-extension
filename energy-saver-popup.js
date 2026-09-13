(() => {
  const toggle = document.querySelector("#energy-saver");
  const status = document.querySelector("#energy-status");
  let currentTabId = null;
  let generation = 0;
  let busy = false;
  async function refresh() {
    const request = ++generation;
    currentTabId = null;
    toggle.disabled = true;
    toggle.checked = false;
    try {
      const { id: windowId } = await chrome.windows.getCurrent();
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (request !== generation) return;
      if (!tab?.url?.startsWith("https://huntera.com.br/")) { status.textContent = "Selecione uma aba do Huntera."; return; }
      const response = await chrome.tabs.sendMessage(tab.id, { type: "energy-saver-state" });
      if (request !== generation) return;
      if (!response?.ok || !response.ready) throw new Error("Aguardando o motor do jogo. Se a caçada já carregou, recarregue a aba após atualizar a extensão.");
      currentTabId = tab.id;
      toggle.checked = response.enabled;
      toggle.disabled = response.locked === true;
      status.textContent = response.enabled ? "Ativada nesta aba · cenário oculto." : "Desativada nesta aba.";
    } catch (error) {
      if (request === generation) status.textContent = error.message || "A aba ainda não responde.";
    }
  }
  toggle.addEventListener("change", async () => {
    if (currentTabId === null || busy) return;
    const request = generation;
    const tabId = currentTabId;
    busy = true;
    toggle.disabled = true;
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "energy-saver-set", enabled: toggle.checked });
      if (!response?.ok) throw new Error(response?.error || "Não foi possível alterar o modo.");
      if (request === generation) await refresh();
    } catch (error) {
      if (request === generation) { await refresh(); status.textContent = error.message; }
    } finally { busy = false; }
  });
  chrome.tabs.onActivated.addListener(refresh);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes["gamepilot.benchmark"]) refresh();
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "complete") refresh();
  });
  refresh();
})();
