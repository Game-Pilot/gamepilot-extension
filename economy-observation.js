// Passive diagnostics. Values remain separate from the official hunt metrics
// until drop/collection and wallet/consumption coverage have been reconciled.
(function () {
  const clone = value => JSON.parse(JSON.stringify(value));
  const valid = value => typeof value === 'number' && Number.isFinite(value);
  const itemFields = ['uid', 'itemId', 'count', 'name', 'sellLocked', 'bound'];
  const item = value => value && typeof value === 'object'
    ? { ...Object.fromEntries(itemFields.filter(k => k in value).map(k => [k, value[k]])),
      hasImbuements: Boolean(value.imbuements) } : null;
  function create() {
    let state, sequence, bytes;
    function reset() {
      state = { schemaVersion: 1, source: 'websocket-economy-observation',
        sessionStartedAt: null, observedFrom: null, observedAt: null,
        inventory: null, prices: { npc: null, auction: null }, quickSellItemIds: null,
        uses: {}, drops: {}, eventCounts: {}, events: [], droppedEvents: 0 };
      sequence = 0; bytes = 0;
    }
    reset();
    function accept(message, playerId, replay = false, active = false) {
      if (!Number.isInteger(message.sequence) || message.sequence <= sequence) return;
      sequence = message.sequence;
      const p = message.payload || {}, code = message.code;
      if (code === 40 && valid(p.startedAt) && state.sessionStartedAt !== p.startedAt) {
        state.sessionStartedAt = p.startedAt;
        // Counters span this connection, with session tags on every event.
        // Consumers must require the same session on both measurement endpoints.
      }
      if (code === 57) {
        for (const kind of ['npc', 'auction']) if (Array.isArray(p[kind])) {
          state.prices[kind] = p[kind].filter(row => Array.isArray(row) && row.length === 2 &&
            Number.isInteger(row[0]) && valid(row[1]) && row[1] >= 0).map(row => row.slice());
        }
      }
      if (code === 85 && Array.isArray(p.itemIds)) state.quickSellItemIds = p.itemIds.filter(Number.isInteger);
      if (code === 74 && Array.isArray(p.slots) && Array.isArray(p.satchel) && valid(p.gold)) {
        state.inventory = { slots: p.slots.map(item), satchel: p.satchel.map(item), gold: p.gold };
      }
      const previousGold = state.inventory?.gold ?? null;
      if (code === 55 && state.inventory) {
        for (const [field, size] of [['slots', p.slotCount], ['satchel', p.satchelCount]]) {
          if (Number.isInteger(size) && size >= 0 && size <= 10000) state.inventory[field].length = size;
        }
        for (const change of Array.isArray(p.changes) ? p.changes : []) {
          const field = change.container === 'backpack' ? 'slots' : change.container === 'satchel' ? 'satchel' : null;
          if (field && Number.isInteger(change.index) && change.index >= 0 && change.index < state.inventory[field].length)
            state.inventory[field][change.index] = item(change.item);
        }
        if (valid(p.gold)) state.inventory.gold = p.gold;
      }
      // Snapshots contain only the last event per type. Use them as state, never
      // replay them into financial counters or pretend they are an event log.
      if (replay) return;
      const fields = { 24: ['id', 'kind', 'itemId'], 40: ['startedAt', 'durationMs'],
        49: ['remainingMs', 'previewMs', 'previewTrigger', 'timerMs'],
        55: ['gold'], 59: [], 60: [], 61: ['uid'], 62: [], 74: ['gold'] }[code];
      if (!fields || (code === 24 && (p.id !== playerId || p.itemId == null))) return;
      const payload = Object.fromEntries(fields.filter(k => k in p).map(k => [k, p[k]]));
      if ([59, 60].includes(code)) payload.item = item(p.item);
      if (code === 62) payload.slots = Array.isArray(p.slots) ? p.slots.map(item) : null;
      if (code === 55) {
        payload.previousGold = previousGold;
        payload.changes = (Array.isArray(p.changes) ? p.changes : []).map(change => ({
          container: change.container, index: change.index, slot: change.slot, item: item(change.item) }));
      }
      state.observedFrom ||= message.receivedAt;
      state.observedAt = message.receivedAt;
      state.eventCounts[code] = (state.eventCounts[code] || 0) + 1;
      if (active && code === 24 && p.kind === 'spell' && Number.isInteger(p.itemId))
        state.uses[p.itemId] = (state.uses[p.itemId] || 0) + 1;
      if (active && code === 60 && Number.isInteger(p.item?.itemId) && valid(p.item?.count) && p.item.count > 0) {
        const row = state.drops[p.item.itemId] ||= { itemId: p.item.itemId, name: p.item.name, count: 0, events: 0 };
        row.count += p.item.count; row.events++;
      }
      const event = { sequence, code, receivedAt: message.receivedAt, active,
        sessionStartedAt: state.sessionStartedAt, payload };
      const size = JSON.stringify(event).length;
      if (size > 16384) { state.droppedEvents++; return; }
      state.events.push(event); bytes += size;
      while (state.events.length > 1200 || bytes > 131072) {
        bytes -= JSON.stringify(state.events.shift()).length; state.droppedEvents++;
      }
    }
    return { reset, accept, read: () => clone({ ...state, lastSequence: sequence }) };
  }
  globalThis.GamePilotEconomyObservation = { create };
  if (typeof module !== 'undefined') module.exports = { create };
})();
