const $ = (selector) => document.querySelector(selector);

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function setResult(message = "", error = false) {
  $("#result").textContent = message;
  $("#result").classList.toggle("error", error);
}

function renderStatus(response) {
  const status = $("#status");
  if (!response?.ok) {
    status.textContent = "API indisponível";
    status.classList.remove("connected");
    return;
  }
  if (response.status === "unpaired") {
    status.textContent = "Extensão não vinculada";
    status.classList.remove("connected");
    return;
  }
  const activeConnections = (response.connections || []).filter((item) =>
    item.status === "connected" || item.status === "awaiting_character"
  ).length;
  status.textContent = `Extensão vinculada · ${activeConnections} conexão(ões)`;
  status.classList.add("connected");
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
