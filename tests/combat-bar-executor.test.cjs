const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function harness() {
  const context = vm.createContext({ Date, window: { addEventListener() {}, postMessage() {} }, document: {} });
  const source = fs.readFileSync(path.join(__dirname, '../adapters/huntera.js'), 'utf8')
    .replace('  globalThis.GamePilotAdapters =', '  globalThis.factory = createCombatBarExecutor; globalThis.GamePilotAdapters =');
  vm.runInContext(source, context);
  let now = 1788799000000, saved = null;
  const clone = v => JSON.parse(JSON.stringify(v));
  const state = { name: 'Holyae', characterId: 'stable-holyae', playerId: 12, openedAt: new Date(now - 10000).toISOString(), connected: true, inTown: true,
    frame: { code: 2, receivedAt: new Date(now - 1000).toISOString(), payload: { slots: Array.from({ length: 20 }, (_, i) =>
      i === 5 ? { spellId: 'divine-missile', conditions: [] } : i === 0 ? { spellId: 'salvation', conditions: [{ value: 65 }] } : null), managed: false, blocked: [] } } };
  const clicks = [], statuses = [];
  const io = { read: () => clone(state), now: () => now, id: () => 'test', sleep: async ms => { now += ms; },
    load: () => clone(saved), save: j => { saved = clone(j); statuses.push(j.status); },
    toggle: slot => { clicks.push(slot); const action = state.frame.payload.slots[slot]; action.enabled = action.enabled === false;
      state.frame.receivedAt = new Date(++now).toISOString(); } };
  return { io, state, clicks, statuses, create: () => context.factory(io), journal: () => saved,
    fresh: () => { state.frame.receivedAt = new Date(++now).toISOString(); } };
}
test('executor persists backup before input, verifies the full bar and restores automatically', async () => {
  const h = harness(); const before = structuredClone(h.state.frame.payload);
  const result = await h.create().run('Holyae');
  assert.equal(result.status, 'restored'); assert.deepEqual(h.clicks, [5, 5]);
  assert.deepEqual(h.statuses, ['apply-requested', 'applied', 'restore-requested', 'restored']);
  assert.deepEqual(h.state.frame.payload.slots[0], before.slots[0]);
  assert.equal(h.state.frame.payload.slots[5].enabled, true);
  assert.ok(result.applied && result.restored);
});
test('failed restore retains backup and a new executor can recover after reload', async () => {
  const h = harness(); const toggle = h.io.toggle; let calls = 0;
  h.io.toggle = slot => { if (++calls === 2) throw Error('interrupted'); toggle(slot); };
  await assert.rejects(h.create().run('Holyae'), /interrupted/);
  assert.equal(h.journal().status, 'recovery-required');
  await assert.rejects(h.create().run('Holyae'), /pendente/);
  h.io.toggle = toggle;
  h.state.playerId = 99; h.state.openedAt = new Date(h.io.now()).toISOString(); h.fresh();
  const result = await h.create().recover('Holyae');
  assert.equal(result.status, 'restored'); assert.deepEqual(h.clicks, [5, 5]);
});
test('a concurrent user edit is never silently overwritten', async () => {
  const h = harness(); const toggle = h.io.toggle;
  h.io.toggle = slot => { toggle(slot); h.state.frame.payload.slots[0].conditions[0].value = 80; };
  await assert.rejects(h.create().run('Holyae'), /barra diferente/);
  await assert.rejects(h.create().recover('Holyae'), /editada fora/);
  assert.equal(h.clicks.length, 1); assert.equal(h.state.frame.payload.slots[0].conditions[0].value, 80);
});
test('no acknowledgement never triggers a blind second toggle', async () => {
  const h = harness(); h.io.toggle = slot => h.clicks.push(slot);
  await assert.rejects(h.create().run('Holyae'), /prazo/);
  await assert.rejects(h.create().recover('Holyae'), /novo frame/);
  assert.deepEqual(h.clicks, [5]);
  h.fresh(); assert.equal((await h.create().recover('Holyae')).status, 'restored');
  assert.deepEqual(h.clicks, [5]);
});
test('failed backup, wrong identity, disconnected socket and hunt prevent input', async () => {
  for (const mutate of [h => h.io.save = () => { throw Error('storage full'); }, h => h.state.name = 'Other',
    h => h.state.connected = false, h => h.state.inTown = false]) {
    const h = harness(); mutate(h); await assert.rejects(h.create().run('Holyae')); assert.equal(h.clicks.length, 0);
  }
});

test('recovery rejects a different stable character even with the same display name', async () => {
  const h = harness(); const toggle = h.io.toggle; let calls = 0;
  h.io.toggle = slot => { if (++calls === 2) throw Error('interrupted'); toggle(slot); };
  await assert.rejects(h.create().run('Holyae'));
  h.state.characterId = 'another-character'; h.io.toggle = toggle; h.fresh();
  await assert.rejects(h.create().recover('Holyae'), /mudou/);
  assert.deepEqual(h.clicks, [5]);
});
