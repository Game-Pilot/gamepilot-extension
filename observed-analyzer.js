// Passive counters: never infer loot/consumption from inventory movement.
(function () {
  function create() {
    let state, sequence, session, baseline, comparison, bestiary;
    function reset() {
      state = { source: 'websocket-observed', startedAt: null, observedAt: null, xpGained: 0,
        kills: 0, damageReceived: 0, damageDealt: 0, outgoingHits: 0, spellCasts: {}, itemUses: {}, projectiles: {},
        healthRestored: 0, manaRestored: 0, lifeLeech: 0, manaLeech: 0,
        outgoingCriticals: 0, incomingCriticals: 0, outgoingBlocks: 0, incomingBlocks: 0,
        criticalFieldObserved: false, blockFieldObserved: false, leechFieldObserved: false, killCoverage: 'partial' };
      sequence = 0; session = null; baseline = null; comparison = null; bestiary = {};
    }
    reset();
    const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    function accept(message, playerId, replay = false, active = true) {
      const p = message.payload || {};
      if (!Number.isInteger(message.sequence) || message.sequence <= sequence) return;
      sequence = message.sequence;
      if (['hunt-analyzer-session', 'hunt-analyzer-update'].includes(message.type) && p.startedAt != null) {
        if (session !== null && session !== p.startedAt) {
          const previousSequence = sequence;
          reset(); sequence = previousSequence;
        }
        session = p.startedAt;
      }
      if (message.type === 'bestiary-progress') {
        for (const [key, kills] of Object.entries(p.kills || {})) {
          const previous = bestiary[key];
          const stage = p.stages?.[key] ?? 0;
          if (!replay && active && numeric(kills) && previous && previous.stage === stage && kills >= previous.kills) state.kills += kills - previous.kills;
          bestiary[key] = { kills, stage };
        }
      }
      // A snapshot has only the LAST event per type, not a complete event log.
      if (replay || !active) return;
      if (!state.startedAt) state.startedAt = message.receivedAt;
      state.observedAt = message.receivedAt;
      // Diagnostic visual projectile count; never equate it to ammunition spent.
      if (message.code === 84 && playerId != null && p.attackerId === playerId &&
          typeof p.kind === 'string' && /^[a-z0-9-]{1,80}$/.test(p.kind) &&
          !['constructor', 'prototype'].includes(p.kind)) {
        if (Object.hasOwn(state.projectiles, p.kind) || Object.keys(state.projectiles).length < 128)
          state.projectiles[p.kind] = (state.projectiles[p.kind] || 0) + 1;
      }
      if (message.type === 'experience-gain' && playerId != null && p.playerId === playerId && numeric(p.value)) state.xpGained += p.value;
      if (message.code === 20 && playerId != null && p.targetId === playerId && numeric(p.value)) state.damageReceived += p.value;
      if (message.code === 20 && playerId != null && p.attackerId === playerId && p.targetId != null && p.targetId !== playerId && numeric(p.value)) {
        state.damageDealt += p.value;
        if (!p.blockType) state.outgoingHits++;
      }
      if (message.code === 20 && playerId != null && (p.attackerId === playerId || p.targetId === playerId)) {
        if (typeof p.critical === 'boolean') state.criticalFieldObserved = true;
        if (typeof p.blockType === 'string' && p.blockType) state.blockFieldObserved = true;
        const direction = p.targetId === playerId ? 'incoming' : 'outgoing';
        if (p.critical === true) state[`${direction}Criticals`]++;
        if (typeof p.blockType === 'string' && p.blockType) state[`${direction}Blocks`]++;
      }
      if (message.code === 23 && playerId != null && p.id === playerId && numeric(p.value) && ['health', 'mana'].includes(p.vital)) {
        state[p.vital === 'health' ? 'healthRestored' : 'manaRestored'] += p.value;
        if (typeof p.leech === 'boolean') state.leechFieldObserved = true;
        if (p.leech === true) state[p.vital === 'health' ? 'lifeLeech' : 'manaLeech'] += p.value;
      }
      if (message.code === 24 && playerId != null && p.id === playerId && p.kind === 'spell' && Number.isInteger(p.itemId) && p.itemId > 0) {
        if (Object.hasOwn(state.itemUses, p.itemId) || Object.keys(state.itemUses).length < 256)
          state.itemUses[p.itemId] = (state.itemUses[p.itemId] || 0) + 1;
      }
      // Cast notifications are not damage attribution: hits can precede the
      // notification and overlap with basic attacks, AoE and other spells.
      if (message.code === 24 && playerId != null && p.id === playerId && p.kind === 'spell' && p.itemId == null &&
          typeof p.spellId === 'string' && /^[a-z0-9-]{1,80}$/.test(p.spellId) &&
          !['__proto__', 'constructor', 'prototype'].includes(p.spellId)) {
        if (Object.hasOwn(state.spellCasts, p.spellId) || Object.keys(state.spellCasts).length < 128)
          state.spellCasts[p.spellId] = (state.spellCasts[p.spellId] || 0) + 1;
      }
      if (message.type === 'hunt-analyzer-update' && numeric(p.experience)) {
        const damage = Array.isArray(p.damageInput) && p.damageInput.every(row => numeric(row.value))
          ? p.damageInput.reduce((sum, row) => sum + row.value, 0) : null;
        const official = { xpGained: p.experience, kills: numeric(p.kills) ? p.kills : null, damageReceived: damage };
        const supplies = Array.isArray(p.supplies) ? Object.fromEntries(p.supplies
          .filter(item => Number.isInteger(item.itemId) && item.itemId > 0 && numeric(item.count))
          .map(item => [item.itemId, { count: item.count, name: typeof item.name === 'string' ? item.name.slice(0, 100) : null }])) : null;
        if (!baseline) baseline = { at: message.receivedAt, official, supplies, observed: JSON.parse(JSON.stringify(state)) };
        else {
          const rows = Object.keys(official).map(key => {
            const reference = official[key] === null || baseline.official[key] === null ? null : official[key] - baseline.official[key];
            const observed = state[key] - baseline.observed[key];
            return { key, observed, official: reference, difference: reference === null ? null : observed - reference };
          });
          const itemRows = supplies && baseline.supplies ? [...new Set([...Object.keys(supplies), ...Object.keys(baseline.supplies), ...Object.keys(state.itemUses)])].map(id => {
            const reference = (supplies[id]?.count || 0) - (baseline.supplies[id]?.count || 0);
            const observed = (state.itemUses[id] || 0) - (baseline.observed.itemUses[id] || 0);
            return { itemId: Number(id), name: supplies[id]?.name || baseline.supplies[id]?.name || null,
              observedUses: observed, officialCount: reference, difference: observed - reference };
          }) : null;
          comparison = { from: baseline.at, to: message.receivedAt, rows, itemRows,
            projectiles: Object.fromEntries(Object.entries(state.projectiles).map(([kind, count]) => [kind, count - (baseline.observed.projectiles[kind] || 0)])) };
        }
      }
    }
    function read() {
      const durationMs = state.startedAt ? Math.max(0, Date.parse(state.observedAt) - Date.parse(state.startedAt)) : 0;
      return JSON.parse(JSON.stringify({ ...state, sessionStartedAt: session, durationMs,
        xpPerHour: durationMs > 0 ? Math.round(state.xpGained * 3600000 / durationMs) : null,
        damagePerSecond: durationMs > 0 ? Math.round(state.damageDealt * 10000 / durationMs) / 10 : null,
        unattributedDamage: state.damageDealt,
        spellAttribution: 'unavailable-no-shared-event-id',
        comparison, comparisonPending: Boolean(baseline) && !comparison,
        unavailable: ['rawExperience', 'loot', 'supplies', 'waste', 'balance', 'damageChannels'] }));
    }
    return { reset, accept, read };
  }
  globalThis.GamePilotObservedAnalyzer = { create };
  if (typeof module !== 'undefined') module.exports = { create };
})();
