const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function harness(options = {}) {
  const context = vm.createContext({ URL, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../benchmark.js'), 'utf8'), context);
  const calls = [];
  const stored = options.stored || {};
  let enabled = options.enabled ?? true;
  let original = enabled;
  let locked = false;
  let documentId = 'document-1';
  let ticks = 0; let duration = 0; let reads = 0; let waits = 0;
  let framesSeen = 0; let framesSkipped = 0;
  let detachListener;
  const state = () => ({ ok: true, enabled, locked, ready: true, documentId, visible: true, title: 'Hanum — Huntera', width: 1200, height: 800,
    renderer: { strategy: 'scene-visibility-v2', framesSeen, framesSkipped } });
  const api = {
    storage: { session: { get: async () => structuredClone(stored), set: async value => Object.assign(stored, structuredClone(value)) } },
    tabs: {
      get: async id => ({ id, active: !options.inactive, url: options.url || 'https://huntera.com.br/game' }),
      sendMessage: async (id, message) => {
        calls.push(['message', id, message.type, message.enabled]);
        if (message.type === 'energy-benchmark-begin') { original = enabled; locked = true; }
        if (message.type === 'energy-saver-set') enabled = message.enabled;
        if (message.type === 'energy-benchmark-end') { enabled = original; locked = false; }
        return state();
      }
    },
    debugger: {
      getTargets: async () => [{ tabId: 7, attached: options.alreadyAttached || false }],
      attach: async target => { calls.push(['attach', target.tabId]); if (options.attachFails) throw new Error('attach failed'); },
      detach: async target => { calls.push(['detach', target.tabId]); detachListener(target); },
      onDetach: { addListener: callback => detachListener = callback },
      sendCommand: async (target, method) => {
        calls.push(['command', target.tabId, method]);
        if (method === 'Performance.enable') return {};
        reads++;
        if (options.failMetrics && reads === 3) throw new Error('metrics unavailable');
        ticks++; duration += enabled ? 0.1 : 0.4;
        return { metrics: Object.entries({ Timestamp: ticks, TaskDuration: duration, ScriptDuration: duration / 2,
          LayoutDuration: 0, RecalcStyleDuration: 0, JSHeapUsedSize: 10485760 }).map(([name, value]) => ({ name, value })) };
      }
    }
  };
  let controller;
  controller = context.GamePilotBenchmark.createController(api, { noTimeout: true, sampleCount: 2, warmupCount: 0,
    wait: async () => {
      waits++;
      if (!options.stoppedRender) { framesSeen += 60; if (enabled && !options.brokenGate) framesSkipped += 60; }
      if (options.reload && waits === 2) documentId = 'document-2';
      if (options.cancel && waits === 2) await controller.handle({ type: 'benchmark-cancel' });
    }
  });
  return { controller, calls, stored, state, math: context.GamePilotBenchmark };
}

test('benchmark runs A/B/A on the requested tab and restores either original toggle setting', async () => {
  for (const enabled of [true, false]) {
    const h = harness({ enabled });
    await h.controller.handle({ type: 'benchmark-start', tabId: 7 });
    await h.controller.settled();
    const result = h.stored['gamepilot.benchmark'];
    assert.equal(result.status, 'complete');
    assert.equal(result.running, false);
    assert.equal(result.phases.length, 3);
    assert.deepEqual(result.phases.map(p => p.enabled), [false, true, false]);
    assert.ok(Math.abs(result.comparison.changePercent + 75) < 0.001);
    assert.equal(h.state().enabled, enabled);
    assert.equal(h.state().locked, false);
    assert.ok(h.calls.filter(c => c[0] === 'command').every(c => c[1] === 7));
    assert.equal(h.calls.filter(c => c[0] === 'detach').length, 1);
  }
});

test('cancellation, reload and metric errors restore and do not publish a comparison', async () => {
  for (const scenario of ['cancel', 'reload', 'failMetrics']) {
    const h = harness({ [scenario]: true });
    await h.controller.handle({ type: 'benchmark-start', tabId: 7 });
    await h.controller.settled();
    assert.notEqual(h.stored['gamepilot.benchmark'].status, 'complete');
    assert.equal(h.stored['gamepilot.benchmark'].comparison, undefined);
    assert.equal(h.state().enabled, true);
    assert.equal(h.state().locked, false);
    assert.equal(h.calls.filter(c => c[0] === 'detach').length, 1);
  }
});

test('existing debugger and non-Huntera tabs are rejected before any mutations', async () => {
  for (const options of [{ alreadyAttached: true }, { url: 'https://example.com/' }, { inactive: true }]) {
    const h = harness(options);
    await assert.rejects(h.controller.handle({ type: 'benchmark-start', tabId: 7 }));
    assert.equal(h.calls.filter(c => c[0] === 'attach' || c[2] === 'energy-saver-set').length, 0);
    assert.equal(h.calls.filter(c => c[0] === 'detach').length, 0);
  }
});

test('failed debugger attach releases the page lock without detaching another debugger', async () => {
  const h = harness({ attachFails: true });
  await assert.rejects(h.controller.handle({ type: 'benchmark-start', tabId: 7 }));
  assert.equal(h.state().locked, false);
  assert.equal(h.state().enabled, true);
  assert.equal(h.calls.filter(c => c[0] === 'detach').length, 0);
});

test('worker restart marks a saved in-progress run interrupted and cleans up', async () => {
  const h = harness({ stored: { 'gamepilot.benchmark': { running: true, leased: true, attached: true, tabId: 7, runId: 'old', original: true } } });
  await h.controller.ready;
  assert.equal(h.stored['gamepilot.benchmark'].status, 'interrupted');
  assert.equal(h.stored['gamepilot.benchmark'].running, false);
  assert.equal(h.calls.filter(c => c[0] === 'detach').length, 1);
});

test('interval math rejects missing or reset counters and reports baseline drift', () => {
  const h = harness();
  assert.throws(() => h.math.metrics({ metrics: [] }), /indisponível/);
  const a = { Timestamp: 1, TaskDuration: 3, ScriptDuration: 1, LayoutDuration: 0, RecalcStyleDuration: 0 };
  assert.throws(() => h.math.interval(a, { ...a, Timestamp: 2, TaskDuration: 0 }), /reiniciados/);
  const delta = h.math.interval(a, { ...a, Timestamp: 3, TaskDuration: 4, JSHeapUsedSize: 0 });
  assert.equal(h.math.summarize([delta]).busyPercent, 50);
  const phases = [10, 5, 30].map(busyPercent => ({ summary: { busyPercent } }));
  assert.equal(h.math.comparison(phases).unstable, true);
  assert.equal(h.math.comparison([0, 0, 0].map(busyPercent => ({ summary: { busyPercent } }))).changePercent, null);
});

test('benchmark refuses a no-op optimization or a stopped render loop', async () => {
  for (const option of ['brokenGate', 'stoppedRender']) {
    const h = harness({ [option]: true });
    await h.controller.handle({ type: 'benchmark-start', tabId: 7 });
    await h.controller.settled();
    assert.equal(h.stored['gamepilot.benchmark'].status, 'failed');
    assert.equal(h.stored['gamepilot.benchmark'].comparison, undefined);
    assert.equal(h.state().enabled, true);
  }
});
