const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

test('recognizes Huntera article cards and chooses Play instead of Delete', () => {
  const source = readFileSync(join(__dirname, '../adapters/huntera.js'), 'utf8');
  const start = source.indexOf('  function characterCandidate(');
  const end = source.indexOf('  async function selectCharacter(', start);
  const control = text => ({ textContent: text, dataset: {}, getAttribute: () => '', id: '', className: '', disabled: false });
  const remove = control('Excluir Hanum'), play = control('Jogar');
  // Adjacent strong/span nodes concatenate without whitespace in textContent.
  const card = { textContent: 'HanumLevel 185 Master SorcererJogarExcluir', dataset: {}, getAttribute: () => '', matches: selector => selector === 'article',
    querySelector: selector => selector === '.character-meta > strong' ? { textContent: 'Hanum' } : null, querySelectorAll: () => [remove, play] };
  const context = vm.createContext({ visible: () => true, normalizeItemName: value => String(value).toLowerCase().trim(),
    document: { querySelectorAll: selector => selector.split(',').map(s => s.trim()).includes('article') ? [card] : [] } });
  vm.runInContext(source.slice(start, end) + '\n globalThis.choose = characterCandidate;', context);
  assert.equal(context.choose('Hanum'), play);
  assert.equal(context.choose('Other'), null);
});

function page({ path = '/login', character = null, connected = false, error = false, health = 100 } = {}) {
  let listener, clicks = 0, selections = 0;
  const stored = new Map();
  class Input {
    get value() { return this.current; }
    set value(value) { this.current = value; }
    getClientRects() { return [1]; }
    dispatchEvent() {}
  }
  const email = new Input(), password = new Input();
  const button = { getClientRects: () => [1], click: () => clicks++ };
  const form = { getClientRects: () => [1], querySelector: selector => {
    if (selector.includes('name="email"')) return email;
    if (selector.includes('name="password"')) return password;
    if (selector.includes('submit')) return button;
    if (error && selector === '.account-error') return { getClientRects: () => [1] };
    return null;
  } };
  const context = vm.createContext({
    location: { origin: 'https://huntera.com.br', pathname: path },
    document: { querySelector: () => form, querySelectorAll: () => [] }, HTMLInputElement: Input, Event: class {},
    sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    GamePilotAdapters: { huntera: { readState: () => ({ character: { name: character }, socket: { connected }, resources: { health: { current: health } } }), selectCharacter: async () => { selections++; return { ok: true }; } } },
    chrome: { runtime: { id: 'extension', onMessage: { addListener: fn => { listener = fn; } } } }
  });
  vm.runInContext(readFileSync(join(__dirname, '../browser-launch-content.js'), 'utf8'), context);
  return { context, email, password, clicks: () => clicks, selections: () => selections,
    send: (job = { id: 'job', characterName: 'Hero', email: 'test@example.com', password: 'dummy' }) =>
      new Promise(resolve => listener({ type: 'browser-launch-connect', job }, { id: 'extension' }, resolve)) };
}
test('submits login once per job, including subsequent delivery after navigation', async () => {
  const p = page();
  await p.send(); await p.send();
  assert.equal(p.clicks(), 1);
  assert.equal(p.email.value, 'test@example.com');
  assert.equal(p.password.value, 'dummy');
});
test('account discovery only accepts a roster after the same job submitted its saved login', async () => {
  const job = { id: 'discover-job', discover: true, email: 'test@example.com', password: 'dummy' };
  const oldSession = page({ path: '/characters' });
  assert.equal((await oldSession.send(job)).code, 'login-required');
  const fresh = page();
  await fresh.send(job);
  fresh.context.location.pathname = '/characters';
  fresh.context.document.querySelectorAll = () => [{ textContent: 'HanumLevel 185Jogar', querySelector: () => ({ textContent: 'Hanum' }), querySelectorAll: () => [{ textContent: 'Jogar' }] }];
  const result = await fresh.send(job);
  assert.equal(result.ok, true);
  assert.equal(result.characters[0].name, 'Hanum');
  assert.equal(result.characters[0].level, 185);
  assert.equal((await fresh.send({ ...job, id: 'different-job' })).code, 'login-required');
});

test('entry scripts load when the DOM is ready without waiting for all assets', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '../manifest.json'), 'utf8'));
  const script = manifest.content_scripts.find(item => item.js.includes('browser-launch-content.js'));
  assert.equal(script.run_at, 'document_end');
});
test('does not submit registration or password reset pages', async () => {
  for (const path of ['/register', '/reset-password', '/forgot-password']) {
    const p = page({ path });
    assert.equal((await p.send()).error, true);
    assert.equal(p.clicks(), 0);
  }
});
test('does not retry login with an error already displayed', async () => {
  const p = page({ error: true });
  assert.equal((await p.send()).error, true);
  assert.equal(p.clicks(), 0);
});
test('requires the expected character and a live socket before reporting ready', async () => {
  assert.equal((await page({ path: '/game', character: 'Hero', connected: true }).send()).ok, true);
  assert.equal((await page({ path: '/game', character: 'Hero' }).send()).waiting, true);
  const other = page({ path: '/game', character: 'Other', connected: true });
  assert.equal((await other.send()).error, true);
  assert.equal(other.selections(), 0);
});
test('rejects credential delivery outside the exact Huntera origin', async () => {
  const p = page(); p.context.location.origin = 'https://example.com';
  assert.equal((await p.send()).error, true); assert.equal(p.clicks(), 0);
});

test('does not release a dead character and revives only once per request', async () => {
  const p = page({ path: '/game', character: 'Hero', connected: true, health: 0 });
  assert.equal((await p.send()).phase, 'waiting-health');
  let revives = 0;
  const button = { textContent: 'Reviver', getClientRects: () => [1], click: () => revives++ };
  p.context.document.querySelectorAll = () => [{ textContent: 'Você morreu', getClientRects: () => [1], querySelectorAll: () => [button] }];
  assert.equal((await p.send()).phase, 'reviving');
  assert.equal((await p.send()).phase, 'reviving');
  assert.equal(revives, 1);
  p.context.document.querySelectorAll = () => [];
  assert.equal((await p.send()).ok, undefined);
});

test('waits for the asynchronously loaded character list instead of failing immediately', async () => {
  const p = page({ path: '/characters' });
  p.context.GamePilotAdapters.huntera.selectCharacter = async () => ({ ok: false, error: 'not loaded yet' });
  const result = await p.send();
  assert.equal(result.waiting, true);
  assert.equal(result.phase, 'selecting');
  assert.equal(result.error, undefined);
});

test('worker reuses an existing matching tab and never persists a password', async () => {
  let created = 0, acknowledged = false;
  const saved = [];
  const context = vm.createContext({
    AbortSignal, Date, setTimeout, clearTimeout,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.jobId && !body.phase) acknowledged = true;
      return { ok: true, json: async () => body.jobId ? {} : { job: { id: 'j', characterName: 'Hero', email: 'test@example.com', password: 'dummy-secret' } } };
    },
    chrome: {
      storage: { local: { get: async () => ({ 'gamepilot.deviceToken': 'token' }) },
        session: { get: async () => ({}), set: async data => saved.push(data), remove: async () => {} } },
      tabs: { query: async () => [{ id: 1, windowId: 2 }], create: async () => { created++; },
        get: async () => ({ url: 'https://huntera.com.br/game' }), update: async () => {},
        sendMessage: async (_id, message) => message.type === 'browser-launch-inspect' ? { characterName: 'Hero' } : { ok: true } },
      windows: { update: async () => {} }, alarms: { create() {}, onAlarm: { addListener() {} } }
    }
  });
  vm.runInContext(readFileSync(join(__dirname, '../browser-launch-worker.js'), 'utf8'), context);
  context.startGamepilotBrowserLauncher('http://127.0.0.1:4317');
  for (let i = 0; i < 30 && !acknowledged; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, true); assert.equal(created, 0);
  assert.equal(JSON.stringify(saved).includes('dummy-secret'), false);
});
