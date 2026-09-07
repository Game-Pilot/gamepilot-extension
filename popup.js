const $ = (selector) => document.querySelector(selector);

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function setResult(message = "", error = false) {
  $("#result").textContent = message;
  $("#result").classList.toggle("error", error);
}

function renderVersion(version = {}) {
  const badge = $("#version-badge");
  const installed = version.installed || chrome.runtime.getManifest().version || "—";
  $("#installed-version").textContent = `v${installed}`;
  badge.classList.remove("current", "outdated", "preview");
  if (!version.latest) {
    badge.textContent = "Não verificada";
    $("#latest-version").textContent = "Não foi possível consultar a versão publicada.";
    return;
  }
  $("#latest-version").textContent = `Versão publicada: v${version.latest}`;
  if (version.updateAvailable) {
    badge.textContent = "Desatualizada";
    badge.classList.add("outdated");
    return;
  }
  if (version.aheadOfPublished) {
    badge.textContent = "Prévia local";
    badge.classList.add("preview");
    return;
  }
  badge.textContent = "Atualizada";
  badge.classList.add("current");
}

function renderStatus(response) {
  const status = $("#status");
  const environment = $("#environment");
  renderVersion(response?.version);
  environment.textContent = response?.environment?.label || "Ambiente desconhecido";
  environment.classList.toggle("local", response?.environment?.key === "local");
  if (!response?.ok) {
    status.textContent = "API indisponível";
    status.classList.remove("connected");
    return;
  }
  if (response.status === "unpaired") {
    status.textContent = "Extensão não vinculada";
    status.classList.remove("connected");
    $("#connection-details").classList.remove("visible");
    $("#pair-form").hidden = false;
    return;
  }
  const activeConnections = (response.connections || []).filter((item) =>
    item.status === "connected" || item.status === "awaiting_character"
  ).length;
  status.textContent = `Extensão vinculada · ${activeConnections} conexão(ões)`;
  status.classList.add("connected");
  $("#connection-details").classList.add("visible");
  $("#pair-form").hidden = true;
  $("#account-name").textContent = response.account?.displayName || "Sem nome informado";
  $("#account-email").textContent = response.account?.email || "E-mail indisponível";
  $("#device-name").textContent = response.device?.name || "Chrome";
  $("#active-tabs").textContent = String(activeConnections);
}

async function refreshStatus() {
  setResult("Atualizando…");
  const response = await send({ type: "device-status" });
  renderStatus(response);
  if (!response?.ok) setResult(response.error || "Não foi possível consultar a API", true);
  else setResult("");
}

$("#pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("#pair-code").value.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (code.length !== 8) { setResult("Informe os 8 caracteres do código.", true); return; }
  setResult("Vinculando…");
  const response = await send({ type: "pair-device", code });
  renderStatus(response);
  if (!response?.ok) { setResult(response.error || "Não foi possível vincular", true); return; }
  $("#pair-code").value = "";
  setResult("Extensão vinculada. As próximas abas ficarão associadas a esta conta.");
});

$("#refresh-status").addEventListener("click", () => refreshStatus().catch((error) => setResult(error.message, true)));
refreshStatus().catch((error) => setResult(error.message, true));

const analyzerNumber = value => typeof value === "number" && Number.isFinite(value)
  ? value.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) : "—";
function analyzerDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
}
function metricCards(selector, entries) {
  $(selector).replaceChildren(...entries.map(([label, value, accent]) => {
    const card = document.createElement("div"); card.className = `metric-card${accent ? " accent" : ""}`;
    const title = document.createElement("span"); title.className = "metric-label"; title.textContent = label;
    const number = document.createElement("strong"); number.className = "metric-value"; number.textContent = value;
    card.append(title, number); return card;
  }));
}
function usageRows(selector, counts, names = {}) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  const root = $(selector); root.replaceChildren();
  if (!entries.length) { const empty = document.createElement("p"); empty.className = "note"; empty.textContent = "Nenhum uso registrado neste período."; root.append(empty); return; }
  for (const [id, count] of entries) {
    const row = document.createElement("div"); row.className = "usage-row";
    const label = document.createElement("span"); label.textContent = Object.hasOwn(names, id) ? names[id] : id.replace(/-/g, " ");
    const value = document.createElement("strong"); value.textContent = analyzerNumber(count);
    row.append(label, value); root.append(row);
  }
}
function renderAnalyzer(response) {
  const o = response?.observedAnalyzer;
  const available = response?.ok && Boolean(o?.startedAt);
  $("#observed-content").hidden = !available;
  $("#observed-character").textContent = response?.character || "Sua próxima caçada";
  if (!available) {
    $("#observed-status").textContent = response?.error || "Aguardando eventos da caçada para iniciar a medição.";
    return;
  }
  const age = Date.now() - Date.parse(o.observedAt);
  const status = !response.connected ? "Desconectado · últimos dados" : age > 15000 ? "Sem eventos recentes" : "Captura ativa";
  $("#observed-status").textContent = `${status} · desde ${new Date(o.startedAt).toLocaleTimeString("pt-BR")}`;
  const n = analyzerNumber;
  metricCards("#observed-metrics", [["Tempo capturado", analyzerDuration(o.durationMs)], ["Abates · parcial", n(o.kills)], ["Experiência", n(o.xpGained), true], ["XP por hora", n(o.xpPerHour), true]]);
  const dps = typeof o.damagePerSecond === "number" && Number.isFinite(o.damagePerSecond) ? o.damagePerSecond.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : "—";
  metricCards("#observed-combat", [["Dano causado", n(o.damageDealt), true], ["Dano por segundo", dps, true], ["Dano recebido", n(o.damageReceived)], ["Acertos causados", n(o.outgoingHits)], ["Dano sem atribuição", n(o.unattributedDamage)]]);
  metricCards("#observed-recovery", [["Vida recuperada", n(o.healthRestored)], ["Mana recuperada", n(o.manaRestored)], ["Roubo de vida", n(o.leechFieldObserved ? o.lifeLeech : null)], ["Roubo de mana", n(o.leechFieldObserved ? o.manaLeech : null)], ["Críticos causados", n(o.criticalFieldObserved ? o.outgoingCriticals : null)], ["Críticos recebidos", n(o.criticalFieldObserved ? o.incomingCriticals : null)], ["Seus ataques bloqueados", n(o.blockFieldObserved ? o.outgoingBlocks : null)], ["Ataques recebidos bloqueados", n(o.blockFieldObserved ? o.incomingBlocks : null)]]);
  usageRows("#observed-spells", o.spellCasts, {haste: "Haste", "divine-missile": "Divine Missile", "strong-ethereal-spear": "Strong Ethereal Spear"});
  usageRows("#observed-items", Object.fromEntries(Object.entries(o.itemUses || {}).map(([id, count]) => [`Item #${id}`, count])), {"Item #236": "Strong Health Potion", "Item #237": "Strong Mana Potion"});
}

let analyzerRequest = 0;
const panelWindow = chrome.windows.getCurrent();
async function refreshAnalyzer() {
  const request = ++analyzerRequest;
  try {
    const { id: windowId } = await panelWindow;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (request !== analyzerRequest) return;
    if (!tab?.id || !tab.url?.startsWith("https://huntera.com.br/")) {
      renderAnalyzer({ error: "Selecione uma aba do Huntera nesta janela para ver a caçada." }); return;
    }
    const response = await chrome.tabs.sendMessage(tab.id, { type: "hunt-analyzer-state" });
    if (request !== analyzerRequest) return;
    renderAnalyzer(response);
  } catch {
    if (request !== analyzerRequest) return;
    renderAnalyzer({ error: "A aba ainda não responde. Após atualizar a extensão, recarregue o jogo para carregar a nova versão." });
  }
}
chrome.tabs.onActivated.addListener(() => {
  renderAnalyzer({ error: "Buscando dados da aba atual…" });
  refreshAnalyzer();
});
refreshAnalyzer();
setInterval(refreshAnalyzer, 2000);
