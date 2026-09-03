(function installGamePilotHunteraSocketBridge() {
  const BRIDGE_SOURCE = "gamepilot-huntera-socket";
  const REQUEST_SOURCE = "gamepilot-huntera-content";
  const XOR_SEED = 1213550164;
  const MAX_FRAME_BYTES = 2 * 1024 * 1024;

  if (window.__gamepilotHunteraSocketBridge) return;
  window.__gamepilotHunteraSocketBridge = { version: 1 };

  const MESSAGE_TYPES = Object.freeze({
    2: "action-bar-update",
    7: "auto-loot-update",
    8: "battle-settings-update",
    11: "capacity-overflow",
    14: "coins",
    29: "depot-update",
    30: "experience-gain",
    46: "hunt-leave-pending",
    40: "hunt-analyzer-session",
    41: "hunt-analyzer-update",
    42: "hunt-catalog",
    43: "hunt-exit-rules",
    47: "hunt-pending",
    49: "hunt-quick-sell-state",
    54: "instance-enter",
    55: "inventory-delta",
    57: "item-values",
    62: "loot-update",
    63: "market-browse-result",
    64: "market-enter",
    69: "market-result",
    66: "market-items",
    73: "player-died",
    74: "player-inventory",
    77: "player-stats",
    78: "player-target",
    80: "pong",
    85: "quick-sell-update",
    89: "shop-offers",
    90: "store-offers",
    91: "store-result",
    92: "system-message",
    96: "training-update",
    103: "welcome",
    106: "xp-scroll-state",
    115: "hunt-start-warning",
    126: "hunt-sell-rules",
    132: "alerts-state",
    155: "creature-resync"
  });

  const activeSockets = new Set();
  const latest = {
    connected: false,
    socketUrl: null,
    openedAt: null,
    lastMessageAt: null,
    lastMessageType: null,
    messages: {}
  };

  function now() {
    return new Date().toISOString();
  }

  function post(kind, value = {}) {
    window.postMessage({ source: BRIDGE_SOURCE, version: 1, kind, ...value }, "*");
  }

  function xorBytes(bytes, nonce) {
    let state = (nonce ^ XOR_SEED) >>> 0;
    if (state === 0) state = XOR_SEED;
    for (let index = 0; index < bytes.length; index += 1) {
      if ((index & 3) === 0) {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state >>>= 0;
        state ^= state << 5;
        state >>>= 0;
      }
      bytes[index] ^= (state >>> ((index & 3) << 3)) & 255;
    }
    return bytes;
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream !== "function") return null;
    for (const format of ["deflate", "deflate-raw"]) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {
        // Huntera currently uses zlib/deflate. The raw fallback tolerates a
        // protocol change without breaking observation of uncompressed frames.
      }
    }
    return null;
  }

  function readUint32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  async function decodeFrame(input) {
    if (!input || input.length < 5 || input.length > MAX_FRAME_BYTES) return [];
    const bytes = new Uint8Array(input);
    const nonce = readUint32(bytes, 0);
    xorBytes(bytes.subarray(4), nonce);
    const flags = bytes[4];
    let body = bytes.subarray(5);
    if (flags & 1) {
      body = await inflate(body);
      if (!body) return [];
    }
    if (flags & 2) {
      const messages = [];
      let offset = 0;
      while (offset + 4 <= body.length) {
        const length = readUint32(body, offset);
        offset += 4;
        if (!length || offset + length > body.length) return [];
        messages.push(...await decodeFrame(body.slice(offset, offset + length)));
        offset += length;
      }
      return messages;
    }
    try {
      const decoded = JSON.parse(new TextDecoder().decode(body));
      if (!Array.isArray(decoded) || decoded.length !== 2 || !Number.isFinite(Number(decoded[0]))) return [];
      const code = Number(decoded[0]);
      return [{ code, type: MESSAGE_TYPES[code] || `wire-${code}`, payload: decoded[1] && typeof decoded[1] === "object" ? decoded[1] : {} }];
    } catch {
      return [];
    }
  }

  function snapshot() {
    return {
      connected: latest.connected,
      socketUrl: latest.socketUrl,
      openedAt: latest.openedAt,
      lastMessageAt: latest.lastMessageAt,
      lastMessageType: latest.lastMessageType,
      messages: { ...latest.messages }
    };
  }

  function record(message) {
    const receivedAt = now();
    const entry = { ...message, receivedAt };
    latest.lastMessageAt = receivedAt;
    latest.lastMessageType = entry.type;
    latest.messages[entry.type] = entry;
    post("message", { message: entry });
  }

  async function handleData(data) {
    try {
      let bytes;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
      else return;
      for (const message of await decodeFrame(bytes)) record(message);
    } catch {
      // Observation must never interfere with the game connection.
    }
  }

  function isHunteraSocket(url) {
    try {
      const parsed = new URL(String(url), location.href);
      return parsed.protocol === "ws:" || parsed.protocol === "wss:" ? /(^|\.)huntera\.com\.br$/i.test(parsed.hostname) : false;
    } catch {
      return /huntera\.com\.br/i.test(String(url));
    }
  }

  function observe(socket, url) {
    if (!isHunteraSocket(url) || socket.__gamepilotObserved) return;
    socket.__gamepilotObserved = true;
    latest.socketUrl = String(url);
    socket.addEventListener("open", () => {
      activeSockets.add(socket);
      latest.connected = true;
      latest.openedAt = now();
      post("connection", { status: "open", socketUrl: String(url), at: latest.openedAt });
    });
    socket.addEventListener("message", (event) => void handleData(event.data));
    socket.addEventListener("error", () => post("connection", { status: "error", socketUrl: String(url), at: now() }));
    socket.addEventListener("close", () => {
      activeSockets.delete(socket);
      latest.connected = activeSockets.size > 0;
      post("connection", { status: latest.connected ? "open" : "closed", socketUrl: String(url), at: now() });
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== REQUEST_SOURCE) return;
    if (event.data.type === "socket-snapshot-request") post("snapshot", { snapshot: snapshot() });
  });

  try {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args);
        observe(socket, args[0]);
        return socket;
      }
    });
  } catch {
    // If the browser disallows replacing the constructor, the current DOM
    // adapter remains fully functional and reports its normal fallback state.
  }
})();
