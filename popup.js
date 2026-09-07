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
