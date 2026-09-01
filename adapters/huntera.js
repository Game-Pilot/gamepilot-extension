(function registerHunteraAdapter() {
  function readNumber(value) {
    if (!value) return null;
    const normalized = String(value).trim().replace(/\./g, "").replace(",", ".");
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  function readBar(selector) {
    const element = document.querySelector(selector);
    const value = element?.querySelector("span:not(.hud-regen)")?.textContent?.trim() || "";
    const match = value.match(/([\d.]+)\s*\/\s*([\d.]+)/);
    if (!match) return null;
    const current = readNumber(match[1]);
    const max = readNumber(match[2]);
    return { current, max, percent: current !== null && max ? Math.round((current / max) * 1000) / 10 : null };
  }

  function readState() {
    const characterName = document.querySelector(".header-character-name")?.textContent?.trim() || null;
    const vocationElement = document.querySelector(".header-character-vocation");
    const vocation = vocationElement?.querySelector("span")?.textContent?.trim() || null;
    const levelText = vocationElement?.querySelector("em")?.textContent?.trim() || "";
    const levelMatch = levelText.match(/(?:Lv|Level)\s*(\d+)/i);
    const experienceTitle = document.querySelector(".hud-exp")?.getAttribute("title") || "";
    const experienceMatch = experienceTitle.match(/([\d.]+)\s*\/\s*([\d.]+)/);
    const experienceCurrent = experienceMatch ? readNumber(experienceMatch[1]) : null;
    const experienceMax = experienceMatch ? readNumber(experienceMatch[2]) : null;
    const experience = experienceMatch ? {
      current: experienceCurrent,
      max: experienceMax,
      percent: experienceCurrent !== null && experienceMax
        ? Math.round((experienceCurrent / experienceMax) * 1000) / 10
        : null
    } : null;
    const stamina = document.querySelector(".hud-stamina-clock")?.textContent?.trim() || null;
    const bodyText = document.body?.innerText || "";

    return {
      gameKey: "huntera",
      detected: Boolean(characterName),
      loggedIn: Boolean(characterName),
      page: location.pathname,
      inHunt: bodyText.includes("Sair da caçada"),
      character: characterName ? {
        name: characterName,
        vocation,
        level: levelMatch ? Number(levelMatch[1]) : null
      } : null,
      resources: {
        health: readBar(".hud-hp"),
        mana: readBar(".hud-mp")
      },
      experience,
      stamina,
      shopOpen: isVisible(document.querySelector(".shop-window"))
    };
  }

  function isVisible(element) {
    if (!element || element.hidden) return false;
    const style = window.getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  }

  function waitForVisible(selector, timeout = 2500) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        const element = document.querySelector(selector);
        if (isVisible(element)) return resolve(element);
        if (Date.now() - startedAt >= timeout) return resolve(null);
        window.setTimeout(check, 100);
      };
      check();
    });
  }

  async function openStore() {
    if (isVisible(document.querySelector(".shop-window"))) return { ok: true, alreadyOpen: true };
    if (readState().inHunt) return { ok: false, error: "Saia da caçada antes de abrir a loja" };
    const button = document.querySelector("#nav-store");
    if (!button) return { ok: false, error: "Botão da loja não encontrado nesta tela" };
    button.click();
    const shop = await waitForVisible(".shop-window");
    return shop
      ? { ok: true, alreadyOpen: false }
      : { ok: false, error: "A loja não abriu após o comando" };
  }

  globalThis.GamePilotAdapters = globalThis.GamePilotAdapters || {};
  globalThis.GamePilotAdapters.huntera = { key: "huntera", readState, openStore };
})();
