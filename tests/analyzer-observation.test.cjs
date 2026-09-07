const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function harness() {
  const context = vm.createContext({ Date, window: { addEventListener() {}, postMessage() {} }, document: {} });
  const source = fs.readFileSync(path.join(__dirname, "../adapters/huntera.js"), "utf8")
    .replace("  globalThis.GamePilotAdapters =", "  globalThis.probe = { applySocketMessage, applySocketSnapshot, socketAnalyzerObservation, socketMetrics }; globalThis.GamePilotAdapters =");
  vm.runInContext(source, context);
  return context.probe;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('public monster catalog retains raw schema and zero immunity without copying items',()=>{
 const api=harness();
 api.applySocketMessage({type:'cyclopedia-catalog',code:26,payload:{monsters:[{id:'vampire',name:'Vampire',health:475,resistances:{death:0}}],items:[{private:'excluded'}]}});
 const frame=plain(api.socketAnalyzerObservation().combatFrames['cyclopedia-catalog']);
 assert.equal(frame.payload.monsters[0].resistances.death,0);assert.equal(frame.code,26);assert.equal('items' in frame.payload,false);
 frame.payload.monsters[0].health=1;
 assert.equal(api.socketAnalyzerObservation().combatFrames['cyclopedia-catalog'].payload.monsters[0].health,475);
 api.applySocketSnapshot({connected:true,openedAt:'2099-01-01T00:00:00Z'});
 assert.equal(api.socketAnalyzerObservation().combatFrames['cyclopedia-catalog'],undefined);
});
test('oversized creature catalogs are explicitly omitted rather than silently partial',()=>{
 const api=harness();api.applySocketMessage({type:'cyclopedia-catalog',payload:{monsters:[{name:'x'.repeat(262145)}]}});
 const f=api.socketAnalyzerObservation().combatFrames['cyclopedia-catalog'];
 assert.equal(f.payload,null);assert.equal(f.omitted,'payload-exceeds-262144-characters');
});

test("raw analyzer preserves zero and nested fields without DOM fallback or unrelated values", () => {
  const api = harness();
  api.applySocketMessage({ code: 41, type: "hunt-analyzer-update", payload: { kills: 0, damage: { physical: 12 } }, receivedAt: "2026-09-07T15:00:00Z" });
  api.applySocketMessage({ code: 21, type: "wire-21", payload: { message: "private chat" }, receivedAt: new Date().toISOString() });
  const result = plain(api.socketAnalyzerObservation());
  assert.deepEqual(result.frames["hunt-analyzer-update"].payload, { kills: 0, damage: { physical: 12 } });
  assert.deepEqual(result.messageShapes["wire-21"].keys, ["message"]);
  assert.ok(!JSON.stringify(result).includes("private chat"));
  assert.equal(result.frames["hunt-analyzer-update"].receivedAt, "2026-09-07T15:00:00Z");
  result.frames["hunt-analyzer-update"].payload.kills = 99;
  assert.equal(api.socketAnalyzerObservation().frames["hunt-analyzer-update"].payload.kills, 0);
});

test("oversized payloads are explicit omissions and missing frames stay missing", () => {
  const api = harness();
  assert.deepEqual(plain(api.socketAnalyzerObservation().frames), {});
  assert.equal(api.socketAnalyzerObservation().analyzerAgeMs, null);
  api.applySocketMessage({ type: "hunt-analyzer-update", payload: { huge: "x".repeat(33000) } });
  const frame = api.socketAnalyzerObservation().frames["hunt-analyzer-update"];
  assert.equal(frame.payload, null);
  assert.equal(frame.omitted, "payload-exceeds-32768-characters");
});

test("reconnect snapshot cannot attribute previous-connection analyzer to the new player", () => {
  const api = harness();
  api.applySocketMessage({ type: "hunt-analyzer-update", payload: { kills: 9 }, receivedAt: "2026-09-07T15:00:00Z" });
  api.applySocketSnapshot({ connected: true, openedAt: "2026-09-07T15:10:00Z", playerId: 123,
    messages: { old: { type: "hunt-analyzer-update", payload: { kills: 9 }, receivedAt: "2026-09-07T15:00:00Z" } } });
  assert.deepEqual(plain(api.socketAnalyzerObservation().frames), {});
  assert.equal(api.socketAnalyzerObservation().playerId, 123);
});

test("combat context excludes chat and inventory contents and follows equipment changes", () => {
  const api = harness();
  api.applySocketMessage({ type: "player-stats", payload: { level: 120, skills: { distance: 90 }, secret: "do-not-copy" } });
  api.applySocketMessage({ type: "player-inventory", payload: { equipment: { bow: { id: 1 } }, slots: [{ secret: "do-not-copy" }] } });
  api.applySocketMessage({ type: "inventory-delta", payload: { changes: [{ slot: "bow", item: { id: 2 } }, { container: "backpack", item: { secret: "do-not-copy" } }] } });
  api.applySocketMessage({ type: "action-bar-update", payload: { slots: [{ spellId: 12 }], managed: true } });
  const frames = plain(api.socketAnalyzerObservation().combatFrames);
  assert.deepEqual(frames["player-inventory"].payload, { equipment: { bow: { id: 2 } } });
  assert.equal(frames["player-stats"].payload.level, 120);
  assert.ok(!JSON.stringify(frames).includes("do-not-copy"));
  api.applySocketSnapshot({ connected: true, openedAt: "2099-01-01T00:00:00Z" });
  assert.deepEqual(plain(api.socketAnalyzerObservation().combatFrames), {});
});

test('timeline preserves sequence, deduplicates replay, limits retention and resets on reconnect', () => {
  const api = harness();
  const event = n => ({code:24,type:'wire-24',sequence:n,receivedAt:'2026-09-07T17:00:00Z',payload:{id:1,spellId:'haste',kind:'spell',text:'private text'}});
  api.applySocketMessage(event(2)); api.applySocketMessage(event(1)); api.applySocketMessage(event(2));
  let t=plain(api.socketAnalyzerObservation().combatTimeline);
  assert.deepEqual(t.events.map(e=>e.sequence),[1,2]);
  assert.ok(!JSON.stringify(t).includes('private text'));
  for(let n=3;n<=305;n++) api.applySocketMessage(event(n));
  t=plain(api.socketAnalyzerObservation().combatTimeline);
  assert.equal(t.events.length,300); assert.equal(t.dropped,5);
  api.applySocketMessage(event(1));
  assert.equal(api.socketAnalyzerObservation().combatTimeline.dropped,5);
  api.applySocketSnapshot({connected:true,openedAt:'2026-09-07T18:00:00Z'});
  assert.equal(api.socketAnalyzerObservation().combatTimeline.events.length,0);
});

test("analyzer metrics include totals, rates and item breakdowns from WebSocket", () => {
  const api = harness();
  const payload = { startedAt: 1788794087624, durationMs: 1800000, kills: 287,
    experience: 217184, rawExperience: 124660, lootValue: 21095, waste: 11819,
    loot: [{ itemId: 1, name: "Gold", count: 22, value: 22 }],
    supplies: [{ itemId: 2, name: "Arrow", count: 419, value: 8380 }],
    damageInput: [{ channel: "physical", value: 5990 }] };
  api.applySocketMessage({ type: "hunt-analyzer-update", payload });
  const metrics = plain(api.socketMetrics());
  assert.equal(metrics.source, "websocket");
  assert.equal(metrics.durationMs, 1800000);
  assert.equal(metrics.kills, 287);
  assert.equal(metrics.xpGained, 217184);
  assert.equal(metrics.rawXpGained, 124660);
  assert.equal(metrics.xpPerHour, 434368);
  assert.equal(metrics.rawXpPerHour, 249320);
  assert.equal(metrics.goldPerHour, 42190);
  assert.equal(metrics.spentPerHour, 23638);
  assert.equal(metrics.balance, 9276);
  assert.equal(metrics.balancePerHour, 18552);
  for (const key of ["loot", "supplies", "damageInput"]) assert.deepEqual(metrics[key], payload[key]);
  metrics.loot[0].count = 999;
  assert.equal(api.socketMetrics().loot[0].count, 22);
});

test("zero duration and new sessions do not reuse earlier totals or derive rates", () => {
  const api = harness();
  api.applySocketMessage({ type: "hunt-analyzer-update", payload: { startedAt: 1788794087624, experience: 100, lootValue: 50, waste: 5 } });
  api.applySocketMessage({ type: "hunt-analyzer-session", payload: { startedAt: 1788795087624, durationMs: 0, experience: 0, rawExperience: 0, lootValue: 0, waste: 0, kills: 0, loot: [], supplies: [], damageInput: [] } });
  const metrics = api.socketMetrics();
  assert.equal(metrics.durationMs, 0);
  assert.equal(metrics.balance, 0);
  assert.equal(metrics.xpGained, 0);
  assert.equal(metrics.spentPerHour, null);
  assert.equal(metrics.xpPerHour, undefined);
  api.applySocketSnapshot({ connected: true, openedAt: "2099-01-01T00:00:00Z", messages: {
    old: { type: "hunt-analyzer-update", receivedAt: "2026-09-07T15:00:00Z", payload: { experience: 100 } }
  } });
  assert.deepEqual(plain(api.socketMetrics()), {});
});

test("an empty loot list is not a zero valuation", () => {
  const api = harness();
  api.applySocketMessage({ type: "hunt-analyzer-update", payload: { loot: [], durationMs: 1000 } });
  assert.equal(api.socketMetrics().goldEarned, undefined);
  assert.equal(api.socketMetrics().balance, null);
});

test("hunt catalog retains only hunts, clones the payload and resets on reconnect", () => {
  const api = harness();
  const payload = {hunts: [{id:'fixture', monsters:[{bestiaryId:'vampire'}], tiers:[{name:'Cautious',monsterCount:2,monsterIndexes:[0],loot:['excluded']}],loot:['excluded'],bests:{solo:123}}], privateData:'excluded'};
  api.applySocketMessage({type:'hunt-catalog', code:42, payload});
  payload.hunts[0].id = 'mutated';
  const frame = plain(api.socketAnalyzerObservation().combatFrames['hunt-catalog']);
  assert.deepEqual(frame.payload, {hunts:[{id:'fixture', monsters:[{bestiaryId:'vampire'}],tiers:[{name:'Cautious',monsterCount:2,monsterIndexes:[0]}]}]});
  assert.equal(frame.omitted, null);
  api.applySocketSnapshot({connected:true, openedAt:'2099-01-01T00:00:00Z'});
  assert.equal(api.socketAnalyzerObservation().combatFrames['hunt-catalog'], undefined);
});
