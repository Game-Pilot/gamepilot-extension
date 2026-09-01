(function registerHunteraAdapter() {
  function visible(element) {
    if (!element || element.hidden) return false;
    const style = window.getComputedStyle(element); const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  }

  function firstVisible(selector) { return [...document.querySelectorAll(selector)].find(visible) || document.querySelector(selector); }

  function number(value) {
    if (value === null || value === undefined || value === "") return null;
    const raw = String(value).trim().replace(/\s/g, "");
    if (raw.includes(",") && raw.includes(".")) return Number(raw.lastIndexOf(",") > raw.lastIndexOf(".") ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, ""));
    if (/^\d+\.\d{3}$/.test(raw)) return Number(raw.replace(".", ""));
    return Number(raw.replace(",", "."));
  }

  function bar(selector) {
    const element = firstVisible(selector); if (!element) return null;
    const text = element.querySelector("span:not(.hud-regen)")?.textContent?.trim() || "";
    const match = text.match(/([\d.,]+)\s*\/\s*([\d.,]+)/); if (!match) return null;
    const current = number(match[1]); const max = number(match[2]);
    return { current, max, percent: current !== null && max ? Math.round((current / max) * 1000) / 10 : null };
  }

  function metric(text, label) {
    const match = text.match(new RegExp(`${label}\\s+([\\d.,]+)`, "i")); return match ? number(match[1]) : null;
  }

  function readLootMetrics() {
    const text = firstVisible(".analyzer-body")?.innerText?.replace(/\s+/g, " ") || "";
    const metrics = {
      kills: metric(text, "Inimigos mortos"), xpGained: metric(text, "XP ganha"), goldEarned: metric(text, "Gold"), goldSpent: metric(text, "Gasto"),
      xpPerHour: metric(text, "XP/h"), goldPerHour: metric(text, "Gold/h"), spentPerHour: metric(text, "Gasto/h"), balancePerHour: metric(text, "Saldo/h")
    };
    const loot = [...document.querySelectorAll(".analyzer-item-row")].map((row) => ({ name: row.querySelector(".analyzer-item-name")?.textContent?.trim() || null, text: row.innerText.trim() })).filter((item) => item.name);
    return { ...metrics, loot };
  }

  function readBackpack() {
    const element = firstVisible(".hud-capacity"); if (!element) return null;
    const fill = element.querySelector(".fill"); const strong = element.querySelector("strong"); const title = strong?.getAttribute("title") || "";
    const capacity = title.match(/Carregando\s+([\d.]+)\s+de\s+([\d.]+)\s+oz/i);
    return { percent: fill ? Number.parseFloat(fill.style.width) || null : null, currentOz: capacity ? number(capacity[1]) : number(strong?.textContent), maxOz: capacity ? number(capacity[2]) : null };
  }

  function readState() {
    const name = document.querySelector(".header-character-name")?.textContent?.trim() || null;
    const vocationElement = document.querySelector(".header-character-vocation");
    const vocation = vocationElement?.querySelector("span")?.textContent?.trim() || null;
    const levelText = vocationElement?.querySelector("em")?.textContent?.trim() || "";
    const levelMatch = levelText.match(/(?:Lv|Level)\s*(\d+)/i);
    const expTitle = firstVisible(".hud-exp")?.getAttribute("title") || "";
    const expMatch = expTitle.match(/([\d.,]+)\s*\/\s*([\d.,]+)/);
    const premiumOffer = visible(document.querySelector(".analyzer-locked-buy"));
    const stateText = document.body?.innerText || "";
    return {
      gameKey: "huntera", detected: Boolean(name), loggedIn: Boolean(name), page: location.pathname,
      inHunt: visible(document.querySelector("#nav-leave-hunt")), shopOpen: visible(document.querySelector(".trade-window")),
      premium: premiumOffer ? false : (document.querySelector(".analyzer-body") ? true : null),
      character: name ? { name, externalRef: name, vocation, level: levelMatch ? Number(levelMatch[1]) : null, premium: premiumOffer ? false : null } : null,
      resources: { health: bar(".hud-hp"), mana: bar(".hud-mp") },
      experience: expMatch ? { current: number(expMatch[1]), max: number(expMatch[2]) } : null,
      stamina: firstVisible(".hud-stamina-clock")?.textContent?.trim() || null,
      gold: number(firstVisible("#header-gold")?.textContent), backpack: readBackpack(), metrics: readLootMetrics(),
      target: { name: firstVisible(".target-name, .hud-target-name")?.textContent?.trim() || null }
    };
  }

  function waitFor(selector, timeout = 5000, expectedVisible = true) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        const element = document.querySelector(selector);
        if (expectedVisible === visible(element)) return resolve(element);
        if (Date.now() - startedAt >= timeout) return resolve(null);
        window.setTimeout(check, 100);
      };
      check();
    });
  }

  async function startHunt() {
    if (readState().inHunt) return { ok: true, alreadyStarted: true };
    const button = document.querySelector("#nav-start-hunt"); if (!button) return { ok: false, error: "Botão Caçar não encontrado nesta tela" };
    button.click(); const started = await waitFor("#nav-leave-hunt", 5000, true);
    return started ? { ok: true } : { ok: false, error: "A tela de caçada não confirmou o início" };
  }

  async function leaveHunt() {
    if (!readState().inHunt) return { ok: true, alreadyOut: true };
    const button = document.querySelector("#nav-leave-hunt"); if (!button) return { ok: false, error: "Botão para sair da caçada não encontrado" };
    button.click(); const closed = await waitFor("#nav-leave-hunt", 5000, false);
    return closed ? { ok: true } : { ok: false, error: "A caçada não terminou após o comando" };
  }

  async function openStore({ autoLeave = true } = {}) {
    if (visible(document.querySelector(".trade-window"))) return { ok: true, alreadyOpen: true };
    if (readState().inHunt && autoLeave) { const left = await leaveHunt(); if (!left.ok) return left; }
    if (readState().inHunt) return { ok: false, error: "Saia da caçada antes de abrir a loja" };
    const button = document.querySelector("#nav-store"); if (!button) return { ok: false, error: "Botão da loja não encontrado nesta tela" };
    button.click(); const shop = await waitFor(".trade-window", 5000, true);
    return shop ? { ok: true, alreadyOpen: false } : { ok: false, error: "A loja não abriu após o comando" };
  }

  async function sellItems() {
    const opened = await openStore({ autoLeave: true }); if (!opened.ok) return opened;
    const npcTab = [...document.querySelectorAll(".trade-tab")].find((tab) => tab.dataset.tab === "npc");
    if (!npcTab || npcTab.disabled) return { ok: true, sold: 0, auctionKept: 0, message: "Mercador indisponível nesta tela; loot foi preservado" };
    npcTab.click(); const shop = await waitFor(".shop-window", 3000, true); if (!shop) return { ok: false, error: "A aba do mercador não abriu" };
    const sellTab = [...shop.querySelectorAll(".tab")].find((tab) => /vender/i.test(tab.textContent || ""));
    if (!sellTab) return { ok: true, sold: 0, message: "A aba de venda ainda não foi carregada" };
    sellTab.click();
    const buttons = [...shop.querySelectorAll("button")].filter((button) => /vender|sell|confirmar/i.test(`${button.textContent} ${button.getAttribute("aria-label") || ""}`) && visible(button) && !button.disabled);
    let sold = 0;
    for (const button of buttons) { button.click(); sold += 1; await new Promise((resolve) => window.setTimeout(resolve, 120)); }
    return { ok: true, sold, auctionKept: 0 };
  }

  async function closeStore() {
    const close = document.querySelector("#trade-close") || document.querySelector(".trade-window #trade-close");
    if (!visible(document.querySelector(".trade-window"))) return { ok: true, alreadyClosed: true };
    if (!close) return { ok: false, error: "Botão para fechar a loja não encontrado" };
    close.click(); const closed = await waitFor(".trade-window", 3000, false);
    return closed ? { ok: true } : { ok: false, error: "A loja não fechou após o comando" };
  }

  globalThis.GamePilotAdapters = globalThis.GamePilotAdapters || {};
  globalThis.GamePilotAdapters.huntera = { key: "huntera", readState, startHunt, leaveHunt, openStore, sellItems, closeStore };
})();
