const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadOpenHuntOrganizer(context) {
  const source = fs.readFileSync(path.join(__dirname, '../adapters/huntera.js'), 'utf8');
  const start = source.indexOf('  async function openHuntOrganizer()');
  const end = source.indexOf('  async function prepareHuntSelection(', start);
  vm.runInContext(`${source.slice(start, end)}\n globalThis.openHuntOrganizer = openHuntOrganizer;`, context);
}

test('opens the organizer introduced by the Huntera hunt home screen', async () => {
  let clicked = false;
  const entry = {};
  const context = vm.createContext({
    firstVisible: selector => selector === '#hunt-organize' ? { click: () => { clicked = true; } } : null,
    document: { querySelectorAll: selector => selector === '.hunt-window .hunt-entry' && clicked ? [entry] : [] },
    visible: value => value === entry,
    waitUntil: async predicate => predicate()
  });
  loadOpenHuntOrganizer(context);

  assert.equal(JSON.stringify(await context.openHuntOrganizer()), JSON.stringify({ ok: true }));
  assert.equal(clicked, true);
});

test('keeps supporting the previous Huntera screen without the organizer step', async () => {
  const entry = {};
  const context = vm.createContext({
    firstVisible: () => null,
    document: { querySelectorAll: selector => selector === '.hunt-window .hunt-entry' ? [entry] : [] },
    visible: value => value === entry,
    waitUntil: async predicate => predicate()
  });
  loadOpenHuntOrganizer(context);

  assert.equal(JSON.stringify(await context.openHuntOrganizer()), JSON.stringify({ ok: true, alreadyOpen: true }));
});
