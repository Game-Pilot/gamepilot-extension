const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function harness(expected, actual, level = 120) {
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  const events = [], selections = [];
  const c = vm.createContext({ Date, automationEnabled: true, automationPayload: { characterName: expected },
    automationActions: [1], automationConfig: {}, lastOperationError: null,
    persistAutomationState() {}, sendEvent(e) { events.push(e); },
    arrowSwitchBusy: false, commandBusy: false, automationBusy: false,
    lastArrowSwitchAttemptAt: 0, ARROW_SWITCH_RETRY_MS: 1000,
    arrowSwitchSettings: () => ({ multiTargetMinCreatures: 2, multiTargetArrowId: 35901, singleTargetArrowId: 15793 }),
    GamePilotAdapters: { huntera: { async selectAmmo(id) { selections.push(id); return { ok: true }; } } }
  });
  vm.runInContext(source.slice(source.indexOf('function validateAutomationCharacter('), source.indexOf('function scheduleArrowSwitchCycle(')), c);
  return { c, events, selections, state: { character: { name: actual, level }, inHunt: true,
    socket: { fresh: true }, ammunition: { kind: 'arrow', arrow: 15793 }, creaturesOnScreen: { count: 3 } } };
}
test('character change and legacy unbound profile disable automation before ammo selection', async () => {
  for (const expected of ['Namiz', '']) {
    const h = harness(expected, 'Holyae'); await h.c.runArrowSwitchCycle(h.state);
    assert.equal(h.c.automationEnabled, false); assert.equal(h.selections.length, 0); assert.equal(h.events.length, 1);
  }
});
test('reconnection with no loaded character pauses without discarding the bound identity', async () => {
  const h = harness('Holyae', ''); await h.c.runArrowSwitchCycle(h.state);
  assert.equal(h.c.automationEnabled, true); assert.equal(h.selections.length, 0);
});
test('Diamond is never selected below 150; an eligible bound character can switch', async () => {
  const low = harness('Holyae', 'Holyae', 120); await low.c.runArrowSwitchCycle(low.state);
  assert.deepEqual(low.selections, []);
  const high = harness('Paladin', 'Paladin', 150); await high.c.runArrowSwitchCycle(high.state);
  assert.deepEqual(high.selections, [35901]);
});
