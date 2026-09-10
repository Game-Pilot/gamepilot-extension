const {test} = require('node:test');
const assert = require('node:assert/strict');
const {create} = require('../observed-analyzer.js');
const event = (sequence, type, payload, code) => ({sequence, type, payload, code, receivedAt: new Date(1788800000000 + sequence * 1000).toISOString()});

test('health duration weights elapsed time, includes full health and freezes on reads', () => {
  const a = create();
  a.accept(event(1,'player-stats',{health:100,maxHealth:100}),7);
  a.accept(event(3,'player-stats',{health:85,maxHealth:100}),7);
  a.accept(event(4,'player-stats',{health:85,maxHealth:100}),7);
  a.accept(event(9,'player-stats',{health:0,maxHealth:100}),7);
  a.accept(event(11,'wire-20',{attackerId:7,targetId:8,value:321},20),7);
  a.accept(event(11,'wire-20',{attackerId:7,targetId:8,value:999},20),7);
  const s=a.read();
  assert.equal(s.healthObservedMs,10000);
  assert.equal(s.healthTimeBucketsMs[10],2000);
  assert.equal(s.healthTimeBucketsMs[8],6000);
  assert.equal(s.healthTimeBucketsMs[0],2000);
  assert.equal(s.healthTimeBucketsMs.reduce((a,b)=>a+b),10000);
  assert.equal(s.minimumHealth,0);
  assert.equal(s.minimumHealthPercent,0);
  assert.equal(s.maximumHit,321);
  assert.deepEqual(a.read(),s);
  a.accept(event(12,'hunt-analyzer-session',{startedAt:1}),7);
  a.accept(event(13,'hunt-analyzer-session',{startedAt:2}),7);
  assert.equal(a.read().healthObservedMs,0);
  assert.equal(a.read().minimumHealth,null);
  assert.equal(a.read().maximumHit,null);
});

test('health time excludes unknown and inactive intervals and ignores replay', () => {
  const a=create();
  a.accept(event(1,'player-stats',{health:100,maxHealth:100}),7,true);
  a.accept(event(2,'other',{}),7);
  a.accept(event(3,'player-stats',{health:50,maxHealth:100}),7);
  a.accept(event(5,'other',{}),7);
  a.accept(event(6,'other',{}),7,false,false);
  a.accept(event(20,'other',{}),7);
  a.accept(event(21,'player-stats',{health:90,maxHealth:100}),7);
  a.accept(event(22,'player-stats',{health:-1,maxHealth:100}),7);
  a.accept(event(30,'other',{}),7);
  assert.equal(a.read().healthObservedMs,3000);
  assert.equal(a.read().healthTimeBucketsMs[5],2000);
  assert.equal(a.read().healthTimeBucketsMs[9],1000);
  assert.equal(a.read().minimumHealth,50);
});

test('counts only live own-player events, deduplicates replay and resets on session change', () => {
  const a = create();
  a.accept(event(1, 'hunt-analyzer-session', {startedAt: 100}), 7, true);
  a.accept(event(2, 'experience-gain', {playerId: 7, value: 500}), 7, true);
  assert.equal(a.read().startedAt, null);
  a.accept(event(3, 'experience-gain', {playerId: 8, value: 99}), 7);
  a.accept(event(4, 'experience-gain', {playerId: 7, value: 20}), 7);
  a.accept(event(4, 'experience-gain', {playerId: 7, value: 20}), 7);
  a.accept(event(5, 'wire-20', {targetId: 7, value: 12}, 20), 7);
  a.accept(event(6, 'wire-20', {targetId: 8, value: 900}, 20), 7);
  a.accept(event(7, 'experience-gain', {playerId: 7, value: 1000}), 7, false, false);
  assert.equal(a.read().xpGained, 20);
  assert.equal(a.read().damageReceived, 12);
  a.accept(event(8, 'hunt-analyzer-session', {startedAt: 200}), 7);
  assert.equal(a.read().xpGained, 0);
  a.reset(); assert.equal(a.read().startedAt, null);
});
test('bestiary uses per-monster baselines and skips unknown or reset phases', () => {
  const a = create();
  a.accept(event(1, 'bestiary-progress', {kills: {rat: 50}, stages: {rat: 0}}), 7, true);
  a.accept(event(2, 'bestiary-progress', {kills: {rat: 52, bat: 80}, stages: {rat: 0}}), 7);
  assert.equal(a.read().kills, 2);
  a.accept(event(3, 'bestiary-progress', {kills: {rat: 0}, stages: {rat: 1}}), 7);
  assert.equal(a.read().kills, 2);
});
test('comparison subtracts official and observed baselines for the same frame interval', () => {
  const a = create();
  a.accept(event(1, 'experience-gain', {playerId: 7, value: 500}), 7);
  a.accept(event(2, 'hunt-analyzer-update', {startedAt: 100, experience: 10000, kills: 100, damageInput: [{value: 300}]}), 7);
  a.accept(event(3, 'experience-gain', {playerId: 7, value: 40}), 7);
  a.accept(event(4, 'wire-20', {targetId: 7, value: 20}, 20), 7);
  a.accept(event(5, 'hunt-analyzer-update', {startedAt: 100, experience: 10040, kills: 101, damageInput: [{value: 320}]}), 7);
  const rows = a.read().comparison.rows;
  assert.deepEqual(rows[0], {key: 'xpGained', observed: 40, official: 40, difference: 0});
  assert.deepEqual(rows[2], {key: 'damageReceived', observed: 20, official: 20, difference: 0});
  assert.equal(rows[1].difference, -1);
  a.accept(event(6, 'hunt-analyzer-update', {startedAt: 200, experience: 0}), 7);
  assert.equal(a.read().comparison, null);
});

test('outgoing damage excludes other players and self damage; spell proximity never attributes damage', () => {
  const a = create();
  a.accept(event(1, 'wire-20', {attackerId:7,targetId:8,value:100},20),7);
  a.accept(event(2, 'wire-24', {id:7,kind:'spell',spellId:'divine-missile'},24),7);
  a.accept(event(3, 'wire-20', {attackerId:7,targetId:9,value:50},20),7);
  a.accept(event(4, 'wire-20', {attackerId:8,targetId:9,value:900},20),7);
  a.accept(event(5, 'wire-20', {attackerId:7,targetId:7,value:10},20),7);
  a.accept(event(6, 'wire-24', {id:8,kind:'spell',spellId:'divine-missile'},24),7);
  a.accept(event(7, 'wire-20', {attackerId:7,targetId:8,value:999},20),7,true);
  a.accept(event(8, 'wire-20', {attackerId:7,targetId:8,value:999},20),7,false,false);
  const s=a.read();
  assert.equal(s.damageDealt,150);
  assert.equal(s.outgoingHits,2);
  assert.equal(s.unattributedDamage,150);
  assert.equal(s.damagePerSecond,30);
  assert.deepEqual(s.spellCasts,{'divine-missile':1});
  assert.equal(s.spellAttribution,'unavailable-no-shared-event-id');
  a.reset(); assert.equal(a.read().damageDealt,0); assert.equal(a.read().damagePerSecond,null);
});

test('item use and restore counters filter identity and keep item casts separate from spells', () => {
  const a=create();
  a.accept(event(1,'wire-24',{id:7,kind:'spell',itemId:237,spellId:'test'},24),7);
  a.accept(event(1,'wire-24',{id:7,kind:'spell',itemId:237},24),7);
  a.accept(event(2,'wire-24',{id:8,kind:'spell',itemId:237},24),7);
  a.accept(event(3,'wire-23',{id:7,vital:'health',value:100},23),7);
  a.accept(event(4,'wire-23',{id:7,vital:'health',value:20,leech:true},23),7);
  a.accept(event(5,'wire-23',{id:7,vital:'mana',value:30,leech:true},23),7);
  a.accept(event(6,'wire-23',{id:8,vital:'mana',value:999},23),7);
  a.accept(event(7,'wire-24',{id:7,kind:'spell',itemId:237},24),7,true);
  a.accept(event(8,'wire-23',{id:7,vital:'mana',value:999},23),7,false,false);
  const s=a.read();
  assert.deepEqual(s.itemUses,{'237':1}); assert.deepEqual(s.spellCasts,{});
  assert.equal(s.healthRestored,120); assert.equal(s.lifeLeech,20);
  assert.equal(s.manaRestored,30); assert.equal(s.manaLeech,30);
  assert.equal(s.leechFieldObserved,true);
  a.reset(); assert.deepEqual(a.read().itemUses,{}); assert.equal(a.read().leechFieldObserved,false);
});
test('explicit flags count criticals and blocks without treating missing flags as confirmation', () => {
  const a=create();
  a.accept(event(1,'wire-20',{attackerId:7,targetId:8,value:50},20),7);
  assert.equal(a.read().criticalFieldObserved,false);
  a.accept(event(2,'wire-20',{attackerId:7,targetId:8,value:100,critical:true},20),7);
  a.accept(event(3,'wire-20',{attackerId:8,targetId:7,value:40,critical:true},20),7);
  a.accept(event(4,'wire-20',{attackerId:7,targetId:8,value:0,blockType:'armor'},20),7);
  a.accept(event(5,'wire-20',{attackerId:8,targetId:7,blockType:'shield'},20),7);
  a.accept(event(6,'wire-20',{attackerId:9,targetId:8,value:100,critical:true},20),7);
  const s=a.read();
  assert.equal(s.outgoingCriticals,1); assert.equal(s.incomingCriticals,1);
  assert.equal(s.outgoingBlocks,1); assert.equal(s.incomingBlocks,1);
  assert.equal(s.outgoingHits,2); assert.equal(s.damageDealt,150);
  assert.equal(s.criticalFieldObserved,true); assert.equal(s.blockFieldObserved,true);
});

test('supply comparison uses immutable baselines and keeps projectiles separate from consumption', () => {
  const a=create();
  a.accept(event(1,'wire-24',{id:7,kind:'spell',itemId:237},24),7);
  a.accept(event(2,'hunt-analyzer-update',{startedAt:100,experience:0,supplies:[{itemId:237,name:'Mana',count:10}]}),7);
  a.accept(event(3,'wire-24',{id:7,kind:'spell',itemId:237},24),7);
  a.accept(event(4,'wire-84',{attackerId:7,targetId:8,kind:'arrow'},84),7);
  a.accept(event(4,'wire-84',{attackerId:7,targetId:8,kind:'arrow'},84),7);
  a.accept(event(5,'wire-84',{attackerId:8,targetId:7,kind:'arrow'},84),7);
  a.accept(event(6,'hunt-analyzer-update',{startedAt:100,experience:0,supplies:[{itemId:237,name:'Mana',count:11},{itemId:15793,name:'Arrow',count:1}]}),7);
  const c=a.read().comparison;
  assert.equal(c.itemRows.find(r=>r.itemId===237).difference,0);
  assert.equal(c.itemRows.find(r=>r.itemId===237).observedUses,1);
  assert.equal(c.itemRows.find(r=>r.itemId===15793).difference,-1);
  assert.deepEqual(c.projectiles,{arrow:1});
  assert.equal(a.read().itemUses[15793],undefined);
  a.reset();assert.deepEqual(a.read().projectiles,{});
});
