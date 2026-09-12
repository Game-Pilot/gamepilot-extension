const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../economy-observation.js');
const msg = (sequence, code, payload) => ({ sequence, code, payload,
  receivedAt: new Date(1789000000000 + sequence * 1000).toISOString() });
const loot = (count = 1) => ({ uid: 42, itemId: 333, count, name: 'Sword' });

test('snapshots initialize inventory and prices without replaying gains or uses', () => {
  const p = create();
  p.accept(msg(1, 74, { slots: [loot()], satchel: [], gold: 100 }), 7, true);
  p.accept(msg(2, 57, { npc: [[333, 10]] }), 7, true);
  p.accept(msg(3, 57, { auction: [[333, 30]] }), 7, true);
  p.accept(msg(4, 60, { item: loot() }), 7, true, true);
  p.accept(msg(5, 24, { id: 7, kind: 'spell', itemId: 238 }), 7, true, true);
  const s = p.read();
  assert.equal(s.inventory.gold, 100);
  assert.deepEqual(s.prices, { npc: [[333, 10]], auction: [[333, 30]] });
  assert.deepEqual(s.drops, {}); assert.deepEqual(s.uses, {});
  assert.equal(s.events.length, 0);
});

test('counts own active consumables and drops exactly once, preserving distinct drop events', () => {
  const p = create();
  p.accept(msg(1, 24, { id: 8, kind: 'spell', itemId: 238 }), 7, false, true);
  p.accept(msg(2, 24, { id: 7, kind: 'spell', itemId: 238 }), 7, false, false);
  p.accept(msg(3, 24, { id: 7, kind: 'spell', itemId: 238, text: 'not retained' }), 7, false, true);
  p.accept(msg(3, 24, { id: 7, kind: 'spell', itemId: 238 }), 7, false, true);
  p.accept(msg(4, 60, { item: loot(2) }), 7, false, true);
  p.accept(msg(5, 59, { item: loot(2) }), 7, false, true);
  p.accept(msg(6, 60, { item: loot(1) }), 7, false, true);
  const s = p.read();
  assert.deepEqual(s.uses, { 238: 1 });
  assert.equal(s.drops[333].count, 3);
  assert.equal(s.drops[333].events, 2);
  assert.ok(!JSON.stringify(s).includes('not retained'));
});

test('wallet and backpack deltas reconcile sales without treating them as drops', () => {
  const p = create();
  p.accept(msg(1, 74, { slots: [loot(3)], satchel: [], gold: 100 }), 7, true);
  p.accept(msg(2, 55, { changes: [{ container: 'backpack', index: 0, item: null }],
    slotCount: 1, satchelCount: 0, gold: 130 }), 7, false, true);
  p.accept(msg(2, 55, { changes: [], slotCount: 1, satchelCount: 0, gold: 999 }), 7, false, true);
  const s = p.read();
  assert.equal(s.inventory.gold, 130); assert.equal(s.inventory.slots[0], null);
  assert.equal(s.events[0].payload.previousGold, 100);
  assert.deepEqual(s.drops, {});
  s.inventory.gold = 999;
  assert.equal(p.read().inventory.gold, 130);
});

test('retention gaps are explicit and reconnect clears all captured state', () => {
  const p = create();
  for (let n = 1; n <= 1300; n++) p.accept(msg(n, 60, { item: loot() }), 7, false, true);
  const s = p.read();
  assert.ok(s.droppedEvents > 0); assert.ok(s.events.length <= 1200);
  assert.equal(s.drops[333].count, 1300);
  p.reset();
  assert.equal(p.read().inventory, null); assert.equal(p.read().events.length, 0);
  assert.equal(p.read().lastSequence, 0);
  assert.deepEqual(p.read().drops, {});
});

test('session transitions are tagged so consumers can reject mixed-session windows', () => {
  const p = create();
  p.accept(msg(1, 40, { startedAt: 100, durationMs: 0 }), 7);
  p.accept(msg(2, 60, { item: loot() }), 7, false, true);
  p.accept(msg(3, 40, { startedAt: 200, durationMs: 0 }), 7);
  p.accept(msg(4, 60, { item: loot() }), 7, false, true);
  assert.deepEqual(p.read().events.map(e => e.sessionStartedAt), [100, 100, 200, 200]);
});

test('adapter includes the probe in telemetry and resets it at a new socket connection', () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  let listener;
  const context = vm.createContext({ Date, window: { addEventListener(_type, fn) { listener = fn; }, postMessage() {} }, document: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../economy-observation.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../adapters/huntera.js'), 'utf8')
    .replace('  globalThis.GamePilotAdapters =', '  globalThis.probe = { applySocketMessage, socketAnalyzerObservation }; globalThis.GamePilotAdapters ='), context);
  const api = context.probe;
  api.applySocketMessage({ ...msg(1, 103, { playerId: 7 }), type: 'welcome' });
  api.applySocketMessage({ ...msg(2, 54, {}), type: 'instance-enter' });
  api.applySocketMessage({ ...msg(3, 24, { id: 7, kind: 'spell', itemId: 238 }), type: 'wire-24' });
  assert.equal(api.socketAnalyzerObservation().economy.uses[238], 1);
  listener({ source: context.window, data: { source: 'gamepilot-huntera-socket', kind: 'connection', status: 'open', at: '2099-01-01T00:00:00Z' } });
  assert.equal(Object.keys(api.socketAnalyzerObservation().economy.uses).length, 0);
});
