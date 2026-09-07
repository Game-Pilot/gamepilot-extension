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

  const socketState = {
    connected: false,
    socketUrl: null,
    lastMessageAt: null,
    lastMessageType: null,
    phase: null,
    playerStats: null,
    inventory: null,
    analyzer: null,
    coins: null,
    huntPending: null,
    huntLeavePending: null,
    actionBar: null,
    itemValues: null,
    marketItems: null,
    bestiary: null,
    bestiaryKills: {},
    bestiaryStages: {},
    bestiaryCatalog: [],
    bestiaryReceived: false,
    bestiaryFullSnapshot: false,
    training: null,
    messages: {}
  };

  function firstNumber(...values) {
    for (const value of values) {
      const parsed = Number(value);
      if (value !== null && value !== undefined && value !== "" && Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function timestampMs(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : null;
  }

  function socketFresh(maxAge = 12000) {
    const last = Date.parse(socketState.lastMessageAt || "");
    return socketState.connected && Number.isFinite(last) && Date.now() - last <= maxAge;
  }

  function copyInventory(payload) {
    return {
      slots: Array.isArray(payload?.slots) ? payload.slots.slice() : [],
      satchel: Array.isArray(payload?.satchel) ? payload.satchel.slice() : [],
      equipment: payload?.equipment && typeof payload.equipment === "object" ? { ...payload.equipment } : {},
      gold: firstNumber(payload?.gold)
    };
  }

  function applyInventoryDelta(payload) {
    if (!socketState.inventory) return;
    const inventory = copyInventory(socketState.inventory);
    const slotCount = firstNumber(payload?.slotCount);
    const satchelCount = firstNumber(payload?.satchelCount);
    if (slotCount !== null) inventory.slots = inventory.slots.slice(0, slotCount);
    if (satchelCount !== null) inventory.satchel = inventory.satchel.slice(0, satchelCount);
    for (const change of Array.isArray(payload?.changes) ? payload.changes : []) {
      if (change.container === "backpack" && Number.isInteger(Number(change.index)) && Number(change.index) >= 0) inventory.slots[Number(change.index)] = change.item || null;
      else if (change.container === "satchel" && Number.isInteger(Number(change.index)) && Number(change.index) >= 0) inventory.satchel[Number(change.index)] = change.item || null;
      else if (change.slot) inventory.equipment[change.slot] = change.item || null;
    }
    inventory.gold = firstNumber(payload?.gold, inventory.gold);
    socketState.inventory = inventory;
  }

  function applySocketMessage(message) {
    if (!message?.type) return;
    socketState.lastMessageAt = message.receivedAt || new Date().toISOString();
    socketState.lastMessageType = message.type;
    socketState.messages[message.type] = message.payload || {};
    const payload = message.payload || {};
    switch (message.type) {
      case "player-stats":
        socketState.playerStats = payload;
        if (Number(payload.huntSessionRemainingMs) > 0 && socketState.phase !== "returning") socketState.phase = "hunting";
        if (Number(payload.huntSessionRemainingMs) === 0 && socketState.phase !== "starting") socketState.phase = "idle";
        break;
      case "player-inventory": socketState.inventory = copyInventory(payload); break;
      case "inventory-delta": applyInventoryDelta(payload); break;
      case "hunt-analyzer-update":
        socketState.analyzer = payload;
        if (Number(socketState.playerStats?.huntSessionRemainingMs) > 0 && socketState.phase !== "returning") socketState.phase = "hunting";
        break;
      case "hunt-analyzer-session": socketState.analyzer = { ...(socketState.analyzer || {}), ...payload }; break;
      case "coins": socketState.coins = firstNumber(payload.balance); break;
      case "hunt-pending": socketState.huntPending = payload; socketState.phase = "starting"; break;
      case "hunt-leave-pending": socketState.huntLeavePending = payload; socketState.phase = payload.remainingMs === null ? "idle" : "returning"; break;
      case "instance-enter": socketState.phase = "hunting"; break;
      case "player-died": socketState.phase = "idle"; break;
      case "action-bar-update": socketState.actionBar = payload; break;
      case "bestiary-progress": {
        // wire-9: the server's live per-creature kill feed, e.g.
        // { kills: { spider: 180 }, killsRequired: 2500, completed: 1, total: 86 }.
        // The analyzer metric is premium-locked to 0, so this is the only real
        // source of bestiary kill counts. `kills` names the creature just killed
        // with its absolute total.
        const payloadKills = payload && typeof payload.kills === "object" ? payload.kills : {};
        const payloadKeys = Object.keys(payloadKills);
        socketState.bestiaryKills = { ...socketState.bestiaryKills, ...payloadKills };
        socketState.bestiaryStages = { ...socketState.bestiaryStages, ...(payload?.stages || {}) };
        socketState.bestiaryReceived = true;
        const expectedEntries = firstNumber(payload?.total) ?? socketState.bestiaryCatalog.length;
        if (expectedEntries > 0 && payloadKeys.length >= expectedEntries) socketState.bestiaryFullSnapshot = true;
        const entries = Object.entries(payloadKills);
        const monsterKey = payload.latestMonsterKey || entries[entries.length - 1]?.[0];
        const killCount = monsterKey ? payload.kills?.[monsterKey] : null;
        if (monsterKey) {
          const progress = bestiaryStageProgress(
            firstNumber(payload.killsRequired) ?? 2500,
            firstNumber(killCount),
            firstNumber(socketState.bestiaryStages[monsterKey]) ?? 0
          );
          socketState.bestiary = {
            monsterKey,
            killCount: progress?.currentKills ?? firstNumber(killCount),
            absoluteKillCount: firstNumber(killCount),
            killsRequired: progress?.targetKills ?? firstNumber(payload.killsRequired) ?? 2500,
            baseKillsRequired: firstNumber(payload.killsRequired) ?? 2500,
            stage: progress?.stage ?? 0,
            phase: progress?.phase ?? 1,
            completedPhases: progress?.completedPhases ?? 0,
            rewardReady: progress?.rewardReady === true,
            completed: firstNumber(payload.completed),
            total: firstNumber(payload.total),
            at: socketState.lastMessageAt
          };
        }
        break;
      }
      case "cyclopedia-catalog":
        socketState.bestiaryCatalog = Array.isArray(payload.monsters) ? payload.monsters : [];
        break;
      case "training-update":
        // wire-96 is independent from hunts/bestiary. Huntera keeps training
        // active while the character remains in the training ground and sends
        // `{ active: false }` when it stops. Never infer training merely from
        // the presence of this cached message: only the explicit active flag is
        // authoritative.
        socketState.training = {
          active: payload.active === true,
          skill: payload.active === true && typeof payload.skill === "string" ? payload.skill : null,
          etaMs: payload.active === true ? Math.max(0, firstNumber(payload.etaMs) ?? 0) : 0,
          at: socketState.lastMessageAt
        };
        break;
      case "item-values": socketState.itemValues = payload; break;
      case "market-items": socketState.marketItems = payload; break;
      default: break;
    }
  }

  function applySocketSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    socketState.connected = Boolean(snapshot.connected);
    socketState.socketUrl = snapshot.socketUrl || socketState.socketUrl;
    for (const message of Object.values(snapshot.messages || {}).sort((left, right) => Date.parse(left?.receivedAt || "") - Date.parse(right?.receivedAt || ""))) applySocketMessage(message);
  }

  function socketBackpack() {
    const inventory = socketState.inventory;
    const capacity = firstNumber(socketState.playerStats?.capacity);
    if (!inventory || capacity === null || capacity <= 0) return null;
    const items = [...inventory.slots, ...inventory.satchel, ...Object.values(inventory.equipment || {})].filter(Boolean);
    const weighted = items.filter((item) => Number.isFinite(Number(item.weight)));
    if (weighted.length !== items.length) return null;
    const current = weighted.reduce((total, item) => total + Number(item.weight) * Math.max(1, Number(item.count ?? item.quantity ?? 1)), 0);
    const percent = Math.max(0, Math.min(100, (current / capacity) * 100));
    return { percent: Math.round(percent * 10) / 10, currentOz: Math.round((current / 100) * 100) / 100, maxOz: Math.round((capacity / 100) * 100) / 100, source: "socket" };
  }

  function socketMetrics() {
    const analyzer = socketState.analyzer;
    if (!analyzer) return {};
    const experience = firstNumber(analyzer.experience, analyzer.xpGained, analyzer.experienceGained);
    const lootValue = firstNumber(analyzer.lootValue, analyzer.loot, analyzer.goldEarned);
    const waste = firstNumber(analyzer.waste, analyzer.goldSpent);
    const kills = firstNumber(analyzer.kills, analyzer.monsters, analyzer.monstersKilled, analyzer.creaturesKilled);
    const startedAt = timestampMs(analyzer.startedAt);
    const durationMs = firstNumber(analyzer.durationMs) || (startedAt ? Math.max(0, Date.now() - startedAt) : null);
    const multiplier = durationMs > 0 ? 3600000 / durationMs : null;
    return {
      ...(kills === null ? {} : { kills }),
      ...(experience === null ? {} : { xpGained: experience }),
      ...(lootValue === null ? {} : { goldEarned: lootValue }),
      ...(waste === null ? {} : { goldSpent: waste }),
      ...(multiplier === null || experience === null ? {} : { xpPerHour: Math.round(experience * multiplier) }),
      ...(multiplier === null || lootValue === null ? {} : { goldPerHour: Math.round(lootValue * multiplier) }),
      ...(multiplier === null || lootValue === null || waste === null ? {} : { balancePerHour: Math.round((lootValue - waste) * multiplier) })
    };
  }

  function socketStamina() {
    const milliseconds = firstNumber(socketState.playerStats?.staminaMs);
    if (milliseconds === null) return null;
    const minutes = Math.max(0, Math.round(milliseconds / 60000));
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}h`;
  }

  function socketTraining() {
    const training = socketState.training;
    if (!socketFresh() || training?.active !== true) return { active: false };
    const stats = socketState.playerStats;
    const skill = training.skill;
    const progress = skill === "magic"
      ? firstNumber(stats?.magicProgress)
      : firstNumber(stats?.skillProgress?.[skill]);
    const progressNeeded = skill === "magic"
      ? firstNumber(stats?.magicProgressNeeded)
      : firstNumber(stats?.skillProgressNeeded?.[skill]);
    const percent = progress !== null && progressNeeded !== null && progressNeeded > 0
      ? Math.max(0, Math.min(100, Math.round((progress / progressNeeded) * 1000) / 10))
      : null;
    return {
      active: true,
      skill,
      etaMs: training.etaMs,
      progress,
      progressNeeded,
      percent,
      observedAt: training.at
    };
  }

  function socketInHunt() {
    if (!socketFresh() || !socketState.playerStats) return null;
    if (socketState.phase === "hunting" || socketState.phase === "returning") return true;
    if (socketState.phase === "idle") return false;
    const sessionMs = firstNumber(socketState.playerStats.huntSessionRemainingMs);
    return sessionMs === null ? null : sessionMs > 0;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "gamepilot-huntera-socket") return;
    if (event.data.kind === "message") applySocketMessage(event.data.message);
    else if (event.data.kind === "connection") {
      socketState.connected = event.data.status === "open";
      if (socketState.connected) {
        socketState.socketUrl = event.data.socketUrl || socketState.socketUrl;
        socketState.bestiary = null;
        socketState.bestiaryKills = {};
        socketState.bestiaryStages = {};
        socketState.bestiaryCatalog = [];
        socketState.bestiaryReceived = false;
        socketState.bestiaryFullSnapshot = false;
      }
    }
    else if (event.data.kind === "snapshot") applySocketSnapshot(event.data.snapshot);
  });
  window.postMessage({ source: "gamepilot-huntera-content", type: "socket-snapshot-request" }, "*");

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
    const socketStats = socketState.playerStats;
    const socketHealth = socketStats ? { current: firstNumber(socketStats.health), max: firstNumber(socketStats.maxHealth) } : null;
    const socketMana = socketStats ? { current: firstNumber(socketStats.mana), max: firstNumber(socketStats.maxMana) } : null;
    for (const resource of [socketHealth, socketMana]) {
      if (resource?.current !== null && resource?.max) resource.percent = Math.round((resource.current / resource.max) * 1000) / 10;
    }
    const domExperience = expMatch ? { current: number(expMatch[1]), max: number(expMatch[2]) } : null;
    const socketExperience = socketStats ? { current: firstNumber(socketStats.experience), max: firstNumber(socketStats.experienceNeeded) } : null;
    const experience = socketExperience?.current !== null && socketExperience?.max ? socketExperience : domExperience;
    if (experience?.current !== null && experience?.max) experience.percent = Math.round((experience.current / experience.max) * 1000) / 10;
    const characterSelection = characterSelectionVisible();
    const domInHunt = visible(document.querySelector("#nav-leave-hunt"));
    const socketHunt = socketInHunt();
    const socketInventory = socketState.inventory;
    const socketGold = firstNumber(socketInventory?.gold);
    const socketCoins = firstNumber(socketState.coins);
    const socketMetricsValue = socketMetrics();
    const backpack = socketFresh() ? (socketBackpack() || readBackpack()) : readBackpack();
    const level = levelMatch ? Number(levelMatch[1]) : null;
    const party = readPartyState();
    return {
      gameKey: "huntera", detected: Boolean(name), loggedIn: Boolean(name), page: location.pathname,
      inHunt: domInHunt ? true : (inTown() ? false : (socketHunt ?? false)), inTown: inTown(), shopOpen: visible(document.querySelector(".trade-window")), characterSelection,
      premium: premiumOffer ? false : (document.querySelector(".analyzer-body") ? true : null),
      character: name ? {
        name, externalRef: name, vocation, level, premium: premiumOffer ? false : null,
        shareExperience: level ? { min: Math.ceil(level * 2 / 3), max: Math.floor(level * 3 / 2) } : null
      } : null,
      resources: { health: socketHealth?.current !== null && socketHealth?.max ? socketHealth : bar(".hud-hp"), mana: socketMana?.current !== null && socketMana?.max ? socketMana : bar(".hud-mp") },
      experience,
      stamina: socketStamina() || firstVisible(".hud-stamina-clock")?.textContent?.trim() || null,
      staminaMs: firstNumber(socketStats?.staminaMs), staminaDraining: socketStats?.staminaDraining ?? null,
      huntSessionRemainingMs: firstNumber(socketStats?.huntSessionRemainingMs),
      gold: socketGold ?? number(firstVisible("#header-gold")?.textContent), coins: socketCoins ?? analyzerNumber(coinsElement?.textContent),
      backpack, metrics: { ...readLootMetrics(), ...socketMetricsValue },
      bestiaryLive: socketFresh() ? socketState.bestiary : null,
      training: socketTraining(),
      party,
      target: { name: firstVisible(".target-name, .hud-target-name")?.textContent?.trim() || null, strategy: party.targetStrategy, label: party.targetLabel },
      socket: {
        connected: socketState.connected,
        fresh: socketFresh(),
        url: socketState.socketUrl,
        lastMessageAt: socketState.lastMessageAt,
        lastMessageType: socketState.lastMessageType,
        phase: socketState.phase
      }
    };
  }

  let cancellationRevision = 0;
  function cancelPending() { cancellationRevision += 1; }

  function waitFor(selector, timeout = 5000, expectedVisible = true) {
    const revision = cancellationRevision;
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        if (revision !== cancellationRevision) return reject(new Error("Operação cancelada pelo usuário"));
        const element = document.querySelector(selector);
        if (expectedVisible === visible(element)) return resolve(element);
        if (Date.now() - startedAt >= timeout) return resolve(null);
        window.setTimeout(check, 100);
      };
      check();
    });
  }

  function waitUntil(predicate, timeout = 5000, interval = 80) {
    const revision = cancellationRevision;
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        if (revision !== cancellationRevision) return reject(new Error("Operação cancelada pelo usuário"));
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

  function setControlValue(control, value) {
    if (!control) return;
    const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(control, value);
    else control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function readPartyState() {
    const nav = document.querySelector("#nav-party");
    const rows = [...document.querySelectorAll(".party-window .party-member")];
    const members = rows.map((row) => ({
      name: row.querySelector(".party-name")?.textContent?.trim() || null,
      leader: Boolean(row.querySelector(".party-leader"))
    })).filter((member) => member.name);
    const costsState = document.querySelector(".party-window .party-costs-state")?.textContent?.trim() || "";
    const sharedCosts = [...document.querySelectorAll(".party-window .party-costs-stop")].some(visible)
      || /(?:rateio|cost sharing).*(?:ativ|active)|(?:ativ|active).*(?:rateio|cost sharing)/i.test(normalizeItemName(costsState));
    const target = document.querySelector(".hud-target-strategy");
    const selectedOption = target?.selectedOptions?.[0] || target?.querySelector(`option[value="${CSS.escape(target?.value || "")}"]`);
    return {
      active: visible(nav) || members.length > 0,
      members,
      leaderName: members.find((member) => member.leader)?.name || null,
      sharedCosts,
      sharedCostsPending: /aguard|waiting|pend/i.test(normalizeItemName(costsState)),
      targetStrategy: target?.value || null,
      targetLabel: selectedOption?.textContent?.trim() || null
    };
  }

  function inviteCards() {
    return [...document.querySelectorAll(".party-invite")].filter(visible);
  }

  function findInviteCard(kind, senderName = null) {
    return inviteCards().find((card) => {
      // Names and member descriptions are not invitation types (IACosta contains "cost").
      const text = normalizeItemName(card.querySelector(".invite-title")?.textContent || card.getAttribute("aria-label") || "");
      if (senderName) {
        const message = normalizeItemName(card.querySelector(".invite-msg")?.textContent || "");
        const sender = normalizeItemName(senderName);
        const actualSender = message.match(/^(.+?)\s+(?:invites|convida|convidou|proposes|propoe)\b/)?.[1];
        if (actualSender !== sender) return false;
      }
      const huntIcon = Boolean(card.querySelector('img[src*="/assets/nav/hunt.png"]'));
      if (kind === "team") return huntIcon || /team hunt invitation|convite.*cacada.*(?:grupo|time)/.test(text);
      if (kind === "follow") return /follow party leader|seguir.*(?:lider|puxador)/.test(text);
      if (kind === "costs") return /hunt cost sharing|rateio da hunt|rateio.*cust|compartilh.*cust|custos.*cacada/.test(text);
      if (kind === "experience-warning") return /shared experience warning|experiencia compartilhada|compartilhar exp/.test(text);
      if (kind === "party") return !huntIcon && /^(party invitation|convite.*(?:party|grupo))$/.test(text);
      return false;
    }) || null;
  }

  function clickInviteAction(card, accept = true) {
    const buttons = [...(card?.querySelectorAll(".invite-actions button") || [])].filter(visible);
    const button = buttons[accept ? 0 : 1];
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }

  function friendEntry(characterName) {
    const target = normalizeItemName(characterName);
    return [...document.querySelectorAll(".friends-window .friends-entry")].find((row) => normalizeItemName(row.querySelector(".friends-name")?.textContent) === target) || null;
  }

  async function openFriendsWindow() {
    if (visible(document.querySelector(".friends-window"))) return { ok: true, alreadyOpen: true };
    const button = firstVisible("#nav-friends");
    if (!button || !visible(button)) return { ok: false, error: "A lista de amigos não está disponível" };
    button.click();
    return await waitFor(".friends-window", 5000, true) ? { ok: true } : { ok: false, error: "A lista de amigos não abriu" };
  }

  async function openPartyWindow() {
    if (visible(document.querySelector(".party-window"))) return { ok: true, alreadyOpen: true };
    const button = document.querySelector("#nav-party");
    if (!button || !visible(button)) return { ok: false, error: "A party ainda não foi formada" };
    button.click();
    return await waitFor(".party-window", 5000, true) ? { ok: true } : { ok: false, error: "A janela da party não abriu" };
  }

  async function ensureFriend(characterName) {
    const opened = await openFriendsWindow();
    if (!opened.ok) return opened;
    let row = friendEntry(characterName);
    if (!row) {
      const form = document.querySelector(".friends-window .friends-search");
      const input = form?.querySelector("input");
      if (!form || !input) return { ok: false, error: `Não foi possível buscar ${characterName} na lista de amigos` };
      setControlValue(input, characterName);
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      const added = await waitUntil(() => Boolean(friendEntry(characterName)), 10000, 150);
      if (!added) return { ok: false, error: `${characterName} não apareceu na lista de amigos após adicionar` };
      row = friendEntry(characterName);
    }
    return { ok: true, row, online: row.classList.contains("online") };
  }

  async function waitForPartyMembers(expectedNames, timeout = 60000) {
    const normalized = expectedNames.map(normalizeItemName);
    const navReady = await waitUntil(() => visible(document.querySelector("#nav-party")), timeout, 200);
    if (!navReady) return false;
    const opened = await openPartyWindow();
    if (!opened.ok) return false;
    return waitUntil(() => {
      const actual = readPartyState().members.map((member) => normalizeItemName(member.name));
      return normalized.every((name) => actual.includes(name));
    }, timeout, 200);
  }

  async function inviteFriendToParty(characterName, expectedNames, attempt = 0) {
    const currentNames = readPartyState().members.map((member) => normalizeItemName(member.name));
    if (currentNames.includes(normalizeItemName(characterName))) return { ok: true, alreadyJoined: true };
    const friend = await ensureFriend(characterName);
    if (!friend.ok) return friend;
    if (!friend.online) return { ok: false, error: `${characterName} está offline no Huntera` };
    friend.row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: friend.row.getBoundingClientRect().left + 12, clientY: friend.row.getBoundingClientRect().top + 12 }));
    const menuReady = await waitUntil(() => visible(document.querySelector(".friends-context-menu")), 3000, 80);
    if (!menuReady) return { ok: false, error: `O menu de ${characterName} não abriu` };
    const buttons = [...document.querySelectorAll(".friends-context-menu button")].filter(visible);
    const invite = buttons.find((button) => /invite.*party|convid.*(?:party|grupo)/i.test(normalizeItemName(button.textContent))) || buttons[1];
    if (!invite || invite.disabled) return { ok: false, error: `A opção de convidar ${characterName} para a party não está disponível` };
    invite.click();
    const warning = await waitUntil(() => Boolean(findInviteCard("experience-warning")), 1200, 80);
    if (warning) {
      clickInviteAction(findInviteCard("experience-warning"), false);
      return { ok: false, error: `${characterName} causaria penalidade de experiência compartilhada` };
    }
    const joined = await waitForPartyMembers(expectedNames, 15000);
    if (!joined && attempt < 1) return inviteFriendToParty(characterName, expectedNames, attempt + 1);
    return joined ? { ok: true } : { ok: false, error: `${characterName} não aceitou o convite da party a tempo` };
  }

  async function setPartyTarget(role, leaderName) {
    if (role !== "leader") {
      const followPrompt = findInviteCard("follow");
      if (followPrompt && clickInviteAction(followPrompt, true)) await new Promise((resolve) => window.setTimeout(resolve, 180));
    }
    const select = document.querySelector(".hud-target-strategy");
    if (!select) return { ok: false, error: "O seletor de alvo do Huntera não foi encontrado" };
    let value = "nearest";
    if (role !== "leader") {
      const target = normalizeItemName(leaderName);
      const option = [...select.querySelectorAll('option[value^="follow-member-"]')].find((item) => normalizeItemName(item.textContent).includes(target));
      if (!option) return { ok: false, error: `A opção de seguir ${leaderName} ainda não apareceu` };
      value = option.value;
    }
    setControlValue(select, value);
    const changed = await waitUntil(() => select.value === value, 3000, 80);
    return changed ? { ok: true, value } : { ok: false, error: "O Huntera não confirmou a estratégia de alvo da party" };
  }

  async function enableSharedCosts(role, leaderName) {
    const opened = await openPartyWindow();
    if (!opened.ok) return opened;
    if (readPartyState().sharedCosts) return { ok: true, alreadyEnabled: true };
    if (role === "leader") {
      const offer = [...document.querySelectorAll(".party-window .party-costs-offer")].find(visible);
      if (!offer || offer.disabled) return { ok: false, error: "O rateio de custos não pode ser iniciado agora" };
      offer.click();
    } else {
      const prompted = await waitUntil(() => Boolean(findInviteCard("costs", leaderName)), 60000, 150);
      if (!prompted || !clickInviteAction(findInviteCard("costs", leaderName), true)) return { ok: false, error: "O convite para ratear os custos não chegou" };
    }
    const active = await waitUntil(() => readPartyState().sharedCosts, 60000, 200);
    return active ? { ok: true } : { ok: false, error: "O rateio de custos não foi aceito por todos a tempo" };
  }

  async function prepareGroup(payload = {}) {
    if (characterSelectionVisible()) {
      const selected = await selectCharacter(payload.characterName || payload.character_name || payload.character?.name);
      if (!selected.ok) return selected;
    }
    const current = readState();
    if (current.inHunt) return { ok: false, error: "Saia da caçada atual antes de preparar a party" };
    if (current.training?.active) {
      const stopped = await stopTraining();
      if (!stopped.ok) return { ok: false, error: stopped.error || "Não foi possível encerrar o treino antes de preparar a party" };
    }
    const group = payload.group || {};
    const members = Array.isArray(group.members) ? group.members.filter((member) => member?.name) : [];
    const leader = members.find((member) => member.characterId === group.leaderCharacterId) || members.find((member) => member.role === "leader");
    if (members.length < 2 || members.length > 4 || !leader?.name) return { ok: false, error: "A party precisa de um puxador e de 2 a 4 personagens" };
    const expectedNames = members.map((member) => member.name);
    const role = group.role === "leader" ? "leader" : "follower";
    if (group.phase === "initialize") return { ok: true, party: readPartyState() };
    if (role === "leader") {
      const existing = readPartyState().members.map((member) => normalizeItemName(member.name));
      const expected = expectedNames.map(normalizeItemName);
      if (existing.some((name) => !expected.includes(name))) return { ok: false, error: "O puxador já está em uma party com participantes fora deste grupo" };
      for (const member of members.filter((member) => member.characterId !== group.leaderCharacterId)) {
        const invited = await inviteFriendToParty(member.name, [leader.name, member.name]);
        if (!invited.ok) return invited;
      }
      if (!await waitForPartyMembers(expectedNames, 60000)) return { ok: false, error: "Nem todos os participantes entraram na party" };
    } else {
      const inParty = readPartyState().members.some((member) => normalizeItemName(member.name) === normalizeItemName(leader.name));
      if (!inParty) {
        const received = await waitUntil(() => Boolean(findInviteCard("party", leader.name)), 120000, 150);
        if (!received || !clickInviteAction(findInviteCard("party", leader.name), true)) return { ok: false, error: `O convite de ${leader.name} não chegou` };
      }
      if (!await waitForPartyMembers(expectedNames, 60000)) return { ok: false, error: "A party não reuniu todos os participantes a tempo" };
    }
    const targeted = await setPartyTarget(role, leader.name);
    if (!targeted.ok) return targeted;
    if (group.rules?.shareCosts !== false) {
      const costs = await enableSharedCosts(role, leader.name);
      if (!costs.ok) return costs;
    }
    return { ok: true, party: readPartyState() };
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

  function bestiaryNumber(value) {
    const raw = String(value || "").trim().replace(/\s/g, "");
    if (!raw) return null;
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) return Number(raw.replace(/[.,]/g, ""));
    const parsed = Number(raw.replace(",", "."));
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
  }

  function bestiaryStageProgress(baseTarget, absoluteKills, unlockedStages = 0) {
    const base = bestiaryNumber(baseTarget);
    const total = bestiaryNumber(absoluteKills);
    const unlocked = bestiaryNumber(unlockedStages) ?? 0;
    if (base === null || base < 1 || total === null) return null;
    const stage = total >= base ? Math.max(0, unlocked) + 1 : 0;
    const targetKills = base * (2 ** stage);
    const stageStart = base * ((2 ** stage) - 1);
    const currentKills = Math.max(0, total - stageStart);
    const rewardReady = currentKills >= targetKills;
    return {
      stage,
      phase: stage + 1,
      completedPhases: stage,
      currentKills,
      targetKills,
      absoluteKills: total,
      baselineTargetKills: base,
      baselineComplete: total >= base,
      rewardReady,
      overflowKills: rewardReady ? currentKills - targetKills : 0,
      completed: total >= base
    };
  }

  function socketBestiarySnapshot() {
    const catalog = Array.isArray(socketState.bestiaryCatalog) ? socketState.bestiaryCatalog : [];
    // wire-9 normally contains only the creature that just died. It is safe to
    // use it as a complete sync only when Huntera explicitly sent enough keys
    // to cover the catalog in one payload. Partial wire updates are still used
    // by bestiaryLive, but must never turn missing historical entries into zero.
    if (!socketState.bestiaryReceived || !socketState.bestiaryFullSnapshot || !catalog.length) return [];
    return catalog.map((monster) => {
      const monsterKey = String(monster?.id ?? monster?.monsterKey ?? monster?.key ?? "");
      const name = String(monster?.name || "").trim();
      if (!monsterKey || !name) return null;
      const baseTarget = bestiaryNumber(monster?.killsRequired) || 2500;
      const progress = bestiaryStageProgress(
        baseTarget,
        socketState.bestiaryKills[monsterKey] ?? 0,
        socketState.bestiaryStages[monsterKey] ?? 0
      );
      return progress ? {
        name,
        monsterKey,
        currentKills: progress.currentKills,
        targetKills: progress.targetKills,
        completed: progress.completed,
        absoluteKills: progress.absoluteKills,
        stage: progress.stage,
        phase: progress.phase,
        completedPhases: progress.completedPhases,
        baselineTargetKills: progress.baselineTargetKills,
        baselineComplete: progress.baselineComplete,
        rewardReady: progress.rewardReady,
        overflowKills: progress.overflowKills
      } : null;
    }).filter(Boolean);
  }

  function normalizeBestiaryStage(currentKills, targetKills, completed = false, completedPhases = 0, baseTargetKills = 2500) {
    const current = bestiaryNumber(currentKills);
    const target = bestiaryNumber(targetKills);
    const phases = bestiaryNumber(completedPhases) ?? 0;
    const base = bestiaryNumber(baseTargetKills) || 2500;
    if (current === null || target === null || target < 100) return null;
    const stageStart = base * ((2 ** phases) - 1);
    const absoluteKills = stageStart + current;
    const rewardReady = completed || current >= target;
    return {
      currentKills: current,
      targetKills: target,
      completed: absoluteKills >= base,
      absoluteKills,
      stage: phases,
      phase: phases + 1,
      completedPhases: phases,
      baselineTargetKills: base,
      baselineComplete: absoluteKills >= base,
      rewardReady,
      overflowKills: rewardReady ? Math.max(0, current - target) : 0
    };
  }

  function bestiaryCompletedPhases(card) {
    const badge = card.querySelector("[class*='stage'], [class*='tier'], [class*='badge'], [class*='star']");
    const values = [badge?.textContent, card.textContent].filter(Boolean);
    for (const value of values) {
      const match = String(value).replace(/\s+/g, " ").match(/[×x]\s*(\d+)/i);
      if (match) return Number(match[1]);
    }
    return 0;
  }

  function bestiaryEntryButtons() {
    // Preferred: the Cyclopedia card layout. Newer Huntera versions retain the
    // numeric stage progress even for completed entries, so parse it before
    // falling back to the legacy "Concluída"-only representation.
    const cards = [...document.querySelectorAll(".cyc-entry-card")].filter(visible);
    if (cards.length) {
      return cards.map((button) => {
        const name = button.querySelector(".cyc-entry-name")?.textContent?.replace(/\s+/g, " ").trim() || "";
        if (!name) return null;
        const countEl = button.querySelector(".cyc-entry-count");
        const countText = countEl?.textContent?.replace(/\s+/g, " ").trim() || "";
        const match = countText.match(/([\d.,]+)\s*\/\s*([\d.,]+)/);
        const done = countEl?.classList.contains("done") || /conclu|complet|✓/i.test(countText);
        const completedPhases = bestiaryCompletedPhases(button);
        if (match) {
          const progress = normalizeBestiaryStage(match[1], match[2], done, completedPhases);
          return progress ? { button, name, ...progress } : null;
        }
        if (done) {
          const phases = Math.max(1, completedPhases);
          const progress = normalizeBestiaryStage(2500, 2500, true, phases - 1);
          return progress ? { button, name, ...progress } : null;
        }
        return null;
      }).filter(Boolean);
    }
    // Fallback for any other layout: parse "Name X / Y" from the button text.
    return [...document.querySelectorAll("button, [role=\"button\"]")].filter(visible).map((button) => {
      const text = button.textContent?.replace(/\s+/g, " ").trim() || "";
      const match = text.match(/^(.+?)\s+([\d.,]+)\s*\/\s*([\d.,]+)$/);
      if (!match) return null;
      const progress = normalizeBestiaryStage(match[2], match[3], false, bestiaryCompletedPhases(button));
      return progress ? { button, name: match[1].trim(), ...progress } : null;
    }).filter(Boolean);
  }

  function bestiaryPageSignature() {
    return bestiaryEntryButtons().map((entry) => `${normalizeItemName(entry.name)}:${entry.currentKills}/${entry.targetKills}`).join("|");
  }

  function bestiaryControlLabels(button) {
    return [
      button?.textContent,
      button?.getAttribute("aria-label"),
      button?.getAttribute("title"),
      button?.dataset?.tooltip
    ].filter(Boolean).map((value) => normalizeItemName(String(value).replace(/\s+/g, " ")));
  }

  function bestiaryPageNumber(button) {
    for (const label of bestiaryControlLabels(button)) {
      if (/^\d{1,2}$/.test(label)) return Number(label);
      const match = label.match(/(?:page|pagina)\s*(\d+)$/i);
      if (match) return Number(match[1]);
    }
    return null;
  }

  function bestiaryPaginationControls() {
    const controls = [...document.querySelectorAll("button, [role=\"button\"]")].filter(visible);
    const paginationLabel = (button) => bestiaryControlLabels(button).some((label) =>
      /^(?:first page|previous page|next page|last page|primeira pagina|pagina anterior|proxima pagina|ultima pagina|pagina seguinte)$/.test(label)
    );
    const anchor = controls.find(paginationLabel);
    if (!anchor) return [];

    let parent = anchor.parentElement;
    for (let level = 0; parent && level < 8; level += 1, parent = parent.parentElement) {
      const nested = [...parent.querySelectorAll("button, [role=\"button\"]")].filter(visible);
      const numeric = nested.filter((button) => bestiaryPageNumber(button) !== null);
      const hasPaginationLabel = nested.some(paginationLabel);
      if (hasPaginationLabel && numeric.length >= 2) return nested;
    }
    return controls.filter((button) => paginationLabel(button) || bestiaryPageNumber(button) !== null);
  }

  function bestiaryCurrentPage() {
    const controls = bestiaryPaginationControls();
    const current = controls.find((button) => {
      const ariaCurrent = button.getAttribute("aria-current");
      return ariaCurrent === "page";
    }) || controls.find((button) => {
      const value = button.textContent?.trim() || button.getAttribute("aria-label") || "";
      return /^\d+$/.test(value) && (button.classList.contains("active") || button.classList.contains("selected") || button.getAttribute("data-selected") === "true");
    });
    const value = current?.textContent?.trim() || current?.getAttribute("aria-label") || "";
    const match = value.match(/(?:page|pagina)?\s*(\d+)$/i);
    return match ? Number(match[1]) : null;
  }

  function bestiaryPageButton(pageNumber) {
    return bestiaryPaginationControls().find((button) => bestiaryPageNumber(button) === pageNumber) || null;
  }

  function bestiaryButton(label) {
    const target = normalizeItemName(label);
    return [...document.querySelectorAll("button, [role=\"button\"]")].filter(visible).find((button) => {
      const text = normalizeItemName(button.textContent?.replace(/\s+/g, " "));
      const aria = normalizeItemName(button.getAttribute("aria-label"));
      return text === target || aria === target;
    }) || null;
  }

  function bestiaryNextButton() {
    const controls = bestiaryPaginationControls();
    const explicit = controls.find((button) => {
      const labels = bestiaryControlLabels(button);
      const dataAction = normalizeItemName(button.dataset.pageAction || button.dataset.paginationAction || "");
      return labels.some((label) => ["proxima pagina", "next page", "pagina seguinte"].includes(label))
        || dataAction === "next" || button.classList.contains("next-page");
    });
    if (explicit) return explicit;
    return controls.find((button) => {
      const text = normalizeItemName(button.textContent?.replace(/\s+/g, " "));
      return text === "›" || text === ">";
    }) || null;
  }

  function bestiaryFirstPageButton() {
    return bestiaryPaginationControls().find((button) => bestiaryControlLabels(button).some((label) =>
      ["primeira pagina", "first page"].includes(label)
    )) || null;
  }

  function bestiaryButtonDisabled(button) {
    return !button || button.disabled || button.getAttribute("aria-disabled") === "true" || button.classList.contains("disabled");
  }

  async function bestiaryGoToPage(pageNumber, { allowUnchanged = false } = {}) {
    const pageButton = bestiaryPageButton(pageNumber);
    if (!pageButton) return false;
    const beforePage = bestiaryCurrentPage();
    const beforeSignature = bestiaryPageSignature();
    pageButton.click();
    const changed = await waitUntil(() => {
      const nextPage = bestiaryCurrentPage();
      const nextSignature = bestiaryPageSignature();
      return (nextPage !== null && nextPage === pageNumber)
        || (nextSignature && nextSignature !== beforeSignature);
    }, 6000, 100);
    if (changed) return true;
    return allowUnchanged && (beforePage === pageNumber || bestiaryPageSignature() === beforeSignature);
  }

  function bestiaryCloseButton() {
    return [...document.querySelectorAll("button, [role=\"button\"]")].filter(visible).find((button) => {
      const text = normalizeItemName(button.textContent);
      const aria = normalizeItemName(button.getAttribute("aria-label"));
      if (!["fechar", "close"].includes(text) && !["fechar", "close"].includes(aria)) return false;
      let parent = button.parentElement;
      for (let level = 0; parent && level < 8; level += 1, parent = parent.parentElement) {
        if (/cyclopedia|bestiary/.test(normalizeItemName(parent.textContent))) return true;
      }
      return false;
    }) || null;
  }

  async function openBestiary() {
    const alreadyOpen = bestiaryEntryButtons().length > 0 || Boolean(bestiaryButton("bestiary"));
    if (!alreadyOpen) {
      const cyclopedia = firstVisible("#nav-cyclopedia");
      if (!cyclopedia) return { ok: false, error: "Botão da Cyclopedia não encontrado nesta tela" };
      cyclopedia.click();
      const opened = await waitUntil(() => Boolean(bestiaryButton("bestiary")), 5000);
      if (!opened) return { ok: false, error: "A Cyclopedia não abriu" };
    }
    if (!bestiaryEntryButtons().length) {
      const tab = bestiaryButton("bestiary");
      if (!tab) return { ok: false, error: "A aba Bestiary não foi encontrada" };
      tab.click();
      const loaded = await waitUntil(() => bestiaryEntryButtons().length > 0, 5000);
      if (!loaded) return { ok: false, error: "O progresso do Bestiary não carregou" };
    }
    return { ok: true };
  }

  async function syncBestiary() {
    const socketEntries = socketBestiarySnapshot();
    if (socketEntries.length) {
      return {
        ok: true,
        characterName: readState().character?.name || null,
        entries: socketEntries,
        pages: 0,
        closeAfterSync: false,
        source: "huntera-bestiary-websocket"
      };
    }
    const wasOpen = bestiaryEntryButtons().length > 0 || Boolean(bestiaryButton("bestiary"));
    const opened = await openBestiary();
    if (!opened.ok) return opened;
    const entries = new Map();
    let pages = 0;
    const numberedPages = [...new Set(
      bestiaryPaginationControls().map((button) => bestiaryPageNumber(button)).filter((page) => page !== null)
    )].sort((left, right) => left - right);
    if (numberedPages.length >= 2 && bestiaryPageButton(numberedPages[0])) {
      const collectCurrentPage = () => {
        for (const entry of bestiaryEntryButtons()) {
          entries.set(normalizeItemName(entry.name), { ...entry, button: undefined });
        }
        pages += 1;
      };
      const firstPage = numberedPages[0];
      const firstMoved = await bestiaryGoToPage(firstPage, { allowUnchanged: true });
      if (!firstMoved) return { ok: false, error: "O Bestiary não voltou para a primeira página" };
      collectCurrentPage();
      for (const pageNumber of numberedPages.slice(1)) {
        const moved = await bestiaryGoToPage(pageNumber);
        if (!moved) return { ok: false, error: "O Bestiary não avançou para a página " + pageNumber };
        collectCurrentPage();
      }
      if (!entries.size) return { ok: false, error: "Nenhuma entrada do Bestiary foi encontrada" };
      return {
        ok: true,
        characterName: readState().character?.name || null,
        entries: [...entries.values()],
        pages,
        closeAfterSync: !wasOpen,
        source: "huntera-bestiary-ui"
      };
    }
    const visitedPages = new Set();
    for (; pages < 20; pages += 1) {
      const page = bestiaryCurrentPage();
      const signature = bestiaryPageSignature();
      const pageKey = page === null ? signature : String(page);
      if (visitedPages.has(pageKey)) break;
      visitedPages.add(pageKey);
      for (const entry of bestiaryEntryButtons()) {
        entries.set(normalizeItemName(entry.name), { ...entry, button: undefined });
      }
      const next = bestiaryNextButton();
      if (!next || next.disabled || next.getAttribute("aria-disabled") === "true" || next.classList.contains("disabled")) break;
      const beforePage = page;
      const beforeSignature = signature;
      next.click();
      const changed = await waitUntil(() => {
        const nextPage = bestiaryCurrentPage();
        const nextSignature = bestiaryPageSignature();
        return (beforePage !== null && nextPage !== null && nextPage !== beforePage)
          || (nextSignature && nextSignature !== beforeSignature);
      }, 6000, 100);
      if (!changed) return { ok: false, error: `O Bestiary não avançou após a página ${pages + 1}` };
    }
    if (!entries.size) return { ok: false, error: "Nenhuma entrada do Bestiary foi encontrada" };
    return {
      ok: true,
      characterName: readState().character?.name || null,
      entries: [...entries.values()],
      pages,
      closeAfterSync: !wasOpen,
      source: "huntera-bestiary-ui"
    };
  }

  async function closeBestiary() {
    const close = bestiaryCloseButton();
    if (!close) return { ok: true, alreadyClosed: true };
    close.click();
    const closed = await waitUntil(() => !bestiaryEntryButtons().length && !bestiaryButton("bestiary"), 3000, 100);
    return closed ? { ok: true } : { ok: false, error: "O Bestiary não fechou após a sincronização" };
  }

  function availableLootControls() {
    return [...document.querySelectorAll(".hunt-loot-auto, [data-action='auto-loot'] input[type='checkbox']")]
      .filter((control) => !control.disabled && visible(control.closest(".hunt-loot-entry, .auto-loot-entry, [data-loot-item]")));
  }

  async function revealLootControls() {
    if (availableLootControls().length) return true;
    const direct = document.querySelector("#nav-auto-loot, [data-page='auto-loot'], [data-tab='loot']");
    const fallback = [...document.querySelectorAll("button")].find((button) => visible(button) && /auto.?loot|loot automatico|configurar loot/i.test(normalizeItemName(button.textContent || button.getAttribute("aria-label"))));
    (direct || fallback)?.click();
    return waitUntil(() => availableLootControls().length > 0, 2500, 100);
  }

  async function configureLoot(hunt = {}, accountLoot = {}, requireControls = false) {
    await revealLootControls();
    const controls = availableLootControls();
    if (!controls.length) return requireControls
      ? { ok: false, error: "Os controles de auto-loot não estão disponíveis nesta tela" }
      : { ok: true, configured: 0, changed: 0 };
    const keys = new Set((Array.isArray(hunt.lootItemKeys) ? hunt.lootItemKeys : []).map((key) => String(key)));
    const configured = hunt.lootConfigured === true || keys.size > 0;
    const accountConfigured = Number(accountLoot.version) >= 1 || Array.isArray(accountLoot.items);
    let changed = 0;
    for (const control of controls) {
      const entry = control.closest(".hunt-loot-entry, .auto-loot-entry, [data-loot-item]");
      const name = entry?.querySelector(".hunt-loot-name, .auto-loot-name, [data-item-name]")?.textContent?.trim() || entry?.dataset.itemName || "";
      const baseKey = itemKeyFromName(name);
      const itemId = control.dataset.itemId || entry?.dataset.itemId || "";
      const variantKey = itemId ? `${baseKey}-${itemId}` : baseKey;
      const policy = configuredLootPolicy(accountLoot, { itemId, name });
      const desired = accountConfigured ? policy !== "ignore" : configured ? (keys.has(baseKey) || keys.has(variantKey)) : true;
      if (control.checked !== desired) { control.click(); changed += 1; }
    }
    return { ok: true, configured: controls.length, changed };
  }

  async function configureAccountLoot(accountLoot = {}) {
    return configureLoot({}, accountLoot, true);
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
  // Ascending intensity — a higher index means more creatures pulled.
  const PULL_TIER_ORDER = ["cauteloso", "ousado", "agressivo", "suicida"];
  // Sentinels that mean "pick the strongest pull the hunt offers" rather than a
  // fixed tier. Bestiary hunts request this so each creature spawns at max density.
  const MAX_PULL_ALIASES = ["max", "maxima", "maximo", "ultima", "ultimo", "highest", "suicida"];

  function tierMatches(element, requested) {
    const aliases = PULL_TIER_ALIASES[requested] || [requested];
    return aliases.includes(tierName(element));
  }

  function tierSelected(element) {
    return element?.classList.contains("selected") || element?.classList.contains("active") || element?.getAttribute("aria-pressed") === "true" || element?.getAttribute("data-selected") === "true";
  }

  function tierLocked(element) {
    if (!element) return true;
    if (element.disabled || element.getAttribute("aria-disabled") === "true" || element.getAttribute("data-locked") === "true") return true;
    return /\b(locked|disabled|unavailable|indispon|bloquead)/i.test(element.className || "");
  }

  function tierRank(element) {
    const name = tierName(element);
    for (const [key, aliases] of Object.entries(PULL_TIER_ALIASES)) {
      if (aliases.includes(name)) return PULL_TIER_ORDER.indexOf(key);
    }
    return -1;
  }

  async function selectMaxPullTier() {
    const tiers = [...document.querySelectorAll(".hunt-window .hunt-tier")].filter(visible).filter((item) => !tierLocked(item));
    if (!tiers.length) return { ok: false, error: "Nenhum pull disponível nesta caçada" };
    // Highest known tier; if names are unrecognized, the last one in the DOM
    // (the game lists them ascending, so the last is the strongest).
    let best = tiers[tiers.length - 1];
    let bestRank = tierRank(best);
    for (const item of tiers) {
      const rank = tierRank(item);
      if (rank > bestRank) { best = item; bestRank = rank; }
    }
    const label = tierName(best) || "última";
    if (!tierSelected(best)) {
      best.click();
      const applied = await waitUntil(() => {
        const selected = [...document.querySelectorAll(".hunt-window .hunt-tier")].filter(visible).find(tierSelected);
        return Boolean(selected && tierName(selected) === tierName(best));
      }, 1800, 80);
      if (!applied) return { ok: false, error: "O Huntera não confirmou o pull máximo" };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    return { ok: true, tier: label };
  }

  async function selectPullTier(value) {
    const requested = normalizeItemName(value || "Cauteloso");
    if (MAX_PULL_ALIASES.includes(requested)) return selectMaxPullTier();
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

  // --- Level-aware potion placement (row 2 = support) -----------------------
  // The action bar evaluates left-to-right, first-match-wins, so a lower
  // threshold on the left beats a higher threshold on the right when both pass.
  // We place the strongest usable potion at the lowest (most urgent) threshold
  // on the left and the cheapest/weakest at the highest threshold on the right.
  // The game itself marks what a character can use with .action-choice.locked,
  // so no hardcoded level/vocation table is needed here.
  const POTION_LADDER = {
    health: ["lesser-health-potion", "health-potion", "strong-health-potion", "great-health-potion", "ultimate-health-potion", "supreme-health-potion"],
    mana: ["mana-potion", "strong-mana-potion", "great-mana-potion", "ultimate-mana-potion"]
  };
  const POTION_ROW_START = 10; // slots 10..19 are the second (support) row

  function potionResource(actionKey) {
    const key = String(actionKey || "");
    if (POTION_LADDER.health.includes(key)) return "health";
    if (POTION_LADDER.mana.includes(key)) return "mana";
    return null;
  }

  function isPotionRule(rule) {
    const key = rule?.actionKey || rule?.action_key || "";
    return Boolean(potionResource(key)) || /-potion$/i.test(String(key));
  }

  function actionEditorTab(editor, label) {
    return [...editor.querySelectorAll(".action-tabs .tab")].find((tab) => tab.textContent.trim().toLowerCase() === label) || null;
  }

  async function openSlotEditor(slotIndex) {
    const slot = document.querySelector(`.hud-slot[data-action-slot="${slotIndex}"]`);
    if (!slot) return null;
    slot.click();
    const opened = await waitFor(".action-editor", 3000, true);
    return opened ? document.querySelector(".action-editor") : null;
  }

  async function openItemsTab(editor) {
    const tab = actionEditorTab(editor, "items");
    if (!tab) return false;
    tab.click();
    return waitUntil(() => editor.querySelectorAll(".action-list .action-choice").length > 0, 3000, 80);
  }

  function usablePotionsByResource(editor) {
    const usable = { health: [], mana: [] };
    for (const choice of editor.querySelectorAll(".action-list .action-choice")) {
      const key = choice.dataset.actionId;
      const resource = potionResource(key);
      if (resource && !choice.classList.contains("locked")) usable[resource].push(key);
    }
    for (const resource of ["health", "mana"]) {
      usable[resource].sort((left, right) => POTION_LADDER[resource].indexOf(left) - POTION_LADDER[resource].indexOf(right));
    }
    return usable;
  }

  async function stepConditionValue(editor, desired) {
    const target = Math.max(1, Math.min(99, Number(desired) || 1));
    const readValue = () => Number(editor.querySelector(".condition-value")?.value || 0);
    let guard = 0;
    while (readValue() > target && guard < 40) { editor.querySelector(".condition-step-down")?.click(); await new Promise((r) => window.setTimeout(r, 18)); guard += 1; }
    while (readValue() < target && guard < 80) { editor.querySelector(".condition-step-up")?.click(); await new Promise((r) => window.setTimeout(r, 18)); guard += 1; }
    return readValue() === target;
  }

  function ensurePotionCheckboxes(editor, enabled) {
    const percent = editor.querySelector(".action-condition-row input[type=\"checkbox\"]");
    if (percent && !percent.checked) percent.click();
    const enabledToggle = [...editor.querySelectorAll("input[type=\"checkbox\"]")].at(-1);
    if (enabledToggle && enabledToggle.checked !== (enabled !== false)) enabledToggle.click();
  }

  function selectedPotionKey(editor) {
    const selected = editor.querySelector(".action-choice.selected");
    return selected ? selected.dataset.actionId || null : null;
  }

  async function placePotionInSlot(slotIndex, entry) {
    const editor = await openSlotEditor(slotIndex);
    if (!editor) return { ok: false, error: `O slot ${slotIndex} não abriu` };
    if (!(await openItemsTab(editor))) { await closeActionEditor(editor); return { ok: false, error: "A aba de itens não abriu" }; }
    const choice = [...editor.querySelectorAll(".action-list .action-choice")].find((item) => item.dataset.actionId === entry.actionKey && !item.classList.contains("locked"));
    if (!choice) { await closeActionEditor(editor); return { ok: false, error: `A poção ${entry.actionKey} não está disponível` }; }
    choice.click();
    await waitUntil(() => selectedPotionKey(editor) === entry.actionKey, 2000, 60);
    setSelectValue(editor.querySelector(".condition-subject"), "player");
    setSelectValue(editor.querySelector(".condition-attribute"), entry.resource);
    setSelectValue(editor.querySelector(".condition-operator"), entry.operator === "<" ? "<" : "<=");
    await stepConditionValue(editor, entry.threshold);
    ensurePotionCheckboxes(editor, true);
    const save = [...editor.querySelectorAll("button")].find((button) => button.textContent.trim() === "Save");
    if (!save) { await closeActionEditor(editor); return { ok: false, error: "Botão Salvar não encontrado" }; }
    save.click();
    const saved = await waitFor(".action-editor", 3000, false);
    return saved ? { ok: true } : { ok: false, error: `A poção ${entry.actionKey} não confirmou o salvamento` };
  }

  // Clears a row-2 slot ONLY when it currently holds a potion — never touches a
  // spell/rune the player parked there.
  async function clearPotionSlot(slotIndex) {
    const slot = document.querySelector(`.hud-slot[data-action-slot="${slotIndex}"]`);
    if (!slot || !slot.classList.contains("assigned")) return;
    const editor = await openSlotEditor(slotIndex);
    if (!editor) return;
    if (!potionResource(selectedPotionKey(editor))) { await closeActionEditor(editor); return; }
    const remove = [...editor.querySelectorAll("button")].find((button) => button.classList.contains("action-remove") || button.textContent.trim() === "Remove");
    if (remove) { remove.click(); await waitFor(".action-editor", 3000, false); } else await closeActionEditor(editor);
  }

  async function arrangePotions(potionRules) {
    const rules = (Array.isArray(potionRules) ? potionRules : [])
      .map((rule) => ({
        actionKey: rule.actionKey || rule.action_key || "",
        resource: potionResource(rule.actionKey || rule.action_key) || (["health", "mana"].includes(rule.resource) ? rule.resource : null),
        operator: rule.operator === "<" ? "<" : "<=",
        threshold: Math.max(1, Math.min(99, Number(rule.thresholdPercent ?? rule.threshold_percent) || 50)),
        enabled: rule.enabled !== false
      }))
      .filter((rule) => rule.resource && rule.enabled);
    if (!rules.length) return { ok: true, placed: 0, plan: [] };

    // Read what THIS character can actually use, from any row-2 slot's Items tab.
    const scratch = await openSlotEditor(POTION_ROW_START);
    if (!scratch) return { ok: false, error: "Não foi possível abrir o editor de ações" };
    if (!(await openItemsTab(scratch))) { await closeActionEditor(scratch); return { ok: false, error: "A aba de itens não abriu" }; }
    const usable = usablePotionsByResource(scratch);
    await closeActionEditor(scratch);

    const strongest = (resource) => usable[resource][usable[resource].length - 1] || null;
    const used = new Set();
    const resolved = [];
    for (const rule of rules) {
      let key = usable[rule.resource].includes(rule.actionKey) ? rule.actionKey : strongest(rule.resource);
      if (key && used.has(key)) {
        const remaining = usable[rule.resource].filter((candidate) => !used.has(candidate));
        key = remaining[remaining.length - 1] || null;
      }
      if (!key) continue; // nothing usable for this resource/tier
      used.add(key);
      resolved.push({ actionKey: key, resource: rule.resource, operator: rule.operator, threshold: rule.threshold });
    }
    if (!resolved.length) return { ok: true, placed: 0, plan: [], note: "Nenhuma poção usável para as regras" };

    // Placement follows the panel's order (priority), left to right. The player
    // controls it — since the bar is first-match-wins left-to-right, they put the
    // stronger/lower-threshold potions on the left themselves. We don't reorder.

    const placed = [];
    for (let index = 0; index < resolved.length && index < 10; index += 1) {
      const result = await placePotionInSlot(POTION_ROW_START + index, resolved[index]);
      if (!result.ok) return { ok: false, error: result.error, placed: placed.length, plan: resolved };
      placed.push({ slot: POTION_ROW_START + index, ...resolved[index] });
    }
    // Retire potions left in trailing row-2 slots from a previous, longer ladder.
    for (let index = resolved.length; index < 10; index += 1) await clearPotionSlot(POTION_ROW_START + index);
    return { ok: true, placed: placed.length, plan: placed };
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
    await waitUntil(() => [...document.querySelectorAll("button.hud-slot")].some(visible), 5000, 100);
    const list = Array.isArray(rules) ? rules : [];
    const potionRules = list.filter(isPotionRule);
    const spellRules = list.filter((rule) => !isPotionRule(rule));
    const configured = [];
    const skipped = [];

    // Spells/runes keep the original behavior: the player parks them on the bar
    // and we only tune the condition of the already-assigned slot.
    for (const rule of spellRules.filter((item) => item?.enabled !== false || item?.actionKey || item?.action_key)) {
      const result = await configureActionRule(rule);
      if (!result.ok) {
        if (/não está atribuída à barra/i.test(result.error || "")) {
          skipped.push({ actionKey: rule.actionKey || rule.action_key || null, reason: result.error });
          continue;
        }
        return { ok: false, configured: configured.length, skipped, error: result.error };
      }
      configured.push(result);
    }

    // Potions are placed for the player, level-aware and in priority order.
    // Best-effort: if placement can't run (editor/items tab not ready, character
    // mid-transition), skip it — it must NEVER block the hunt from starting.
    let potions = { ok: true, placed: 0, plan: [] };
    if (potionRules.length) {
      try { potions = await arrangePotions(potionRules); }
      catch (error) { potions = { ok: false, placed: 0, plan: [], error: error.message }; }
      if (!potions.ok) {
        for (const rule of potionRules) skipped.push({ actionKey: rule.actionKey || rule.action_key || null, reason: potions.error || "Não foi possível posicionar a poção" });
      }
    }

    return { ok: true, configured: configured.length + (potions.placed || 0), skipped, actions: configured, potions: potions.plan || [] };
  }

  async function openHuntWindow() {
    if (visible(document.querySelector(".hunt-window"))) return { ok: true, alreadyOpen: true };
    const button = firstVisible("#nav-start-hunt");
    if (!button) return { ok: false, error: "Botão Caçar não encontrado nesta tela" };
    button.click();
    const opened = await waitFor(".hunt-window", 5000, true);
    return opened ? { ok: true } : { ok: false, error: "O seletor de caçadas não abriu" };
  }

  const TRAINING_SKILLS = new Set(["club", "sword", "axe", "distance", "shielding", "magic"]);

  async function startTraining(payload = {}) {
    const training = payload.training || payload;
    const skill = TRAINING_SKILLS.has(training.skill) ? training.skill : null;
    if (!skill) return { ok: false, error: "Selecione uma habilidade válida para o treino" };
    if (characterSelectionVisible()) {
      const selected = await selectCharacter(payload.characterName || payload.character_name || payload.character?.name);
      if (!selected.ok) return selected;
    }
    const current = readState();
    if (current.training?.active && current.training.skill === skill) return { ok: true, alreadyTraining: true, skill, mode: "online" };
    if (current.training?.active) {
      const stopped = await stopTraining();
      if (!stopped.ok) return { ok: false, error: stopped.error || "Não foi possível encerrar o treino atual" };
    }
    if (current.inHunt) {
      const left = await leaveHunt();
      if (!left.ok) return left;
    }
    if (!inTown()) return { ok: false, error: "O personagem precisa estar na cidade para iniciar o treino" };

    const opened = await openHuntWindow();
    if (!opened.ok) return opened;
    const trainingTab = document.querySelector('.hunt-tab[data-tab="training"]');
    if (!trainingTab) return { ok: false, error: "A aba Training não foi encontrada" };
    trainingTab.click();
    const trainingPanel = await waitUntil(() => visible(document.querySelector(".hunt-training")), 5000, 100);
    if (!trainingPanel) return { ok: false, error: "A tela de treino não abriu" };

    const skillButton = document.querySelector(`.hunt-training .train-skill[data-skill="${skill}"]`);
    if (!skillButton || skillButton.disabled) return { ok: false, error: `A habilidade ${skill} não está disponível para este personagem` };
    skillButton.click();
    await new Promise((resolve) => window.setTimeout(resolve, 120));

    const trainingModes = [...document.querySelectorAll(".hunt-training .train-mode")];
    const onlineMode = trainingModes.find((section) => /online training/i.test(section.querySelector("h3")?.textContent || "")) || trainingModes[1];
    const startButton = onlineMode?.querySelector(".train-start");
    if (!startButton || startButton.disabled) return { ok: false, error: "O Online Training não está disponível neste momento" };
    startButton.click();
    const started = await waitUntil(() => {
      const state = socketTraining();
      return state.active && state.skill === skill;
    }, 10000, 100);
    return started
      ? { ok: true, skill, mode: "online" }
      : { ok: false, error: "O Huntera não confirmou o início do Online Training" };
  }

  async function stopTraining() {
    if (!readState().training?.active) return { ok: true, alreadyStopped: true };
    const opened = await openHuntWindow();
    if (!opened.ok) return opened;
    const trainingTab = document.querySelector('.hunt-tab[data-tab="training"]');
    if (!trainingTab) return { ok: false, error: "A aba Training não foi encontrada" };
    trainingTab.click();
    const stopReady = await waitUntil(() => [...document.querySelectorAll(".hunt-training .train-active button")].some((item) => !item.disabled), 5000, 100);
    const stopButton = stopReady
      ? [...document.querySelectorAll(".hunt-training .train-active button")].find((item) => !item.disabled)
      : null;
    if (!stopButton) return { ok: false, error: "O botão para parar o treino não foi encontrado" };
    stopButton.click();
    const stopped = await waitUntil(() => !socketTraining().active, 10000, 100);
    return stopped ? { ok: true } : { ok: false, error: "O Huntera não confirmou o fim do treino" };
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
    if (socketInHunt() === true) return true;
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

  async function prepareHuntSelection(payload = {}) {
    const hunt = payload.hunt || {};
    if (characterSelectionVisible()) {
      const selected = await selectCharacter(payload.characterName || payload.character_name || payload.character?.name);
      if (!selected.ok) return selected;
    }
    const current = readState();
    if (current.inHunt) return { ok: true, alreadyStarted: true };
    if (current.training?.active) {
      const stopped = await stopTraining();
      if (!stopped.ok) return { ok: false, error: stopped.error || "Não foi possível encerrar o treino antes da caçada" };
    }
    const target = hunt.spotKey || hunt.monsterKey;
    if (!target || target === "default") return { ok: false, error: "Nenhuma caçada foi selecionada" };
    const opened = await openHuntWindow();
    if (!opened.ok) return opened;
    const huntsTab = document.querySelector('.hunt-tab[data-tab="hunts"]');
    if (!huntsTab) return { ok: false, error: "A aba Hunts não foi encontrada" };
    huntsTab.click();
    const huntsReady = await waitUntil(() => [...document.querySelectorAll(".hunt-window .hunt-entry")].some(visible), 5000, 100);
    if (!huntsReady) return { ok: false, error: "A lista de caçadas não abriu" };
    const entry = [...document.querySelectorAll(".hunt-window .hunt-entry")].find((item) => visible(item) && matchesHunt(item, target));
    if (!entry) return { ok: false, error: `Caçada ${target} não encontrada no Huntera` };
    entry.click();
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    const pull = await selectPullTier(hunt.pullTier);
    if (!pull.ok) return pull;
    const loot = await configureLoot(hunt, payload.loot || {}, Number(payload.loot?.version) >= 1);
    if (!loot.ok) return loot;
    return { ok: true, entry, pull, loot, hunt };
  }

  async function startHunt(payload = {}) {
    const prepared = await prepareHuntSelection(payload);
    if (!prepared.ok || prepared.alreadyStarted) return prepared;
    const startButton = firstVisible("#hunt-start");
    if (!startButton) return { ok: false, error: "Botão para confirmar a caçada não encontrado" };
    startButton.click();
    const started = await waitForHuntStarted();
    return started ? { ok: true, huntId: prepared.entry.dataset.huntId, hunt: prepared.hunt.spotKey || prepared.hunt.monsterKey, pull: prepared.pull, loot: prepared.loot } : { ok: false, error: "A tela de caçada não confirmou o início" };
  }

  async function startGroupHunt(payload = {}) {
    const prepared = await prepareHuntSelection(payload);
    if (!prepared.ok || prepared.alreadyStarted) return prepared;
    const startButton = firstVisible("#hunt-start-team");
    if (!startButton || startButton.disabled) return { ok: false, error: "A opção Caçar com time ainda não está disponível para esta party" };
    startButton.click();
    const started = await waitForHuntStarted(70000);
    return started
      ? { ok: true, huntId: prepared.entry.dataset.huntId, hunt: prepared.hunt.spotKey || prepared.hunt.monsterKey, pull: prepared.pull, loot: prepared.loot, team: true }
      : { ok: false, error: "Nem todos aceitaram o convite para caçar com o time" };
  }

  async function acceptGroupHunt(payload = {}) {
    if (characterSelectionVisible()) {
      const selected = await selectCharacter(payload.characterName || payload.character_name || payload.character?.name);
      if (!selected.ok) return selected;
    }
    if (readState().inHunt) return { ok: true, alreadyStarted: true, team: true };
    // Followers receive their own command before the leader starts the team.
    // Prepare their hunt selection too, so account auto-loot is applied before
    // accepting the invitation instead of inheriting stale character settings.
    const prepared = await prepareHuntSelection(payload);
    if (!prepared.ok && !prepared.alreadyStarted) return prepared;
    const received = await waitUntil(() => Boolean(findInviteCard("team")), 60000, 150);
    if (!received || !clickInviteAction(findInviteCard("team"), true)) return { ok: false, error: "O convite para caçar com o time não chegou" };
    const started = await waitForHuntStarted(70000);
    return started ? { ok: true, team: true } : { ok: false, error: "O Huntera não confirmou o início da caçada em grupo" };
  }

  // The town is the ground truth for "left the hunt": the leave button is gone
  // and a town action (store or start-hunt) is available. We trust the DOM here
  // rather than readState().inHunt, whose socket phase can lag on "hunting" /
  // "returning" for several seconds after the player is already back in town —
  // that lag is what timed out the leave and blocked the store from opening.
  function inTown() {
    return !visible(document.querySelector("#nav-leave-hunt"))
      && (visible(document.querySelector("#nav-store")) || visible(document.querySelector("#nav-start-hunt")));
  }

  async function leaveHunt() {
    if (inTown()) return { ok: true, alreadyOut: true };
    const button = document.querySelector("#nav-leave-hunt"); if (!button) return { ok: false, error: "Botão para sair da caçada não encontrado" };
    button.click();
    const returned = await waitUntil(() => inTown(), 20000, 100);
    return returned ? { ok: true } : { ok: false, error: "A caçada não terminou após o comando" };
  }

  async function openStore({ autoLeave = true } = {}) {
    if (visible(document.querySelector(".trade-window"))) return { ok: true, alreadyOpen: true };
    if (!inTown() && autoLeave) { const left = await leaveHunt(); if (!left.ok) return left; }
    if (!inTown()) return { ok: false, error: "Saia da caçada antes de abrir a loja" };
    const button = document.querySelector("#nav-store"); if (!button) return { ok: false, error: "Botão da loja não encontrado nesta tela" };
    button.click(); const shop = await waitFor(".trade-window", 5000, true);
    return shop ? { ok: true, alreadyOpen: false } : { ok: false, error: "A loja não abriu após o comando" };
  }

  function readNpcSellOffers(shop) {
    return [...shop.querySelectorAll("#shop-offers .shop-offer")].filter(visible).map((offer) => {
      const label = offer.getAttribute("aria-label") || "";
      const match = label.match(/^(.+),\s*([\d.,]+)\s+gp\s+(?:cada|each)$/i);
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

  function configuredLootPolicy(config = {}, item = {}) {
    const externalId = String(item.itemId || item.id || "");
    const key = itemKeyFromName(item.name || "");
    const entry = (Array.isArray(config.items) ? config.items : []).find((candidate) =>
      (candidate.externalItemId != null && String(candidate.externalItemId) === externalId)
      || (candidate.itemKey && candidate.itemKey === key)
      || normalizeItemName(candidate.name) === normalizeItemName(item.name));
    return ["warehouse", "npc", "default", "ignore"].includes(entry?.policy) ? entry.policy : "default";
  }

  function lootDisposition(item, quote = {}, policy = "default") {
    if (policy === "ignore") return { destination: "ignore", reason: "política da conta: não coletar nem vender", sellPrice: null };
    if (policy === "warehouse") return { destination: "warehouse", reason: "política da conta: sempre guardar", sellPrice: null };
    if (policy === "npc") return { destination: "npc", reason: "política da conta: sempre vender no NPC", sellPrice: null };
    const sellPrices = Array.isArray(quote.sellPrices) ? quote.sellPrices.filter((value) => Number.isFinite(Number(value))).map(Number) : [];
    const sellPrice = sellPrices.length ? Math.min(...sellPrices) : null;
    if (item.npcValue == null || !Number.isFinite(Number(item.npcValue))) return { destination: "warehouse", reason: "item sem preço de NPC", sellPrice };
    if (!quote.found || sellPrice === null) return { destination: "npc", reason: "item sem oferta de venda no leilão; usando o valor seguro do NPC", sellPrice };
    if (sellPrice > Number(item.npcValue)) return { destination: "auction", reason: "oferta de venda maior que o NPC", sellPrice };
    return { destination: "npc", reason: "oferta de venda igual ou menor que o NPC", sellPrice };
  }

  function inventoryLootItems() {
    const source = [...(socketState.inventory?.slots || []), ...(socketState.inventory?.satchel || [])].filter(Boolean);
    const grouped = new Map();
    for (const raw of source) {
      const itemId = raw.itemId ?? raw.item_id ?? raw.id ?? raw.typeId ?? raw.type_id;
      const name = raw.name ?? raw.itemName ?? raw.item_name;
      if (itemId == null || !name) continue;
      const key = String(itemId);
      const current = grouped.get(key) || { itemId: key, name, count: 0, npcValue: null };
      current.count += Math.max(1, Number(raw.count ?? raw.quantity ?? raw.amount ?? 1) || 1);
      grouped.set(key, current);
    }
    return [...grouped.values()];
  }

  function inventoryRefsForItem(itemId) {
    const inventory = socketState.inventory || {};
    const expected = String(itemId);
    const refs = [];
    for (const [container, items] of [["backpack", inventory.slots || []], ["satchel", inventory.satchel || []]]) {
      items.forEach((item, index) => {
        const currentId = item?.itemId ?? item?.item_id ?? item?.id ?? item?.typeId ?? item?.type_id;
        if (currentId != null && String(currentId) === expected) refs.push({ container, index, item });
      });
    }
    return refs;
  }

  function inventoryItemAt(ref) {
    const inventory = socketState.inventory || {};
    return ref.container === "satchel" ? inventory.satchel?.[ref.index] : inventory.slots?.[ref.index];
  }

  function inventoryCountForItem(itemId) {
    return inventoryRefsForItem(itemId).reduce((total, ref) => total + Math.max(1, Number(ref.item?.count ?? ref.item?.quantity ?? ref.item?.amount ?? 1) || 1), 0);
  }

  function dispatchSlotMove(source, target, ref) {
    if (!source || !target || typeof DragEvent !== "function" || typeof DataTransfer !== "function") return false;
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("application/x-slot-ref", JSON.stringify({ container: ref.container, index: ref.index }));
    dataTransfer.effectAllowed = "move";
    const point = target.getBoundingClientRect();
    const options = { bubbles: true, cancelable: true, dataTransfer, clientX: point.left + point.width / 2, clientY: point.top + point.height / 2 };
    source.dispatchEvent(new DragEvent("dragstart", options));
    target.dispatchEvent(new DragEvent("dragover", options));
    target.dispatchEvent(new DragEvent("drop", options));
    source.dispatchEvent(new DragEvent("dragend", options));
    return true;
  }

  function buttonMatching(root, pattern, selectors = []) {
    for (const selector of selectors) {
      const candidate = [...root.querySelectorAll(selector)].find((element) => visible(element) && !element.disabled);
      if (candidate) return candidate;
    }
    return [...root.querySelectorAll("button")].find((button) => visible(button) && !button.disabled && pattern.test(normalizeItemName(button.textContent || button.getAttribute("aria-label"))));
  }

  async function createAuctionSellOrder(market, item) {
    const search = market.querySelector("#market-search");
    setSearchValue(search, item.name);
    const ready = await waitUntil(() => [...market.querySelectorAll(".market-item")].some((entry) => entry.dataset.marketItem === item.itemId || normalizeItemName(entry.querySelector(".market-item-name")?.textContent) === normalizeItemName(item.name)), 2500);
    if (!ready) return { ok: false, error: "Item não encontrado no leilão" };
    const marketItem = [...market.querySelectorAll(".market-item")].find((entry) => entry.dataset.marketItem === item.itemId || normalizeItemName(entry.querySelector(".market-item-name")?.textContent) === normalizeItemName(item.name));
    marketItem?.click();
    await waitUntil(() => normalizeItemName(firstVisible(".market-listing-head strong")?.textContent) === normalizeItemName(item.name), 2500);
    const create = buttonMatching(market, /criar.*(?:oferta|ordem)|vender|create.*sell|sell.*order/i, ["[data-action='create-sell-order']", ".market-create-sell", ".market-sell-button"]);
    if (!create) return { ok: false, error: "Limite de ordens atingido ou criação indisponível" };
    create.click();
    const form = await waitFor(".market-order-form, .market-create-order, .trade-dialog, [role='dialog']", 2500, true);
    if (!form) return { ok: false, error: "Formulário da ordem não abriu" };
    const text = normalizeItemName(form.textContent);
    if (/limite.*(?:ordem|oferta)|maximum.*(?:order|offer)/i.test(text)) return { ok: false, error: "Limite de ordens atingido" };
    const priceInput = form.querySelector("input[name='price'], input[data-field='price'], .market-order-price input");
    const amountInput = form.querySelector("input[name='amount'], input[name='quantity'], input[data-field='amount'], .market-order-amount input");
    if (!priceInput) return { ok: false, error: "Campo de preço da ordem não encontrado" };
    setSearchValue(priceInput, String(item.sellPrice));
    if (amountInput) setSearchValue(amountInput, String(Math.max(1, item.count || 1)));
    const submit = buttonMatching(form, /confirmar|criar.*(?:oferta|ordem)|vender|confirm|create/i, ["button[type='submit']", "[data-action='confirm']"]);
    if (!submit) return { ok: false, error: "Botão para confirmar a ordem não encontrado" };
    submit.click();
    const completed = await waitUntil(() => !visible(form) || /criad|sucesso|created|success/i.test(normalizeItemName(form.textContent)), 3500, 100);
    return completed ? { ok: true, price: item.sellPrice, count: item.count } : { ok: false, error: "O leilão não confirmou a ordem" };
  }

  async function moveItemsToWarehouse(items) {
    if (!items.length) return { stored: 0, storedItems: [], failedItems: [] };
    const tab = [...document.querySelectorAll(".trade-tab, [data-tab]")].find((entry) => visible(entry) && /depot|warehouse|storage|armazem|deposito/i.test(`${entry.dataset.tab || ""} ${normalizeItemName(entry.textContent)}`));
    const nav = document.querySelector(".hud-depot, #nav-depot, #nav-warehouse, #nav-storage");
    (tab || nav)?.click();
    const warehouse = await waitFor(".depot-window, .warehouse-window, .storage-window, [data-window='depot']", 3500, true);
    if (!warehouse) return { stored: 0, storedItems: [], failedItems: items.map((item) => ({ ...item, error: "Armazém indisponível" })) };
    const storedItems = [];
    const failedItems = [];
    try {
      for (const item of items) {
        const refs = inventoryRefsForItem(item.itemId);
        if (!refs.length) { failedItems.push({ ...item, error: "Item não encontrado na mochila" }); continue; }
        let storedCount = 0;
        let itemError = null;
        for (const ref of refs) {
          const grid = warehouse.querySelector(ref.container === "satchel" ? ".depot-satchel-grid" : ".depot-pack-grid");
          const source = grid?.querySelectorAll(".slot")?.[ref.index];
          const target = [...warehouse.querySelectorAll(".depot-grid .slot")].find((slot) => !slot.draggable && slot.childElementCount === 0 && visible(slot));
          if (!source || !source.draggable) { itemError = "Slot do item não corresponde ao inventário recebido"; break; }
          if (!target) { itemError = "Não há espaço livre no depósito"; break; }
          const moved = dispatchSlotMove(source, target, ref);
          if (!moved) { itemError = "O navegador não permitiu mover o item para o depósito"; break; }
          const confirmed = await waitUntil(() => {
            const current = inventoryItemAt(ref);
            const currentId = current?.itemId ?? current?.item_id ?? current?.id ?? current?.typeId ?? current?.type_id;
            return currentId == null || String(currentId) !== String(item.itemId);
          }, 4000, 100);
          if (!confirmed) { itemError = "O depósito não confirmou a transferência"; break; }
          storedCount += Math.max(1, Number(ref.item?.count ?? ref.item?.quantity ?? ref.item?.amount ?? 1) || 1);
        }
        if (storedCount > 0) storedItems.push({ itemId: item.itemId, name: item.name, count: storedCount });
        if (itemError) failedItems.push({ ...item, error: itemError });
      }
    } finally {
      const close = warehouse.querySelector("#depot-close") || document.querySelector("#depot-close");
      close?.click();
      await waitFor(".depot-window", 2500, false);
    }
    return { stored: storedItems.length, storedItems, failedItems };
  }

  async function sellNpcItems(shop, items) {
    let sold = 0;
    const soldItems = [];
    const failedItems = [];
    for (const item of items) {
      const offer = [...shop.querySelectorAll("#shop-offers .shop-offer")].find((entry) => String(entry.dataset.itemId) === String(item.itemId) && visible(entry));
      if (!offer) { failedItems.push({ ...item, error: "Item não encontrado na venda do NPC" }); continue; }
      const beforeCount = inventoryCountForItem(item.itemId);
      offer.click();
      const transaction = await waitFor("#shop-transaction", 2500, true);
      const sellButton = transaction?.querySelector(".shop-buy");
      if (!sellButton || !visible(sellButton) || sellButton.disabled) { failedItems.push({ ...item, error: "Ação de venda do NPC indisponível" }); continue; }
      sellButton.click();
      const confirmed = await waitUntil(() => {
        const currentOffer = [...shop.querySelectorAll("#shop-offers .shop-offer")].find((entry) => String(entry.dataset.itemId) === String(item.itemId) && visible(entry));
        return inventoryCountForItem(item.itemId) < beforeCount || !currentOffer;
      }, 4000, 100);
      if (!confirmed) { failedItems.push({ ...item, error: "O NPC não confirmou a venda" }); continue; }
      sold += 1;
      soldItems.push({ itemId: item.itemId, name: item.name, count: beforeCount || item.count, npcValue: item.npcValue });
    }
    return { sold, soldItems, failedItems };
  }

  async function sellItems(config = {}) {
    const opened = await openStore({ autoLeave: true }); if (!opened.ok) return opened;
    const npcTab = [...document.querySelectorAll(".trade-tab")].find((tab) => tab.dataset.tab === "npc");
    if (!npcTab || npcTab.disabled) return { ok: true, sold: 0, auctionKept: 0, message: "Mercador indisponível nesta tela; loot foi preservado" };
    npcTab.click(); const shop = await waitFor(".shop-window", 3000, true); if (!shop) return { ok: false, error: "A aba do mercador não abriu" };
    const sellTab = [...shop.querySelectorAll(".tab")].find((tab) => /vender|sell/i.test(tab.textContent || ""));
    if (!sellTab) return { ok: true, sold: 0, message: "A aba de venda ainda não foi carregada" };
    sellTab.click();
    await waitFor("#shop-offers .shop-offer", 3000, true);
    const npcOffers = readNpcSellOffers(shop);
    const byId = new Map(inventoryLootItems().map((item) => [item.itemId, item]));
    for (const offer of npcOffers) byId.set(offer.itemId, { ...(byId.get(offer.itemId) || {}), ...offer });
    const ownedItems = [...byId.values()];
    if (!ownedItems.length) return { ok: true, sold: 0, auctionListed: 0, stored: 0, message: "Nenhum item disponível para destinação" };
    const withPolicies = ownedItems.map((item) => {
      const configured = (config.items || []).find((entry) => String(entry.externalItemId) === String(item.itemId) || normalizeItemName(entry.name) === normalizeItemName(item.name));
      return { ...item, npcValue: item.npcValue ?? configured?.npcValue ?? null, policy: configuredLootPolicy(config, item) };
    });
    const defaultItems = withPolicies.filter((item) => item.policy === "default");
    const auction = defaultItems.length ? await readAuctionQuotes(defaultItems) : { ok: true, quotes: [] };
    const quotes = new Map((auction.quotes || []).map((quote) => [String(quote.itemId), quote]));
    let decisions = withPolicies.map((item) => ({ ...item, ...lootDisposition(item, auction.ok ? quotes.get(String(item.itemId)) : {}, item.policy) }));
    const auctionListed = [];
    const auctionFailed = [];
    if (auction.ok) {
      const market = firstVisible(".market-window");
      for (const item of decisions.filter((entry) => entry.destination === "auction")) {
        const listed = market ? await createAuctionSellOrder(market, item) : { ok: false, error: "Leilão indisponível" };
        if (listed.ok) auctionListed.push({ itemId: item.itemId, name: item.name, count: item.count, price: listed.price });
        else auctionFailed.push({ ...item, destination: "warehouse", reason: listed.error });
      }
    }
    decisions = decisions.filter((item) => item.destination !== "auction").concat(auctionFailed);
    const npcTabAfterAuction = [...document.querySelectorAll(".trade-tab")].find((tab) => tab.dataset.tab === "npc" && visible(tab));
    npcTabAfterAuction?.click();
    await waitFor(".shop-window", 3000, true);
    const sellTabAfterAuction = [...document.querySelectorAll(".shop-window .tab")].find((tab) => /vender|sell/i.test(tab.textContent || ""));
    sellTabAfterAuction?.click();
    await waitFor("#shop-offers .shop-offer", 3000, true);
    const npcTargets = decisions.filter((item) => item.destination === "npc");
    const npcResult = await sellNpcItems(shop, npcTargets);
    const warehouseResult = await moveItemsToWarehouse(decisions.filter((item) => item.destination === "warehouse"));
    const failed = [...(npcResult.failedItems || []), ...(warehouseResult.failedItems || [])];
    const ignored = decisions.filter((item) => item.destination === "ignore").length;
    const summary = `${npcResult.sold} vendido(s) no NPC, ${auctionListed.length} ordem(ns) criada(s), ${warehouseResult.stored} item(ns) guardado(s) e ${ignored} ignorado(s)`;
    const message = failed.length ? `${summary}; ${failed.length} item(ns) preservado(s) por segurança` : summary;
    return { ok: true, partial: failed.length > 0, ...npcResult, auctionListed: auctionListed.length, auctionItems: auctionListed, stored: warehouseResult.stored, storedItems: warehouseResult.storedItems, ignored, failedItems: failed, decisions: decisions.map(({ element, ...item }) => item), message, ...(failed.length ? { warning: `${failed.length} item(ns) não puderam ser destinados e foram preservados` } : {}) };
  }

  async function closeStore() {
    const close = document.querySelector("#trade-close") || document.querySelector(".trade-window #trade-close");
    if (!visible(document.querySelector(".trade-window"))) return { ok: true, alreadyClosed: true };
    if (!close) return { ok: false, error: "Botão para fechar a loja não encontrado" };
    close.click(); const closed = await waitFor(".trade-window", 3000, false);
    return closed ? { ok: true } : { ok: false, error: "A loja não fechou após o comando" };
  }

  globalThis.GamePilotAdapters = globalThis.GamePilotAdapters || {};
  globalThis.GamePilotAdapters.huntera = { key: "huntera", cancelPending, readState, readPartyState, prepareGroup, startHunt, startGroupHunt, acceptGroupHunt, startTraining, stopTraining, configureActions, configureAccountLoot, leaveHunt, openStore, sellItems, closeStore, selectCharacter, syncBestiary, closeBestiary };
})();
