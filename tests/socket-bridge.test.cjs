const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const XOR_SEED = 1213550164;

function xorBytes(bytes, nonce) {
  let state = (nonce ^ XOR_SEED) >>> 0;
  if (state === 0) state = XOR_SEED;
  for (let index = 0; index < bytes.length; index += 1) {
    if ((index & 3) === 0) {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17; state >>>= 0;
      state ^= state << 5; state >>>= 0;
    }
    bytes[index] ^= (state >>> ((index & 3) << 3)) & 255;
  }
  return bytes;
}

function frame(code, payload, nonce = 123456) {
  const body = new TextEncoder().encode(JSON.stringify([code, payload]));
  const result = new Uint8Array(5 + body.length);
  new DataView(result.buffer).setUint32(0, nonce, true);
  result[4] = 0;
  result.set(body, 5);
  xorBytes(result.subarray(4), nonce);
  return result;
}

function decode(input) {
  const bytes = new Uint8Array(input);
  const nonce = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  xorBytes(bytes.subarray(4), nonce);
  assert.equal(bytes[4], 0);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(5)));
}

function bridge() {
  const windowListeners = new Map();
  const posts = [];
  class FakeWebSocket {
    static OPEN = 1;
    static instances = [];
    constructor(url) { this.url = url; this.readyState = FakeWebSocket.OPEN; this.listeners = new Map(); this.sent = []; FakeWebSocket.instances.push(this); }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    emit(type, value = {}) { return this.listeners.get(type)?.(value); }
    send(value) { this.sent.push(value); }
  }
  const window = {
    WebSocket: FakeWebSocket,
    addEventListener(type, handler) { windowListeners.set(type, handler); },
    postMessage(message) { posts.push(message); }
  };
  const context = vm.createContext({ window, WebSocket: FakeWebSocket, location: { href: "https://huntera.com.br/game" }, URL, Uint8Array, Uint32Array, ArrayBuffer, Blob, TextEncoder, TextDecoder, crypto: crypto.webcrypto, Date, JSON, Map, Set });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../socket-bridge.js"), "utf8"), context);
  return { window, windowListeners, posts, FakeWebSocket };
}

test("sends Huntera select-ammo opcode 77 through the observed socket", () => {
  const harness = bridge();
  const socket = new harness.window.WebSocket("wss://huntera.com.br/game-socket");
  socket.emit("open");
  harness.windowListeners.get("message")({ source: harness.window, data: { source: "gamepilot-huntera-content", type: "socket-command", requestId: "one", command: "select-ammo", payload: { itemId: 35901 } } });
  assert.deepEqual(decode(socket.sent[0]), [77, { itemId: 35901 }]);
  assert.equal(harness.posts.at(-1).kind, "command-result");
  assert.equal(harness.posts.at(-1).ok, true);
});

test("does not bypass Huntera's own auto-loot state handler", () => {
  const harness = bridge();
  const socket = new harness.window.WebSocket("wss://huntera.com.br/game-socket");
  socket.emit("open");
  harness.windowListeners.get("message")({ source: harness.window, data: { source: "gamepilot-huntera-content", type: "socket-command", requestId: "loot", command: "set-auto-loot", payload: { disabledItemIds: [3583, "3349", 3583] } } });
  assert.equal(socket.sent.length, 0);
  assert.equal(harness.posts.at(-1).kind, "command-result");
  assert.equal(harness.posts.at(-1).ok, false);
});

test("sends Huntera hunt quick-sell opcode 34 through the observed socket", () => {
  const harness = bridge();
  const socket = new harness.window.WebSocket("wss://huntera.com.br/game-socket");
  socket.emit("open");
  harness.windowListeners.get("message")({ source: harness.window, data: { source: "gamepilot-huntera-content", type: "socket-command", requestId: "dispatch", command: "hunt-quick-sell", payload: {} } });
  assert.deepEqual(decode(socket.sent[0]), [34, {}]);
  assert.equal(harness.posts.at(-1).ok, true);
});

test("keeps an authoritative creature roster in socket snapshots", async () => {
  const harness = bridge();
  const socket = new harness.window.WebSocket("wss://huntera.com.br/game-socket");
  socket.emit("open");
  await socket.emit("message", { data: frame(155, { creatures: [{ id: 1, kind: "player" }, { id: 2, kind: "monster", name: "Dragon" }] }).buffer });
  harness.windowListeners.get("message")({ source: harness.window, data: { source: "gamepilot-huntera-content", type: "socket-snapshot-request" } });
  const snapshot = harness.posts.at(-1).snapshot;
  assert.equal(snapshot.creaturesReceived, true);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.creatures)), [{ id: 1, kind: "player" }, { id: 2, kind: "monster", name: "Dragon" }]);
});

test('retains official imbuement material IDs for content script replay', async () => {
  const h = bridge(), socket = new h.window.WebSocket('wss://huntera.com.br/game-socket');
  socket.emit('open');
  await socket.emit('message', { data: frame(142, { items: [10, 20] }).buffer });
  const message = h.posts.find(p => p.kind === 'message').message;
  assert.equal(message.type, 'imbuement-materials');
  assert.deepEqual(JSON.parse(JSON.stringify(message.payload.items)), [10, 20]);
});

test('serializes asynchronous decode and discards data from replaced connections', async () => {
  const h=bridge(), s=new h.window.WebSocket('wss://huntera.com.br/game-socket'); s.emit('open');
  let release;
  class SlowBlob extends Blob { async arrayBuffer(){await new Promise(r=>{release=r});return super.arrayBuffer();} }
  const first=s.emit('message',{data:new SlowBlob([frame(24,{spellId:'first'})])});
  await Promise.resolve();
  const second=s.emit('message',{data:frame(20,{value:42}).buffer});
  release(); await Promise.all([first,second]);
  const events=h.posts.filter(p=>p.kind==='message').map(p=>p.message);
  assert.deepEqual(events.map(e=>e.code),[24,20]);
  assert.deepEqual(events.map(e=>e.sequence),[1,2]);
  const pending=s.emit('message',{data:new SlowBlob([frame(24,{spellId:'old'})])});
  await Promise.resolve(); s.emit('close'); release(); await pending;
  assert.equal(h.posts.filter(p=>p.kind==='message').length,2);
});
