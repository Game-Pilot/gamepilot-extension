const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function invitation(title, sender, members = "IACosta · Master Sorcerer", hunt = false) {
  const buttons = [0, 1].map(() => ({ hidden: false, disabled: false, clicks: 0,
    getBoundingClientRect: () => ({ width: 100, height: 30 }), click() { this.clicks++; } }));
  return {
    hidden: false, textContent: `${title} ${sender} invites you to their party ${members}`,
    getAttribute: () => title, getBoundingClientRect: () => ({ width: 300, height: 180 }),
    querySelector: (selector) => selector === ".invite-title" ? { textContent: title }
      : selector === ".invite-msg" ? { textContent: `${sender} ${/Convite|Rateio/.test(title) ? "convidou você para a party" : "invites you to their party"}` }
      : selector.includes("hunt.png") && hunt ? {} : null,
    querySelectorAll: (selector) => selector === ".invite-actions button" ? buttons : [], buttons
  };
}

function adapter(cards = [], lootControls = []) {
  class FakeDataTransfer {
    constructor() { this.values = new Map(); this.effectAllowed = "none"; }
    setData(type, value) { this.values.set(type, value); }
    getData(type) { return this.values.get(type) || ""; }
  }
  class FakeDragEvent {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  }
  const context = vm.createContext({
    setTimeout, clearTimeout, Date, console, DataTransfer: FakeDataTransfer, DragEvent: FakeDragEvent,
    window: { setTimeout, addEventListener() {}, postMessage() {}, getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    document: { querySelectorAll: (selector) => selector === ".party-invite" ? cards : selector.includes(".hunt-loot-auto") ? lootControls : [], querySelector: () => null }
  });
  let source = fs.readFileSync(path.join(__dirname, "../adapters/huntera.js"), "utf8");
  source = source.replace("  globalThis.GamePilotAdapters =", `
    globalThis.testAdapter = { findInviteCard, clickInviteAction, waitUntil, cancelPending, prepareGroup, configureLoot, configureAccountLoot, lootDisposition, configuredLootPolicy, inventoryRefsForItem, dispatchSlotMove, normalizeBestiaryStage, bestiaryStageProgress, socketBestiarySnapshot, bestiaryCompletedPhases,
      configureFixture(fixture) {
        readState = fixture.readState;
        characterSelectionVisible = () => false;
        readPartyState = fixture.readPartyState;
        stopTraining = fixture.stopTraining;
        waitForPartyMembers = fixture.waitForPartyMembers;
        setPartyTarget = fixture.setPartyTarget;
        enableSharedCosts = fixture.enableSharedCosts;
        if (fixture.inventory) socketState.inventory = copyInventory(fixture.inventory);
        if (fixture.bestiarySocket) {
          socketState.bestiaryCatalog = fixture.bestiarySocket.catalog || [];
          socketState.bestiaryKills = fixture.bestiarySocket.kills || {};
          socketState.bestiaryStages = fixture.bestiarySocket.stages || {};
          socketState.bestiaryReceived = fixture.bestiarySocket.received !== false;
          socketState.bestiaryFullSnapshot = fixture.bestiarySocket.fullSnapshot !== false;
        }
      }
    };
    globalThis.GamePilotAdapters =`);
  vm.runInContext(source, context);
  return context.testAdapter;
}

test("preserves the current Huntera Bestiary goal for each creature", () => {
  const api = adapter();
  const phaseOne = api.normalizeBestiaryStage("1.168", "2.500");
  assert.deepEqual({ currentKills: phaseOne.currentKills, targetKills: phaseOne.targetKills, completed: phaseOne.completed }, {
    currentKills: 1168, targetKills: 2500, completed: false
  });
  const phaseTwo = api.normalizeBestiaryStage("269", "5.000", false, 1);
  assert.deepEqual({ currentKills: phaseTwo.currentKills, targetKills: phaseTwo.targetKills, absoluteKills: phaseTwo.absoluteKills, completed: phaseTwo.completed }, {
    currentKills: 269, targetKills: 5000, absoluteKills: 2769, completed: true
  });
  const ready = api.normalizeBestiaryStage("5.000", "5.000", true, 1);
  assert.deepEqual({ currentKills: ready.currentKills, targetKills: ready.targetKills, absoluteKills: ready.absoluteKills, rewardReady: ready.rewardReady }, {
    currentKills: 5000, targetKills: 5000, absoluteKills: 7500, rewardReady: true
  });
});

test("reads Huntera completed phases from the star badge", () => {
  const api = adapter();
  const badge = {
    textContent: "★1",
    dataset: {},
    getAttribute(name) { return name === "title" ? "Stage 1 unlocked" : null; }
  };
  const card = { textContent: "Rat ★1 0 / 5.000", querySelector: () => badge };
  assert.equal(api.bestiaryCompletedPhases(card), 1);
});

test("derives per-creature stage progress from wire-9", () => {
  const api = adapter();
  const phaseOne = api.bestiaryStageProgress(2500, 1168, 0);
  assert.deepEqual({ stage: phaseOne.stage, phase: phaseOne.phase, currentKills: phaseOne.currentKills, targetKills: phaseOne.targetKills, absoluteKills: phaseOne.absoluteKills, baselineComplete: phaseOne.baselineComplete }, {
    stage: 0, phase: 1, currentKills: 1168, targetKills: 2500, absoluteKills: 1168, baselineComplete: false
  });
  const phaseTwo = api.bestiaryStageProgress(2500, 2769, 0);
  assert.deepEqual({ stage: phaseTwo.stage, phase: phaseTwo.phase, currentKills: phaseTwo.currentKills, targetKills: phaseTwo.targetKills, absoluteKills: phaseTwo.absoluteKills, baselineComplete: phaseTwo.baselineComplete }, {
    stage: 1, phase: 2, currentKills: 269, targetKills: 5000, absoluteKills: 2769, baselineComplete: true
  });
  const rat = api.bestiaryStageProgress(2500, 7506, 1);
  assert.deepEqual({ stage: rat.stage, phase: rat.phase, currentKills: rat.currentKills, targetKills: rat.targetKills, absoluteKills: rat.absoluteKills, completedPhases: rat.completedPhases }, {
    stage: 2, phase: 3, currentKills: 6, targetKills: 10000, absoluteKills: 7506, completedPhases: 2
  });
});

test("builds a complete mixed-goal snapshot from wire-26 and accumulated wire-9 data", () => {
  const api = adapter();
  api.configureFixture({ bestiarySocket: {
    catalog: [
      { id: "amazon", name: "Amazon", killsRequired: 2500 },
      { id: "rat", name: "Rat", killsRequired: 2500 },
      { id: "spider", name: "Spider", killsRequired: 2500 }
    ],
    kills: { amazon: 1168, rat: 2769, spider: 3213 },
    stages: { rat: 0, spider: 0 }
  } });
  const snapshot = JSON.parse(JSON.stringify(api.socketBestiarySnapshot()));
  assert.equal(snapshot.length, 3);
  assert.deepEqual(snapshot.map(({ name, currentKills, targetKills, absoluteKills, phase, baselineComplete }) => ({ name, currentKills, targetKills, absoluteKills, phase, baselineComplete })), [
    { name: "Amazon", currentKills: 1168, targetKills: 2500, absoluteKills: 1168, phase: 1, baselineComplete: false },
    { name: "Rat", currentKills: 269, targetKills: 5000, absoluteKills: 2769, phase: 2, baselineComplete: true },
    { name: "Spider", currentKills: 713, targetKills: 5000, absoluteKills: 3213, phase: 2, baselineComplete: true }
  ]);
});

test("does not use a partial wire-9 payload as a complete sync", () => {
  const api = adapter();
  api.configureFixture({ bestiarySocket: {
    catalog: [{ id: "rat", name: "Rat", killsRequired: 2500 }, { id: "spider", name: "Spider", killsRequired: 2500 }],
    kills: { rat: 7506 },
    stages: { rat: 1 },
    fullSnapshot: false
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(api.socketBestiarySnapshot())), []);
});

for (const title of ["Party invitation", "Convite de party", "Convite para o grupo"]) {
  test(`recognizes ${title} with IACosta as sender and member`, () => {
    const card = invitation(title, "IACosta");
    const api = adapter([card]);
    assert.equal(api.findInviteCard("party", "IACosta"), card);
    assert.equal(api.findInviteCard("costs"), null);
    assert.equal(api.clickInviteAction(card), true);
    assert.equal(card.buttons[0].clicks, 1);
    assert.equal(card.buttons[1].clicks, 0);
  });
}

test("does not accept unrelated senders or confuse cost and hunt invitations with party", () => {
  const cost = invitation("Hunt cost sharing", "IACosta");
  const team = invitation("Team hunt invitation", "IACosta", "", true);
  const other = invitation("Party invitation", "Inarius Other");
  const api = adapter([cost, team, other]);
  assert.equal(api.findInviteCard("party", "Inarius"), null);
  assert.equal(api.findInviteCard("costs", "IACosta"), cost);
  assert.equal(api.findInviteCard("team"), team);
});

test("recognizes the game's Portuguese cost-sharing title", () => {
  const card = invitation("Rateio da hunt", "IACosta");
  const api = adapter([card]);
  assert.equal(api.findInviteCard("costs", "IACosta"), card);
  assert.equal(api.findInviteCard("party", "IACosta"), null);
});

test("account loot policies override the default market decision", () => {
  const api = adapter();
  const config = { items: [
    { externalItemId: "10", name: "Dragon Ham", policy: "warehouse" },
    { externalItemId: "11", name: "Halberd", policy: "npc" }
  ] };
  assert.equal(api.configuredLootPolicy(config, { itemId: "10", name: "Dragon Ham" }), "warehouse");
  assert.equal(api.configuredLootPolicy(config, { itemId: "11", name: "Halberd" }), "npc");
  assert.equal(api.configuredLootPolicy(config, { itemId: "12", name: "Plate Armor" }), "default");
});

test("ignore policy disables collection while other account policies enable it", async () => {
  function lootControl(itemId, name, checked) {
    const entry = { hidden: false, dataset: { itemId }, getBoundingClientRect: () => ({ width: 100, height: 30 }), querySelector: () => ({ textContent: name }) };
    return { disabled: false, checked, dataset: { itemId }, closest: () => entry, click() { this.checked = !this.checked; } };
  }
  const ignored = lootControl("10", "Dragon Ham", true);
  const kept = lootControl("11", "Halberd", false);
  const api = adapter([], [ignored, kept]);
  const result = await api.configureLoot({}, { version: 1, items: [
    { externalItemId: "10", name: "Dragon Ham", policy: "ignore" },
    { externalItemId: "11", name: "Halberd", policy: "npc" }
  ] });
  assert.equal(result.changed, 2);
  assert.equal(ignored.checked, false);
  assert.equal(kept.checked, true);
});

test("default loot uses the lowest sell offer and only auctions above NPC", () => {
  const api = adapter();
  const item = { itemId: "10", name: "Dragon Ham", npcValue: 100 };
  assert.deepEqual({ ...api.lootDisposition(item, { found: true, sellPrices: [140, 120] }, "default") }, { destination: "auction", reason: "oferta de venda maior que o NPC", sellPrice: 120 });
  assert.equal(api.lootDisposition(item, { found: true, sellPrices: [100] }, "default").destination, "npc");
  assert.equal(api.lootDisposition(item, { found: true, sellPrices: [80] }, "default").destination, "npc");
});

test("default loot falls back to NPC without a quote and only stores items without NPC value", () => {
  const api = adapter();
  assert.equal(api.lootDisposition({ npcValue: 100 }, { found: false, sellPrices: [] }, "default").destination, "npc");
  assert.equal(api.lootDisposition({ npcValue: null }, { found: true, sellPrices: [200] }, "default").destination, "warehouse");
  assert.equal(api.lootDisposition({ npcValue: 100 }, { found: true, sellPrices: [200] }, "warehouse").destination, "warehouse");
  assert.equal(api.lootDisposition({ npcValue: 100 }, {}, "npc").destination, "npc");
  assert.equal(api.lootDisposition({ npcValue: 100 }, {}, "ignore").destination, "ignore");
});

test("maps current Huntera backpack and satchel entries to stable slot references", () => {
  const api = adapter();
  api.configureFixture({
    inventory: {
      slots: [{ itemId: 10, name: "Dragon Ham", count: 2 }, null, { itemId: 11, name: "Halberd", count: 1 }],
      satchel: [{ itemId: 10, name: "Dragon Ham", count: 4 }]
    }
  });
  const refs = JSON.parse(JSON.stringify(api.inventoryRefsForItem("10").map(({ container, index, item }) => ({ container, index, count: item.count }))));
  assert.deepEqual(refs, [
    { container: "backpack", index: 0, count: 2 },
    { container: "satchel", index: 0, count: 4 }
  ]);
});

test("moves a Huntera inventory slot with the game's current drag payload", () => {
  const api = adapter();
  const events = [];
  const source = { dispatchEvent(event) { events.push({ target: "source", event }); } };
  const target = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 40, height: 40 }),
    dispatchEvent(event) { events.push({ target: "target", event }); }
  };
  assert.equal(api.dispatchSlotMove(source, target, { container: "backpack", index: 3 }), true);
  assert.deepEqual(events.map(({ target: eventTarget, event }) => [eventTarget, event.type]), [
    ["source", "dragstart"], ["target", "dragover"], ["target", "drop"], ["source", "dragend"]
  ]);
  assert.equal(events[2].event.dataTransfer.getData("application/x-slot-ref"), '{"container":"backpack","index":3}');
});

test("cancelling a pending invitation aborts the wait and allows the next operation", async () => {
  const api = adapter();
  let accepted = false;
  const waiting = api.waitUntil(() => accepted, 60000, 5);
  api.cancelPending();
  await assert.rejects(waiting, /cancelada/);
  accepted = true;
  assert.equal(await api.waitUntil(() => accepted, 100, 5), true);
});

test("initialization stops training before any party actions; follower accepts IACosta", async () => {
  const card = invitation("Party invitation", "IACosta");
  const api = adapter([card]);
  const actions = [];
  let training = true;
  api.configureFixture({
    readState: () => ({ inHunt: false, training: { active: training } }),
    readPartyState: () => ({ members: [] }),
    stopTraining: async () => { actions.push("stop-training"); training = false; return { ok: true }; },
    waitForPartyMembers: async () => { actions.push("members-confirmed"); return true; },
    setPartyTarget: async () => { actions.push("target"); return { ok: true }; },
    enableSharedCosts: async () => { actions.push("costs"); return { ok: true }; }
  });
  const group = { role: "follower", leaderCharacterId: "1", members: [
    { characterId: "1", name: "IACosta" }, { characterId: "2", name: "Inarius" }
  ] };
  assert.equal((await api.prepareGroup({ group: { ...group, phase: "initialize" } })).ok, true);
  assert.deepEqual(actions, ["stop-training"]);
  assert.equal(card.buttons[0].clicks, 0);
  assert.equal((await api.prepareGroup({ group })).ok, true);
  assert.equal(card.buttons[0].clicks, 1);
  assert.deepEqual(actions, ["stop-training", "members-confirmed", "target", "costs"]);
});
