// Huntera updates SceneManager before rendering. Gate scene visibility only during render.
(() => {
  const attribute = "data-gamepilot-energy";
  const stats = { strategy: "scene-visibility-v2", framesSeen: 0, framesSkipped: 0 };
  const scratch = new WeakMap();
  let enabled = false;
  let installed = false;
  function worldGame(game) {
    return game?.canvas?.parentElement?.classList?.contains("viewport-host") === true;
  }
  function publish() {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute("data-gamepilot-energy-ready", String(installed));
    root.setAttribute("data-gamepilot-energy-stats", JSON.stringify(stats));
  }
  function install(manager) {
    const prototype = Object.getPrototypeOf(manager);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
    if (!descriptor?.writable || typeof descriptor.value !== "function") return false;
    const render = descriptor.value;
    function renderWithVisibility(renderer) {
      if (!worldGame(this.game)) return Reflect.apply(render, this, arguments);
      stats.framesSeen++;
      if (!enabled) return Reflect.apply(render, this, arguments);
      // Reuse one buffer per manager; no per-sprite or per-frame allocation.
      // Restore visibility before updates, input and POST_RENDER run.
      let saved = scratch.get(this);
      if (!saved) { saved = []; scratch.set(this, saved); }
      let count = 0;
      try {
        for (const scene of this.scenes) {
          const settings = scene.sys.settings;
          saved[count++] = settings;
          saved[count++] = settings.visible;
          settings.visible = false;
        }
        stats.framesSkipped++;
        return Reflect.apply(render, this, arguments);
      } finally {
        for (let index = 0; index < count; index += 2) saved[index].visible = saved[index + 1];
        saved.length = 0;
      }
    }
    Object.defineProperty(prototype, "render", { ...descriptor, value: renderWithVisibility });
    installed = true;
    publish();
    return true;
  }
  // Phaser is a private bundled module. Observe its startup Game.step binding,
  // install the scene-level gate, then immediately restore native bind.
  // Delegate the actual binding unchanged, including constructor semantics.
  const nativeBind = Function.prototype.bind;
  function observeGameBind(game) {
    const bound = Reflect.apply(nativeBind, this, arguments);
    try {
      if (!installed && game?.step === this && worldGame(game) && game.scene?.game === game &&
          Array.isArray(game.scene.scenes) && typeof game.scene.update === "function" &&
          typeof game.headlessStep === "function" && game.loop && game.renderer && game.events && install(game.scene)) {
        if (Function.prototype.bind === observeGameBind) Function.prototype.bind = nativeBind;
      }
    } catch { /* Unsupported engine: leave rendering untouched and readiness false. */ }
    return bound;
  }
  Function.prototype.bind = observeGameBind;
  function start() {
    const apply = () => { enabled = document.documentElement.getAttribute(attribute) === "on"; };
    new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: [attribute] });
    document.addEventListener("gamepilot-energy-probe", publish);
    publish(); apply();
  }
  if (document.documentElement) start();
  else new MutationObserver((_, observer) => {
    if (document.documentElement) { observer.disconnect(); start(); }
  }).observe(document, { childList: true });
})();
