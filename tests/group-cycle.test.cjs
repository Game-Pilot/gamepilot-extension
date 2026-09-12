const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
function harness() {
  const calls = [], events = [];
  const state = { character: { name: 'Leader' }, inTown: true, inHunt: false };
  const c = vm.createContext({ Date, console, mode: 'hunting', automationEnabled: true, automationBusy: false, commandBusy: false, interrupting: false,
    automationConfig: {}, automationActions: [], automationPayload: { operation: 'group-hunt', group: { id: 'g', startCommandId: 'start' } },
    completedCommands: new Map(), validateAutomationCharacter: () => true, thresholdReached: () => true,
    showBanner() {}, persistAutomationState() { calls.push('persist'); },
    sendEvent: async e => events.push(e), reportCommand: async () => {}, rememberCompletedCommand: () => {},
    sellAndCloseStore: async () => { calls.push('sell'); return { ok: true }; },
    GamePilotAdapters: { huntera: { readState: () => state, leaveHunt: async () => { calls.push('leave'); return { ok: true }; },
      openStore: async () => { calls.push('shop'); return { ok: true }; } } }
  });
  vm.runInContext(source.slice(source.indexOf('async function handleCommand('), source.indexOf('function thresholdReached(')), c);
  vm.runInContext(source.slice(source.indexOf('async function runAutomationCycle('), source.indexOf('async function runAutoTrainingCycle(')), c);
  vm.runInContext(source.slice(source.indexOf('function operationReport('), source.indexOf('function acceptAgentCommand(')), c);
  return { c, calls, events, state };
}
test('account loot return percentage overrides the legacy hunt threshold', () => {
  const c = vm.createContext({ automationPayload: { loot: { backpackReturnPercent: 60 } }, automationConfig: { backpackReturnPercent: 90 }, lastReturnAt: 0, RETURN_COOLDOWN_MS: 30000, Date });
  vm.runInContext(source.slice(source.indexOf('function thresholdReached('), source.indexOf('function arrowSwitchSettings(')), c);
  assert.equal(c.thresholdReached({ backpack: { percent: 70 } }), true);
  assert.equal(c.thresholdReached({ backpack: { percent: 50 } }), false);
});
test('full bag requests coordination even if Huntera already returned to town', async () => {
  for (const inHunt of [true, false]) {
    const h = harness(); await h.c.runAutomationCycle({ ...h.state, inHunt });
    assert.equal(h.c.mode, 'resupply-requested'); assert.equal(h.c.automationEnabled, false);
    assert.deepEqual(h.calls, ['persist']);
    assert.equal(h.c.operationReport({ inHunt }).phase, 'resupply-requested');
  }
});
test('dispatches hunt loot before requesting a coordinated return', async () => {
  const h = harness();
  h.state.inHunt = true; h.state.inTown = false;
  h.c.GamePilotAdapters.huntera.dispatchHuntLoot = async () => { h.calls.push('dispatch'); return { ok: true, dispatched: true, itemCount: 3 }; };
  h.c.GamePilotAdapters.huntera.readState = () => ({ ...h.state, backpack: { percent: 40 } });
  h.c.thresholdReached = state => Number(state?.backpack?.percent) >= 85;
  await h.c.runAutomationCycle({ ...h.state, backpack: { percent: 90 } });
  assert.deepEqual(h.calls, ['dispatch']);
  assert.equal(h.c.mode, 'hunting');
  assert.equal(h.c.automationEnabled, true);
  assert.ok(h.events.some(e => e.type === 'items.dispatched'));
});
test('uses account autosell while hunting before the bag reaches the return limit', async () => {
  const h = harness();
  h.state.inHunt = true; h.state.inTown = false;
  h.c.automationPayload.loot = { useAutoSell: true, backpackReturnPercent: 85 };
  h.c.GamePilotAdapters.huntera.dispatchHuntLoot = async () => { h.calls.push('dispatch'); return { ok: true, dispatched: true, itemCount: 1 }; };
  h.c.GamePilotAdapters.huntera.readState = () => ({ ...h.state, backpack: { percent: 35 } });
  h.c.thresholdReached = state => Number(state?.backpack?.percent) >= 85;
  await h.c.runAutomationCycle({ ...h.state, backpack: { percent: 40 } });
  assert.deepEqual(h.calls, ['dispatch']);
  assert.equal(h.c.mode, 'hunting');
  assert.equal(h.events.find(e => e.type === 'items.dispatched')?.details?.reason, 'autosell-available');
});
test('falls back to the coordinated return when hunt loot dispatch fails', async () => {
  const h = harness();
  h.state.inHunt = true; h.state.inTown = false;
  h.c.GamePilotAdapters.huntera.dispatchHuntLoot = async () => { h.calls.push('dispatch'); throw new Error('dispatch failed'); };
  await h.c.runAutomationCycle({ ...h.state, backpack: { percent: 90 } });
  assert.deepEqual(h.calls, ['dispatch', 'persist']);
  assert.equal(h.c.mode, 'resupply-requested');
  assert.ok(h.events.some(e => e.type === 'items.dispatch-failed'));
});
test('skips hunt autosell when the account loot setting disables it', async () => {
  const h = harness();
  h.state.inHunt = true; h.state.inTown = false;
  h.c.automationPayload.loot = { useAutoSell: false, backpackReturnPercent: 85 };
  h.c.GamePilotAdapters.huntera.dispatchHuntLoot = async () => { h.calls.push('dispatch'); return { ok: true, dispatched: true }; };
  await h.c.runAutomationCycle({ ...h.state, backpack: { percent: 90 } });
  assert.deepEqual(h.calls, ['persist']);
  assert.equal(h.c.mode, 'resupply-requested');
  assert.ok(!h.events.some(e => e.type === 'items.dispatched'));
});
test('coordinated command returns, sells and preserves the original hunt identity while waiting', async () => {
  const h = harness(); await h.c.handleCommand('group-resupply', 'sell', { operation: 'group-hunt', characterName: 'Leader', group: { id: 'g', sourceStartCommandId: 'start' } });
  assert.deepEqual(h.calls, ['leave', 'shop', 'sell', 'persist']);
  assert.equal(h.c.mode, 'resupply-ready'); assert.equal(h.c.operationReport(h.state).group.startCommandId, 'start');
  assert.ok(h.events.some(e => e.type === 'group.member-returned'));
});
test('sale failure and wrong character never signal readiness', async () => {
  for (const wrongCharacter of [true, false]) {
    const h = harness();
    if (!wrongCharacter) h.c.sellAndCloseStore = async () => ({ ok: false, error: 'sale failed' });
    await h.c.handleCommand('group-resupply', 'sell', { operation: 'group-hunt', characterName: wrongCharacter ? 'Other' : 'Leader', group: { id: 'g', sourceStartCommandId: 'start' } });
    assert.equal(h.c.mode, 'error'); assert.ok(!h.events.some(e => e.type === 'group.member-returned'));
  }
});
test('stop during the coordinated return prevents the sale and readiness', async () => {
  const h = harness();
  h.c.GamePilotAdapters.huntera.leaveHunt = async () => { h.c.interrupting = true; return { ok: true }; };
  await h.c.handleCommand('group-resupply', 'sell', { operation: 'group-hunt', characterName: 'Leader', group: { id: 'g', sourceStartCommandId: 'start' } });
  assert.ok(!h.calls.includes('sell'));
  assert.ok(!h.events.some(e => e.type === 'group.member-returned'));
});
test('automatic restart preserves live action changes and rejects obsolete cycles', async () => {
  const h = harness(); h.c.mode = 'resupply-ready';
  h.c.automationActions = [{ actionKey: 'updated' }];
  h.c.appliedActionRules = rules => rules;
  h.c.GamePilotAdapters.huntera.configureActions = async rules => { assert.equal(rules[0].actionKey, 'updated'); return { ok: true }; };
  h.c.GamePilotAdapters.huntera.startGroupHunt = async () => ({ ok: true });
  const payload = { operation: 'group-hunt', characterName: 'Leader', group: { id: 'g', role: 'leader', cycle: 'cycle', sourceStartCommandId: 'start' } };
  await h.c.handleCommand('start-hunt', 'next', payload);
  assert.equal(h.c.mode, 'hunting');
  assert.equal(h.c.automationPayload.group.startCommandId, 'next');
  await h.c.handleCommand('start-hunt', 'stale', payload);
  assert.equal(h.c.mode, 'error');
});
