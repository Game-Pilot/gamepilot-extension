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

function adapter(cards = []) {
  const context = vm.createContext({
    setTimeout, clearTimeout, Date, console,
    window: { setTimeout, addEventListener() {}, postMessage() {}, getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    document: { querySelectorAll: (selector) => selector === ".party-invite" ? cards : [], querySelector: () => null }
  });
  let source = fs.readFileSync(path.join(__dirname, "../adapters/huntera.js"), "utf8");
  source = source.replace("  globalThis.GamePilotAdapters =", `
    globalThis.testAdapter = { findInviteCard, clickInviteAction, waitUntil, cancelPending, prepareGroup,
      configureFixture(fixture) {
        readState = fixture.readState;
        characterSelectionVisible = () => false;
        readPartyState = fixture.readPartyState;
        stopTraining = fixture.stopTraining;
        waitForPartyMembers = fixture.waitForPartyMembers;
        setPartyTarget = fixture.setPartyTarget;
        enableSharedCosts = fixture.enableSharedCosts;
      }
    };
    globalThis.GamePilotAdapters =`);
  vm.runInContext(source, context);
  return context.testAdapter;
}

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
