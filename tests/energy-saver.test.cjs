const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function harness(saved = 'off', savedLease = null, boot = true) {
  const attrs = new Map(), observers = [], listeners = [], events = new Map();
  const storage = new Map([['gamepilot.energySaver', saved]]);
  if (savedLease) storage.set('gamepilot.energyBenchmark', JSON.stringify(savedLease));
  const timers = new Map(); let nextTimer = 0;
  const root = { getAttribute: name => attrs.get(name), setAttribute(name, value) { attrs.set(name, value); } };
  const document = {
    documentElement: root, head: { append() {} }, createElement: () => ({}),
    addEventListener: (name, callback) => events.set(name, callback),
    dispatchEvent: event => events.get(event.type)?.()
  };
  const raf = () => 1;
  const context = vm.createContext({ document, Event: class { constructor(type) { this.type = type; } },
    requestAnimationFrame: raf,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id),
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
    chrome: { runtime: { onMessage: { addListener: callback => listeners.push(callback) } } }
  });
  vm.runInContext(`
    globalThis.originalBind = Function.prototype.bind;
    class SceneManager {
      constructor(game) {
        this.game = game; this.isProcessing = false; this.updates = 0; this.draws = 0;
        this.scenes = [
          {sys:{settings:{visible:true, status:5},render:()=>this.draws++}},
          {sys:{settings:{visible:false, status:5},render:()=>{throw new Error('hidden scene rendered')}}}
        ];
      }
      update() { this.updates++; this.isProcessing = true; }
      render(renderer) {
        if (this.throwInRender) throw new Error('renderer failed');
        for (const scene of this.scenes) if (scene.sys.settings.visible && scene.sys.settings.status >= 3 && scene.sys.settings.status < 7) scene.sys.render(renderer);
        this.isProcessing = false;
      }
    }
    class Game {
      constructor(world = true) {
        this.canvas = {parentElement:{classList:{contains:()=>world}}};
        this.scene = new SceneManager(this); this.loop = {}; this.renderer = {}; this.events = {};
      }
      headlessStep() {}
      step() { this.scene.update(); this.scene.render(this.renderer); }
      start() { this.callback = this.step.bind(this); }
    }
    globalThis.Game = Game;
    globalThis.unrelatedDraw = function drawImage() {};
    globalThis.CanvasRenderingContext2D = function() {};
    CanvasRenderingContext2D.prototype.drawImage = unrelatedDraw;
  `, context);
  vm.runInContext(source('energy-saver-main.js'), context);
  vm.runInContext(source('energy-saver.js'), context);
  const flush = () => observers.forEach(callback => callback());
  flush();
  if (boot) vm.runInContext('globalThis.game = new Game(); game.start();', context);
  function message(value) { let response; listeners[0](value, {}, result => response = result); flush(); return response; }
  return { context, storage, root, message, raf, timers, run: code => vm.runInContext(code, context) };
}

test('scene gate stops native scene rendering but preserves every update and scene queue completion', () => {
  const h = harness();
  h.run('game.callback()');
  assert.equal(h.context.game.scene.draws, 1);
  h.message({ type: 'energy-saver-set', enabled: true });
  h.run('for(let i=0;i<120;i++) game.callback()');
  assert.equal(h.context.game.scene.draws, 1);
  assert.equal(h.context.game.scene.updates, 121);
  assert.equal(h.context.game.scene.isProcessing, false);
  assert.equal(h.context.game.scene.scenes[0].sys.settings.visible, true);
  assert.equal(h.context.game.scene.scenes[1].sys.settings.visible, false);
  const state = h.message({type:'energy-saver-state'});
  assert.equal(state.renderer.framesSeen, 121);
  assert.equal(state.renderer.framesSkipped, 120);
  h.message({ type: 'energy-saver-set', enabled: false });
  h.run('game.callback()');
  assert.equal(h.context.game.scene.draws, 2);
});

test('native bind semantics, draw APIs and RAF are unchanged after engine capture', () => {
  const h = harness('off', null, false);
  assert.equal(h.run('(function(x){return this.n+x}).bind({n:2},3)()'), 5);
  assert.equal(h.run('(()=>{function A(x){this.x=x} const B=A.bind(null,9); return new B().x})()'), 9);
  h.run('globalThis.game = new Game(); game.start()');
  assert.equal(h.run('Function.prototype.bind === originalBind'), true);
  assert.equal(h.run('CanvasRenderingContext2D.prototype.drawImage === unrelatedDraw'), true);
  assert.equal(h.context.requestAnimationFrame, h.raf);
});

test('only world scenes are gated; recreated games reuse the hook and visibility restores on exceptions', () => {
  const h = harness('on');
  h.run('globalThis.other = new Game(false); other.start(); other.callback()');
  assert.equal(h.context.other.scene.draws, 1);
  h.run('globalThis.replacement = new Game(); replacement.start(); replacement.callback()');
  assert.equal(h.context.replacement.scene.draws, 0);
  h.run('game.scene.throwInRender = true');
  assert.throws(() => h.run('game.callback()'), /renderer failed/);
  assert.equal(h.context.game.scene.scenes[0].sys.settings.visible, true);
  assert.equal(h.context.game.scene.scenes[1].sys.settings.visible, false);
});

test('new scenes keep updating and do not render during economy mode', () => {
  const h = harness('on');
  h.run('game.scene.scenes.push({sys:{settings:{visible:true,status:5},render:()=>{throw new Error("new scene drew")}}}); game.callback()');
  assert.equal(h.context.game.scene.updates, 1);
  assert.equal(h.context.game.scene.scenes[2].sys.settings.visible, true);
});

test('preference survives reload, stays tab-local and rejects malformed messages', () => {
  const a = harness(); const b = harness();
  a.message({ type: 'energy-saver-set', enabled: true });
  assert.equal(a.storage.get('gamepilot.energySaver'), 'on');
  assert.equal(b.message({ type: 'energy-saver-state' }).enabled, false);
  const reload = harness(a.storage.get('gamepilot.energySaver'));
  assert.equal(reload.message({ type: 'energy-saver-state' }).enabled, true);
  assert.equal(reload.message({ type: 'energy-saver-set', enabled: 'false' }).ok, false);
});

test('missing engine capture prevents activation instead of merely hiding the canvas', () => {
  const h = harness('off', null, false);
  assert.equal(h.message({ type: 'energy-saver-set', enabled: true }).ok, false);
  assert.equal(h.message({ type: 'energy-saver-state' }).ready, false);
  assert.equal(h.message({ type: 'energy-saver-state' }).enabled, false);
});

test('benchmark locks manual changes, keeps original preference and restores after end', () => {
  const h = harness('on');
  assert.equal(h.message({ type: 'energy-benchmark-begin', runId: 'run' }).locked, true);
  assert.equal(h.message({ type: 'energy-saver-set', enabled: false }).ok, false);
  assert.equal(h.message({ type: 'energy-saver-set', enabled: false, runId: 'run' }).enabled, false);
  assert.equal(h.storage.get('gamepilot.energySaver'), 'on');
  assert.equal(h.message({ type: 'energy-benchmark-end', runId: 'wrong' }).ok, false);
  assert.equal(h.message({ type: 'energy-benchmark-end', runId: 'run' }).enabled, true);
  assert.equal(h.message({ type: 'energy-saver-state' }).locked, false);
  assert.equal(h.timers.size, 0);
});

test('reload and watchdog restore interrupted benchmark independently of the worker', () => {
  const h = harness('off', { runId: 'old', original: true });
  assert.equal(h.message({ type: 'energy-saver-state' }).enabled, true);
  assert.equal(h.storage.has('gamepilot.energyBenchmark'), false);
  h.message({ type: 'energy-benchmark-begin', runId: 'run' });
  h.message({ type: 'energy-saver-set', enabled: false, runId: 'run' });
  for (const timer of [...h.timers.values()]) timer();
  assert.equal(h.message({ type: 'energy-saver-state' }).enabled, true);
  assert.equal(h.message({ type: 'energy-saver-state' }).locked, false);
  assert.equal(h.message({ type: 'energy-saver-set', enabled: false, runId: 'run' }).ok, false);
});
