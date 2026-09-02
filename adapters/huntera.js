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
    const currentOz = capacity ? number(capacity[1]) : null;
    const maxOz = capacity ? number(capacity[2]) : null;
    const reportedPercent = fill ? Number.parseFloat(fill.style.width) : null;
    const calculatedPercent = Number.isFinite(currentOz) && Number.isFinite(maxOz) && maxOz > 0 ? (currentOz / maxOz) * 100 : null;
    const percent = calculatedPercent ?? reportedPercent;
    return {
      percent: Number.isFinite(percent) ? Math.round(percent * 10) / 10 : null,
      currentOz: currentOz ?? number(strong?.textContent),
      maxOz
    };
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
    const characterSelection = characterSelectionVisible();
    return {
      gameKey: "huntera", detected: Boolean(name), loggedIn: Boolean(name), page: location.pathname,
      inHunt: visible(document.querySelector("#nav-leave-hunt")), shopOpen: visible(document.querySelector(".trade-window")), characterSelection,
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

  function waitUntil(predicate, timeout = 5000, interval = 80) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        let matched = false;
        try { matched = Boolean(predicate()); } catch { matched = false; }
        if (matched) return resolve(true);
        if (Date.now() - startedAt >= timeout) return resolve(false);
        window.setTimeout(check, interval);
      };
      check();
    });
  }

  function normalizeItemName(value) {
    return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function itemKeyFromName(value) {
    return normalizeItemName(value).replace(/[\u0027\u2019]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function characterSelectionVisible() {
    const explicit = [
      "#character-selection", "#character-list", ".character-selection", ".character-select",
      ".characters-screen", "[data-screen=\"character-selection\"]", "[data-screen=\"characters\"]",
      "[data-page=\"characters\"]"
    ];
    if (explicit.some((selector) => [...document.querySelectorAll(selector)].some(visible))) return true;
    const text = document.body?.innerText?.replace(/\s+/g, " ") || "";
    return /(?:escolha|selecion(?:e|ar)|select|choose|pick)\s+(?:(?:um|a|seu|sua|your)\s+)?(?:personagem|character)/i.test(text)
      || /(?:personagens|characters)\s+(?:dispon[ií]veis|available)/i.test(text);
  }

  function characterCandidate(characterName) {
    const target = normalizeItemName(characterName);
    if (!target) return null;
    const selectors = "button, a, [role=\"button\"], [data-character-id], [data-character-name], [class*=\"character\"], li";
    const candidates = [...document.querySelectorAll(selectors)].filter(visible).map((element) => {
      const labels = [
        element.dataset.characterName, element.dataset.name, element.getAttribute("aria-label"), element.textContent
      ].filter(Boolean).map(normalizeItemName);
      const exactAttribute = [element.dataset.characterName, element.dataset.name].filter(Boolean).some((label) => normalizeItemName(label) === target);
      const exactText = labels.some((label) => label === target);
      const escaped = target.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      const contains = labels.some((label) => new RegExp("(^|\\s)" + escaped + "(\\s|$)", "i").test(label));
      if (!exactAttribute && !exactText && !contains) return null;
      const clickTarget = element.matches("button, a, [role=\"button\"]") ? element : element.querySelector("button, a, [role=\"button\"]") || element;
      return { element: clickTarget, score: exactAttribute ? 0 : exactText ? 1 : 2, length: element.textContent?.trim().length || 0 };
    }).filter(Boolean).sort((left, right) => left.score - right.score || left.length - right.length);
    return candidates[0]?.element || null;
  }

  async function selectCharacter(characterName) {
    if (!characterSelectionVisible()) return { ok: true, alreadySelected: true };
    const target = normalizeItemName(characterName);
    if (!target) return { ok: false, error: "Personagem da reconexão não identificado" };
    const candidate = characterCandidate(characterName);
    if (!candidate) return { ok: false, error: "Personagem " + characterName + " não encontrado na tela de seleção" };
    candidate.click();
    const loaded = await waitUntil(() => {
      const state = readState();
      return state.detected && normalizeItemName(state.character?.name) === target && !characterSelectionVisible()
        && Boolean(firstVisible("#nav-start-hunt") || firstVisible(".hud-slot"));
    }, 15000, 120);
    return loaded ? { ok: true, character: characterName } : { ok: false, error: "O Huntera não carregou o personagem " + characterName };
  }

  async function configureLoot(hunt = {}) {
    await waitUntil(() => document.querySelectorAll(".hunt-window .hunt-loot-auto").length > 0, 1500);
    const controls = [...document.querySelectorAll(".hunt-window .hunt-loot-auto")].filter((control) => !control.disabled && visible(control.closest(".hunt-loot-entry")));
    if (!controls.length) return { ok: true, configured: 0, changed: 0 };
    const keys = new Set((Array.isArray(hunt.lootItemKeys) ? hunt.lootItemKeys : []).map((key) => String(key)));
    const configured = hunt.lootConfigured === true || keys.size > 0;
    let changed = 0;
    for (const control of controls) {
      const entry = control.closest(".hunt-loot-entry");
      const name = entry?.querySelector(".hunt-loot-name")?.textContent?.trim() || "";
      const baseKey = itemKeyFromName(name);
      const itemId = control.dataset.itemId || entry?.dataset.itemId || "";
      const variantKey = itemId ? `${baseKey}-${itemId}` : baseKey;
      const desired = configured ? (keys.has(baseKey) || keys.has(variantKey)) : true;
      if (control.checked !== desired) { control.click(); changed += 1; }
    }
    return { ok: true, configured: controls.length, changed };
  }

  function tierName(element) {
    return normalizeItemName(element?.dataset.pullTier || element?.textContent || "");
  }

  const PULL_TIER_ALIASES = {
    cauteloso: ["cauteloso", "cautious"],
    ousado: ["ousado", "bold"],
    agressivo: ["agressivo", "aggressive", "reckless"],
    suicida: ["suicida", "suicidal", "suicide"]
  };

  function tierMatches(element, requested) {
    const aliases = PULL_TIER_ALIASES[requested] || [requested];
    return aliases.includes(tierName(element));
  }

  function tierSelected(element) {
    return element?.classList.contains("selected") || element?.classList.contains("active") || element?.getAttribute("aria-pressed") === "true" || element?.getAttribute("data-selected") === "true";
  }

  async function selectPullTier(value) {
    const requested = normalizeItemName(value || "Cauteloso");
    const tiers = [...document.querySelectorAll(".hunt-window .hunt-tier")].filter(visible);
    const tier = tiers.find((item) => tierMatches(item, requested));
    if (!tier) return { ok: false, error: `Pull ${value || "Cauteloso"} não está disponível para esta caçada` };
    if (!tierSelected(tier)) {
      tier.click();
      const applied = await waitUntil(() => {
        const selected = [...document.querySelectorAll(".hunt-window .hunt-tier")].filter(visible).find(tierSelected);
        return Boolean(selected && tierMatches(selected, requested));
      }, 1800, 80);
      if (!applied) return { ok: false, error: `O Huntera não confirmou o pull ${value || "Cauteloso"}` };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    return { ok: true, tier: value || "Cauteloso" };
  }

  function setSearchValue(input, value) {
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
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
    await waitUntil(() => document.querySelectorAll("button.hud-slot.assigned").some(visible), 5000, 100);
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
    const hunt = payload.hunt || {};
    if (characterSelectionVisible()) {
      const selected = await selectCharacter(payload.characterName || payload.character_name || payload.character?.name);
      if (!selected.ok) return selected;
    }
    if (readState().inHunt) return { ok: true, alreadyStarted: true };
    const target = hunt.spotKey || hunt.monsterKey;
    if (!target || target === "default") return { ok: false, error: "Nenhuma caçada foi selecionada" };
    const opened = await openHuntWindow();
    if (!opened.ok) return opened;
    const entry = [...document.querySelectorAll(".hunt-window .hunt-entry")].find((item) => visible(item) && matchesHunt(item, target));
    if (!entry) return { ok: false, error: `Caçada ${target} não encontrada no Huntera` };
    entry.click();
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    const pull = await selectPullTier(hunt.pullTier);
    if (!pull.ok) return pull;
    const loot = await configureLoot(hunt);
    if (!loot.ok) return loot;
    const startButton = firstVisible("#hunt-start");
    if (!startButton) return { ok: false, error: "Botão para confirmar a caçada não encontrado" };
    startButton.click();
    const started = await waitForHuntStarted();
    return started ? { ok: true, huntId: entry.dataset.huntId, hunt: hunt.spotKey || hunt.monsterKey, pull, loot } : { ok: false, error: "A tela de caçada não confirmou o início" };
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

  function readNpcSellOffers(shop) {
    return [...shop.querySelectorAll("#shop-offers .shop-offer")].filter(visible).map((offer) => {
      const label = offer.getAttribute("aria-label") || "";
      const match = label.match(/^(.+),\s*([\d.,]+)\s+gp\s+cada$/i);
      const npcValue = match ? number(match[2]) : null;
      return {
        itemId: offer.dataset.itemId || null,
        name: match?.[1]?.trim() || label.split(",")[0]?.trim() || null,
        npcValue,
        count: Number(offer.querySelector(".shop-count")?.textContent || 1) || 1,
        element: offer
      };
    }).filter((item) => item.itemId && item.name && Number.isFinite(item.npcValue));
  }

  function readMarketPrices(blockSelector) {
    const block = firstVisible(blockSelector);
    if (!block) return [];
    return [...block.querySelectorAll("tbody tr")].filter(visible).map((row) => {
      const cells = [...row.querySelectorAll("td")];
      const price = number(cells[2]?.textContent?.trim());
      return Number.isFinite(price) ? price : null;
    }).filter((price) => price !== null);
  }

  async function readAuctionQuote(market, item) {
    const search = market.querySelector("#market-search");
    setSearchValue(search, item.name);
    const itemReady = await waitUntil(() => [...market.querySelectorAll(".market-item")].some((entry) => entry.dataset.marketItem === item.itemId || normalizeItemName(entry.querySelector(".market-item-name")?.textContent) === normalizeItemName(item.name)), 2500);
    if (!itemReady) return { itemId: item.itemId, name: item.name, buyPrices: [], sellPrices: [], found: false };
    const marketItem = [...market.querySelectorAll(".market-item")].find((entry) => entry.dataset.marketItem === item.itemId || normalizeItemName(entry.querySelector(".market-item-name")?.textContent) === normalizeItemName(item.name));
    if (!marketItem) return { itemId: item.itemId, name: item.name, buyPrices: [], sellPrices: [], found: false };
    marketItem.click();
    await waitUntil(() => normalizeItemName(firstVisible(".market-listing-head strong")?.textContent) === normalizeItemName(item.name), 2500);
    return { itemId: item.itemId, name: item.name, buyPrices: readMarketPrices(".market-offers-block.buy"), sellPrices: readMarketPrices(".market-offers-block.sell"), found: true };
  }

  async function readAuctionQuotes(items) {
    const auctionTab = [...document.querySelectorAll(".trade-tab")].find((tab) => tab.dataset.tab === "auction" && visible(tab));
    if (!auctionTab) return { ok: false, error: "A aba do leilão não está disponível", quotes: [] };
    auctionTab.click();
    const market = await waitFor(".market-window", 5000, true);
    if (!market) return { ok: false, error: "A casa de leilões não abriu", quotes: [] };
    const ownedFilter = market.querySelector('input[name="market-list-filter"][value="owned"]');
    if (ownedFilter && !ownedFilter.checked) {
      ownedFilter.click();
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    }
    const quotes = [];
    for (const item of items) quotes.push(await readAuctionQuote(market, item));
    return { ok: true, quotes };
  }

  function auctionDecision(item, quote, config = {}) {
    if (config.preserveAuctionItems === false) return { preserve: false, reason: "preservação desativada" };
    const mode = ["buy", "sell", "both"].includes(config.auctionPriceMode) ? config.auctionPriceMode : "buy";
    const buyThreshold = Math.max(0, Number(config.auctionBuyThresholdPercent ?? 50));
    const sellThreshold = Math.max(0, Number(config.auctionSellThresholdPercent ?? 50));
    const noBuyPolicy = config.auctionNoBuyOrderPolicy === "npc" ? "npc" : "preserve";
    const buyPrice = quote.buyPrices.length ? Math.max(...quote.buyPrices) : null;
    const sellPrice = quote.sellPrices.length ? Math.min(...quote.sellPrices) : null;
    const buyPass = buyPrice !== null ? buyPrice >= item.npcValue * (1 + buyThreshold / 100) : noBuyPolicy === "preserve";
    const sellPass = sellPrice !== null && sellPrice >= item.npcValue * (1 + sellThreshold / 100);
    const preserve = mode === "sell" ? sellPass : mode === "both" ? buyPass && sellPass : buyPass;
    if (!quote.found) {
      const preserve = mode === "sell" ? false : noBuyPolicy === "preserve";
      return { preserve, reason: mode === "sell" ? "item sem oferta de venda" : preserve ? "item não apareceu nos itens possuídos do leilão" : "item sem registro no leilão", buyPrice, sellPrice };
    }
    if (mode === "buy" && buyPrice === null) return { preserve: noBuyPolicy === "preserve", reason: noBuyPolicy === "preserve" ? "sem ordem de compra" : "sem ordem de compra; vender no NPC", buyPrice, sellPrice };
    if (mode === "sell" && sellPrice === null) return { preserve: false, reason: "sem oferta de venda", buyPrice, sellPrice };
    if (mode === "both" && (!buyPass || !sellPass)) return { preserve: false, reason: "ambos os critérios não atingidos", buyPrice, sellPrice };
    return { preserve, reason: preserve ? `margem de ${mode === "sell" ? sellThreshold : buyThreshold}% atingida` : "valor abaixo da margem configurada", buyPrice, sellPrice };
  }

  async function sellNpcItems(shop, items) {
    let sold = 0;
    const soldItems = [];
    for (const item of items.filter((entry) => !entry.preserve)) {
      const offer = [...shop.querySelectorAll("#shop-offers .shop-offer")].find((entry) => entry.dataset.itemId === item.itemId && visible(entry));
      if (!offer) continue;
      offer.click();
      const transaction = await waitFor("#shop-transaction", 2500, true);
      const sellButton = transaction?.querySelector(".shop-buy");
      if (!sellButton || !visible(sellButton) || sellButton.disabled) continue;
      sellButton.click();
      await new Promise((resolve) => window.setTimeout(resolve, 220));
      sold += 1;
      soldItems.push({ itemId: item.itemId, name: item.name, count: item.count, npcValue: item.npcValue });
    }
    return { sold, soldItems };
  }

  async function sellItems(config = {}) {
    const opened = await openStore({ autoLeave: true }); if (!opened.ok) return opened;
    const npcTab = [...document.querySelectorAll(".trade-tab")].find((tab) => tab.dataset.tab === "npc");
    if (!npcTab || npcTab.disabled) return { ok: true, sold: 0, auctionKept: 0, message: "Mercador indisponível nesta tela; loot foi preservado" };
    npcTab.click(); const shop = await waitFor(".shop-window", 3000, true); if (!shop) return { ok: false, error: "A aba do mercador não abriu" };
    const sellTab = [...shop.querySelectorAll(".tab")].find((tab) => /vender/i.test(tab.textContent || ""));
    if (!sellTab) return { ok: true, sold: 0, message: "A aba de venda ainda não foi carregada" };
    sellTab.click();
    await waitFor("#shop-offers .shop-offer", 3000, true);
    const npcOffers = readNpcSellOffers(shop);
    if (!npcOffers.length) return { ok: true, sold: 0, auctionKept: 0, message: "Nenhum item disponível para venda" };
    let decisions = npcOffers.map((item) => ({ ...item, preserve: false, reason: "preservação desativada" }));
    let auctionChecked = 0;
    if (config.preserveAuctionItems !== false) {
      const auction = await readAuctionQuotes(npcOffers);
      if (auction.ok) {
        const quotes = new Map(auction.quotes.map((quote) => [quote.itemId, quote]));
        decisions = npcOffers.map((item) => ({ ...item, ...auctionDecision(item, quotes.get(item.itemId) || { buyPrices: [], sellPrices: [], found: false }, config) }));
        auctionChecked = auction.quotes.filter((quote) => quote.found).length;
      } else {
        decisions = npcOffers.map((item) => ({ ...item, preserve: true, reason: auction.error }));
      }
      const npcTabAfterAuction = [...document.querySelectorAll(".trade-tab")].find((tab) => tab.dataset.tab === "npc" && visible(tab));
      npcTabAfterAuction?.click();
      await waitFor(".shop-window", 3000, true);
      const sellTabAfterAuction = [...document.querySelectorAll(".shop-window .tab")].find((tab) => /vender/i.test(tab.textContent || ""));
      sellTabAfterAuction?.click();
      await waitFor("#shop-offers .shop-offer", 3000, true);
    }
    const result = await sellNpcItems(shop, decisions);
    const kept = decisions.filter((item) => item.preserve);
    const message = config.preserveAuctionItems === false
      ? `Venda concluída: ${result.sold} item(ns)`
      : `Leilão consultado para ${auctionChecked} item(ns); ${result.sold} vendido(s) no NPC e ${kept.length} preservado(s)`;
    return { ok: true, ...result, auctionChecked, auctionKept: kept.length, auctionItems: kept.map(({ element, ...item }) => item), decisions: decisions.map(({ element, ...item }) => item), message };
  }

  async function closeStore() {
    const close = document.querySelector("#trade-close") || document.querySelector(".trade-window #trade-close");
    if (!visible(document.querySelector(".trade-window"))) return { ok: true, alreadyClosed: true };
    if (!close) return { ok: false, error: "Botão para fechar a loja não encontrado" };
    close.click(); const closed = await waitFor(".trade-window", 3000, false);
    return closed ? { ok: true } : { ok: false, error: "A loja não fechou após o comando" };
  }

  globalThis.GamePilotAdapters = globalThis.GamePilotAdapters || {};
  globalThis.GamePilotAdapters.huntera = { key: "huntera", readState, startHunt, configureActions, leaveHunt, openStore, sellItems, closeStore, selectCharacter };
})();
