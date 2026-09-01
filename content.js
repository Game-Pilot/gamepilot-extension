let mode = "idle";
let banner;

function showBanner(text) {
  if (!banner) {
    banner = document.createElement("div");
    banner.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;padding:8px 12px;border-radius:8px;background:#172033;color:#d8f3ff;font:12px system-ui;box-shadow:0 4px 16px #0006";
    document.documentElement.appendChild(banner);
  }
  banner.textContent = `GamePilot · ${text}`;
}

function sendState() {
  chrome.runtime.sendMessage({
    type: "page-state",
    state: { url: location.href, title: document.title, mode }
  }, (response) => {
    if (chrome.runtime.lastError) return showBanner("extensão conectada; API offline");
    if (!response?.ok) return showBanner("erro de conexão com a API");
    if (response.command === "start-test") {
      mode = "test-running";
      showBanner("comando iniciar recebido");
    }
    if (response.command === "stop-test") {
      mode = "idle";
      showBanner("comando parar recebido");
    }
    if (!response.command) showBanner(`conectado · ${mode}`);
  });
}

sendState();
setInterval(sendState, 3000);
