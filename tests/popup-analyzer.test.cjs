const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function harness() {
  const elements = new Map();
  const element = () => ({ textContent: '', hidden: false, children: [],
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; } });
  const document = { createElement: element, querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  } };
  let source = fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8');
  source = source.slice(0, source.indexOf('$("#pair-form").addEventListener')) + source.slice(source.indexOf('const analyzerNumber'));
  source = source.replace('refreshAnalyzer();\nsetInterval(refreshAnalyzer, 2000);', '');
  const context = vm.createContext({ document, chrome: {
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: { onActivated: { addListener() {} } }
  } });
  vm.runInContext(source + '\nglobalThis.probe = { renderAnalyzer, analyzerDuration };', context);
  return { ...context.probe, elements };
}

test('sidebar renders own metrics with zero, fractional DPS and friendly item names', () => {
  const api=harness();
  api.renderAnalyzer({ok:true,character:'Holyae',connected:true,observedAnalyzer:{startedAt:new Date().toISOString(),observedAt:new Date().toISOString(),durationMs:3661000,kills:0,damagePerSecond:259.5,spellCasts:{haste:2},itemUses:{237:3}}});
  assert.equal(api.elements.get('#observed-content').hidden,false);
  assert.equal(api.elements.get('#observed-character').textContent,'Holyae');
  assert.equal(api.elements.get('#observed-metrics').children[1].children[1].textContent,'0');
  assert.equal(api.elements.get('#observed-combat').children[1].children[1].textContent,'259,5');
  assert.equal(api.elements.get('#observed-items').children[0].children[0].textContent,'Strong Mana Potion');
  assert.equal(api.elements.get('#observed-recovery').children[2].children[1].textContent,'—');
  assert.equal(api.analyzerDuration(3661000),'01:01:01');
});
test('sidebar clears visibility for unavailable tabs and identifies disconnected data',()=>{
  const api=harness();
  api.renderAnalyzer({ok:true,connected:false,observedAnalyzer:{startedAt:new Date().toISOString()}});
  assert.match(api.elements.get('#observed-status').textContent,/Desconectado/);
  api.renderAnalyzer({error:'Selecione Huntera'});
  assert.equal(api.elements.get('#observed-content').hidden,true);
  assert.equal(api.elements.get('#observed-status').textContent,'Selecione Huntera');
});
