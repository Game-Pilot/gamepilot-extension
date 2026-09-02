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
    const match = text.match(new RegExp(`${label}\\s+([\\d.,]+)`, "i")); return match ? analyzerNumber(match[1]) : null;
  }

  function analyzerNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const raw = String(value).trim().replace(/[^\d,.-]/g, "");
    if (!raw) return null;
    if (raw.includes(",") && raw.includes(".")) return Number(raw.lastIndexOf(",") > raw.lastIndexOf(".") ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, ""));
    if (raw.includes(",")) {
      const groups = raw.split(",");
      if (groups.length > 1 && groups.slice(1).every((group) => /^\d{3}$/.test(group))) return Number(raw.replace(/,/g, ""));
      return Number(raw.replace(",", "."));
    }
    return Number(raw);
  }

  function analyzerMetric(text, dataValue, label) {
    const selector = '.hunt-analyzer-window [data-value="' + dataValue + '"], .analyzer-body [data-value="' + dataValue + '"]';
    const element = firstVisible(selector);
    return element ? analyzerNumber(element.textContent) : metric(text, label);
  }

  function readLootMetrics() {
    const text = firstVisible(".hunt-analyzer-window, .analyzer-body")?.innerText?.replace(/\s+/g, " ") || "";
    const metrics = {
      kills: analyzerMetric(text, "kills", "Inimigos mortos"), xpGained: analyzerMetric(text, "experience", "XP ganha"), goldEarned: analyzerMetric(text, "loot", "Gold"), goldSpent: analyzerMetric(text, "waste", "Gasto"),
      xpPerHour: analyzerMetric(text, "experience-hour", "XP/h"), goldPerHour: analyzerMetric(text, "loot-hour", "Gold/h"), spentPerHour: analyzerMetric(text, "waste-hour", "Gasto/h"), balancePerHour: analyzerMetric(text, "balance-hour", "Saldo/h")
    };
    const loot = [...document.querySelectorAll(".analyzer-item-row")].map((row) => ({ name: row.querySelector(".analyzer-item-name")?.textContent?.trim() || null, text: row.innerText.trim() })).filter((item) => item.name);
    return { ...metrics, loot };
  }

  function readBackpack() {
    const element = firstVisible(".hud-capacity"); if (!element) return null;
    const fill = element.querySelector(".fill"); const strong = element.querySelector("strong"); const title = strong?.getAttribute("title") || "";
    const capacity = title.match(/Carregando\s+([\d.]+)\s+de\s+([\d.]+)\s+oz/i);
    const percent = fill ? Number.parseFloat(fill.style.width) : null;
    return { percent: Number.isFinite(percent) ? Math.round(percent * 10) / 10 : null, currentOz: capacity ? number(capacity[1]) : number(strong?.textContent), maxOz: capacity ? number(capacity[2]) : null };
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
    const coinsElement = firstVisible("#header-coins .header-coins-count, [aria-label=\"Huntera Coins\"] .header-coins-count");
    const coins = analyzerNumber(coinsElement?.textContent);
    const experience = expMatch ? { current: number(expMatch[1]), max: number(expMatch[2]) } : null;
    if (experience?.current !== null && experience?.max) experience.percent = Math.round((experience.current / experience.max) * 1000) / 10;
    return {
      gameKey: "huntera", detected: Boolean(name), loggedIn: Boolean(name), page: location.pathname,
      inHunt: visible(document.querySelector("#nav-leave-hunt")), shopOpen: visible(document.querySelector(".trade-window")),
      premium: premiumOffer ? false : (document.querySelector(".analyzer-body") ? true : null),
      character: name ? { name, externalRef: name, vocation, level: levelMatch ? Number(levelMatch[1]) : null, premium: premiumOffer ? false : null } : null,
      resources: { health: bar(".hud-hp"), mana: bar(".hud-mp") },
      experience,
      stamina: firstVisible(".hud-stamina-clock")?.textContent?.trim() || null,
      gold: number(firstVisible("#header-gold")?.textContent), coins, backpack: readBackpack(), metrics: readLootMetrics(),
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

  function setSelectValue(select, value) {
    if (!select || !value || select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function closeActionEditor(editor) {
    const close = editor?.querySelector(".action-close");
    if (!close) return;
    close.click();
    await waitFor(".action-editor", 3000, false);
  }

  async function configureActionRule(rule) {
    const actionKey = String(rule?.actionKey || rule?.action_key || "").trim();
    if (!actionKey) return { ok: false, error: "Ação sem identificador" };
    const slots = [...document.querySelectorAll("button.hud-slot.assigned")].filter(visible);
    for (const slot of slots) {
      slot.click();
      const editor = await waitFor(".action-editor", 3000, true);
      if (!editor) continue;
      const selected = editor.querySelector(".action-choice.selected")?.dataset.actionId || null;
      if (selected !== actionKey) {
        await closeActionEditor(editor);
        continue;
      }

      const resource = rule.resource === "mana" ? "mana" : "health";
      setSelectValue(editor.querySelector(".condition-attribute"), resource);
      setSelectValue(editor.querySelector(".condition-operator"), rule.operator === "<" ? "<" : "<=");

      const valueInput = editor.querySelector(".condition-value");
      const desired = Math.max(1, Math.min(99, Number(rule.thresholdPercent ?? rule.threshold_percent) || 1));
      const current = Number(valueInput?.value || 0);
      const stepButton = desired >= current ? editor.querySelector(".condition-step-up") : editor.querySelector(".condition-step-down");
      const steps = Math.min(30, Math.ceil(Math.abs(desired - current) / 5));
      for (let index = 0; index < steps; index += 1) {
        stepButton?.click();
        await new Promise((resolve) => window.setTimeout(resolve, 18));
      }

      const conditionPercent = editor.querySelector('input[type="checkbox"]');
      if (conditionPercent && !conditionPercent.checked) conditionPercent.click();
      const enabledToggle = [...editor.querySelectorAll('input[type="checkbox"]')].at(-1);
      if (enabledToggle && enabledToggle.checked !== (rule.enabled !== false)) enabledToggle.click();
      editor.querySelector(".action-save")?.click();
      const saved = await waitFor(".action-editor", 3000, false);
      return saved ? { ok: true, actionKey, slot: slot.dataset.actionSlot } : { ok: false, error: `A ação ${actionKey} não confirmou o salvamento` };
    }
    return { ok: false, error: `A ação ${actionKey} não está atribuída à barra de ações do personagem` };
  }

  async function configureActions(rules = []) {
    const configured = [];
    for (const rule of Array.isArray(rules) ? rules.filter((item) => item?.enabled !== false || item?.actionKey || item?.action_key) : []) {
      const result = await configureActionRule(rule);
      if (!result.ok) return { ok: false, configured: configured.length, error: result.error };
      configured.push(result);
    }
    return { ok: true, configured: configured.length, actions: configured };
  }

  async function openHuntWindow() {
    if (visible(document.querySelector(".hunt-window"))) return { ok: true, alreadyOpen: true };
    const button = firstVisible("#nav-start-hunt");
    if (!button) return { ok: false, error: "Botão Caçar não encontrado nesta tela" };
    button.click();
    const opened = await waitFor(".hunt-window", 5000, true);
    return opened ? { ok: true } : { ok: false, error: "O seletor de caçadas não abriu" };
  }

  function matchesHunt(entry, target) {
    const normalizedTarget = String(target || "").trim().toLowerCase();
    if (!normalizedTarget) return false;
    if (entry.dataset.huntId === target) return true;
    const monster = entry.querySelector(".hunt-entry-monster")?.textContent?.trim().toLowerCase() || "";
    return monster === normalizedTarget;
  }

  function huntStarted() {
    if (visible(document.querySelector("#nav-leave-hunt"))) return true;
    const selected = [...document.querySelectorAll(".hunt-window .hunt-entry")].find((entry) => visible(entry) && entry.classList.contains("selected"));
    const startButton = firstVisible("#hunt-start");
    return Boolean(selected && startButton?.disabled && /trocar/i.test(startButton.textContent || ""));
  }

  function waitForHuntStarted(timeout = 12000) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        if (huntStarted()) return resolve(true);
        if (Date.now() - startedAt >= timeout) return resolve(false);
        window.setTimeout(check, 100);
      };
      check();
    });
  }

  async function startHunt(payload = {}) {
    if (readState().inHunt) return { ok: true, alreadyStarted: true };
    const hunt = payload.hunt || {};
    const target = hunt.spotKey || hunt.monsterKey;
    if (!target || target === "default") return { ok: false, error: "Nenhuma caçada foi selecionada" };
    const opened = await openHuntWindow();
    if (!opened.ok) return opened;
    const entry = [...document.querySelectorAll(".hunt-window .hunt-entry")].find((item) => visible(item) && matchesHunt(item, target));
    if (!entry) return { ok: false, error: `Caçada ${target} não encontrada no Huntera` };
    entry.click();
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    const tierName = String(hunt.pullTier || "Cauteloso").trim().toLowerCase();
    const tier = [...document.querySelectorAll(".hunt-window .hunt-tier")].find((item) => item.textContent.trim().toLowerCase() === tierName);
    if (tier) tier.click();
    const startButton = firstVisible("#hunt-start");
    if (!startButton) return { ok: false, error: "Botão para confirmar a caçada não encontrado" };
    startButton.click();
    const started = await waitForHuntStarted();
    return started ? { ok: true, huntId: entry.dataset.huntId, hunt: hunt.spotKey || hunt.monsterKey } : { ok: false, error: "A tela de caçada não confirmou o início" };
  }

  async function leaveHunt() {
    if (!readState().inHunt) return { ok: true, alreadyOut: true };
    const button = document.querySelector("#nav-leave-hunt"); if (!button) return { ok: false, error: "Botão para sair da caçada não encontrado" };
    button.click();
    const returned = await new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        if (!readState().inHunt) return resolve(true);
        if (Date.now() - startedAt >= 15000) return resolve(false);
        window.setTimeout(check, 100);
      };
      check();
    });
    return returned ? { ok: true } : { ok: false, error: "A caçada não terminou após o comando" };
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
  globalThis.GamePilotAdapters.huntera = { key: "huntera", readState, startHunt, configureActions, leaveHunt, openStore, sellItems, closeStore };
})();
