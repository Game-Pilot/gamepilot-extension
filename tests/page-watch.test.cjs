const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness(tabs = {}) {
  const calls = [];
  let listener;
  const storage = {};
  const context = vm.createContext({
    console, Date, URL,
    chrome: {
      sidePanel: { setPanelBehavior: async () => {} },
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      storage: { session: {
        get: async () => structuredClone(storage),
        set: async (value) => Object.assign(storage, structuredClone(value))
      } },
      tabs: {
        get: async (id) => { if (!tabs[id]) throw Error('closed'); return tabs[id]; },
        update: async (id, options) => calls.push(['tab', id, options.active])
      },
      windows: { update: async (id, options) => calls.push(['window', id, options.focused]) }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../service-worker.js'), 'utf8') +
    '\nglobalThis.watch = { recoverSilentPages, drain: () => pageWatchQueue };', context);
  return { ...context.watch, calls, listener, storage };
}

test('return focuses the requesting character window immediately', async () => {
  const h = harness({ 8: { id: 8, windowId: 4, url: 'https://huntera.com.br/play' } });
  const result = await new Promise(resolve => h.listener({ type: 'focus-game-for-return' },
    { tab: { id: 8 }, url: 'https://huntera.com.br/play' }, resolve));
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls, [['tab', 8, true], ['window', 4, true]]);
});

test('leave waits for focus, skips town and handles focus failure', async () => {
  for (const scenario of ['return', 'town', 'failure']) {
    let town = scenario === 'town';
    const calls = [];
    const context = vm.createContext({
      inTown: () => town,
      chrome: { runtime: { sendMessage: async message => {
        calls.push(message.type); return { ok: scenario !== 'failure' };
      } } },
      document: { querySelector: () => ({ click() { calls.push('leave'); town = true; } }) },
      waitUntil: async predicate => predicate()
    });
    const source = fs.readFileSync(path.join(__dirname, '../adapters/huntera.js'), 'utf8');
    vm.runInContext(source.slice(source.indexOf('  async function leaveHunt()'), source.indexOf('  async function openStore(')), context);
    const result = await context.leaveHunt();
    assert.equal(result.ok, scenario !== 'failure');
    assert.deepEqual(calls, scenario === 'town' ? [] : scenario === 'failure' ? ['focus-game-for-return'] : ['focus-game-for-return', 'leave']);
  }
});

test('silent game tab is activated and its window focused with a cooldown', async () => {
  const h = harness({ 7: { id: 7, windowId: 3, url: 'https://huntera.com.br/play' } });
  const pages = { 7: { lastSeen: Date.now() - 60000 } };
  await h.recoverSilentPages(pages);
  await h.recoverSilentPages(pages);
  assert.deepEqual(h.calls, [['tab', 7, true], ['window', 3, true]]);
});

test('healthy, closed and navigated tabs do not steal focus', async () => {
  const h = harness({ 7: { id: 7, url: 'https://example.com/' } });
  const pages = { 7: { lastSeen: 1 }, 8: { lastSeen: 1 }, 9: { lastSeen: Date.now() } };
  await h.recoverSilentPages(pages);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(Object.keys(pages), ['9']);
});

test('local liveness persists independently for multiple tabs', async () => {
  const h = harness();
  for (const id of [7, 8]) h.listener({ type: 'page-alive' },
    { tab: { id }, url: 'https://huntera.com.br/play' }, () => {});
  await h.drain();
  assert.deepEqual(Object.keys(h.storage['gamepilot.pageWatch']), ['7', '8']);
  assert.ok(h.storage['gamepilot.pageWatch'][7].lastSeen > Date.now() - 1000);
});
