const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function harness() {
  let now = 100000;
  const calls = [];
  const payload = { characterName: 'Knight', hunt: { monster: 'dragon' }, loot: { bank: true }, bestiary: { enabled: true } };
  let state = { detected: false, characterSelection: true, socket: { connected: false } };
  const adapter = {
    readState: () => state,
    selectCharacter: async () => { calls.push('select'); return { ok: false }; },
    configureActions: async () => { calls.push('configure'); return { ok: true }; },
    startHunt: async p => { calls.push(p); return { ok: true }; }
  };
  const c = vm.createContext({ Date: class extends Date { static now() { return now; } },
    automationEnabled: true, automationPayload: payload, accountLootConfig: null, automationConfig: payload.hunt, automationActions: [{ actionKey: 'heal' }],
    recoveryPending: false, lastRecoveryAttemptAt: 0, characterSelectionSince: 0, recoveryNoticeSent: false,
    mode: 'hunting', automationBusy: false, commandBusy: false, interrupting: false, lastOperationError: null,
    RECOVERY_CONFIRM_MS: 5000, RECOVERY_RETRY_MS: 30000, RECOVERY_RELOAD_MS: 60000,
    persistAutomationState() {}, showBanner() {}, sendEvent: e => calls.push(e.type),
    location: { reload: () => calls.push('reload') }, GamePilotAdapters: { huntera: adapter }
  });
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function validateAutomationCharacter('), source.indexOf('async function runArrowSwitchCycle(')), c);
  vm.runInContext(source.slice(source.indexOf('async function runRecoveryCycle('), source.indexOf('let lastStatePostAt')), c);
  return { c, calls, adapter, payload, setState: s => state = s, tick: async ms => { now += ms; await c.runRecoveryCycle(state); } };
}
const town = { detected: true, character: { name: 'Knight' }, inTown: true, socket: { connected: true } };
test('retries for over an hour then resumes with the entire original configuration', async () => {
  const h = harness();
  await h.tick(0); await h.tick(5000);
  for (let i = 0; i < 125; i++) await h.tick(30000);
  assert.equal(h.c.automationEnabled, true);
  assert.equal(h.c.recoveryPending, true);
  assert.equal(h.calls.filter(x => x === 'select').length, 126);
  h.adapter.selectCharacter = async () => { h.setState(town); return { ok: true }; };
  await h.tick(30000);
  const p = h.calls.find(x => typeof x === 'object');
  assert.equal(p.loot, h.payload.loot); assert.equal(p.bestiary, h.payload.bestiary);
  assert.equal(p.resume, true); assert.equal(h.c.recoveryPending, false);
});
test('short selection shell does not start recovery; attempts obey cooldown', async () => {
  const h = harness(); await h.tick(0); await h.tick(3000);
  assert.deepEqual(h.calls, []);
  await h.tick(2000); await h.tick(3000);
  assert.equal(h.calls.filter(x => x === 'select').length, 1);
});
test('closed socket with stale hunt DOM reloads after grace period', async () => {
  const h = harness(); h.setState({ ...town, inHunt: true, socket: { connected: false } });
  await h.tick(0); await h.tick(5000); await h.tick(55000);
  assert.equal(h.calls.filter(x => x === 'reload').length, 1);
  assert.equal(h.c.recoveryPending, true);
});
test('already restored hunt reapplies actions without starting another hunt', async () => {
  const h = harness(); h.c.recoveryPending = true; h.setState({ ...town, inHunt: true });
  await h.tick(0); assert.ok(h.calls.includes('configure'));
  assert.equal(h.calls.some(x => typeof x === 'object'), false);
});
test('stop and character changes prevent restart', async () => {
  const h = harness(); h.c.recoveryPending = true; h.c.automationEnabled = false;
  await h.tick(0); assert.deepEqual(h.calls, []);
  h.c.automationEnabled = true; h.c.recoveryPending = true;
  h.setState({ ...town, character: { name: 'Other' } }); await h.tick(30000);
  assert.equal(h.c.automationEnabled, false); assert.equal(h.calls.includes('configure'), false);
});
test('stop during action configuration prevents a subsequent start', async () => {
  const h = harness(); h.c.recoveryPending = true; h.setState(town);
  h.adapter.configureActions = async () => { h.c.automationEnabled = false; return { ok: true }; };
  await h.tick(0); assert.equal(h.calls.some(x => typeof x === 'object'), false);
});

test('failed hunt restart retains intent and retries without dropping configuration', async () => {
  const h = harness(); h.c.recoveryPending = true; h.setState(town);
  h.adapter.startHunt = async () => ({ ok: false, error: 'server save' });
  await h.tick(0); assert.equal(h.c.recoveryPending, true); assert.equal(h.c.automationEnabled, true);
  h.adapter.startHunt = async p => { h.calls.push(p); return { ok: true }; };
  await h.tick(30000); assert.equal(h.c.recoveryPending, false);
});
test('group recovery uses the configured leader or follower operation', async () => {
  for (const role of ['leader', 'member']) {
    const h = harness(); h.payload.operation = 'group-hunt'; h.payload.group = { id: 'party', role };
    h.c.recoveryPending = true; h.setState(town);
    h.adapter.startGroupHunt = async p => { h.calls.push('leader'); assert.equal(p.group.id, 'party'); return { ok: true }; };
    h.adapter.acceptGroupHunt = async () => { h.calls.push('member'); return { ok: true }; };
    await h.tick(0); assert.ok(h.calls.includes(role)); assert.equal(h.c.recoveryPending, false);
  }
});
test('page reload preserves pending recovery and the retry timestamp', async () => {
  const h = harness(); const storage = new Map();
  h.c.sessionStorage = { setItem: (k,v) => storage.set(k,v), getItem: k => storage.get(k) };
  h.c.AUTOMATION_KEY = 'automation';
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function persistAutomationState('), source.indexOf('function showBanner(')), h.c);
  h.c.recoveryPending = true; h.c.lastRecoveryAttemptAt = 99000; h.c.persistAutomationState();
  h.c.recoveryPending = false; h.c.lastRecoveryAttemptAt = 0; h.c.automationPayload = {};
  h.c.restoreAutomationState();
  assert.equal(h.c.recoveryPending, true); assert.equal(h.c.lastRecoveryAttemptAt, 99000);
  assert.equal(h.c.automationPayload.characterName, 'Knight');
  h.setState(town); await h.tick(0); assert.deepEqual(h.calls, []);
});
