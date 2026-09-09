const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function transport(fetchImpl, WebSocketImpl) {
  const context = vm.createContext({
    URL,
    Date,
    console,
    fetch: fetchImpl,
    AbortController,
    TypeError,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...(WebSocketImpl ? { WebSocket: WebSocketImpl } : {}),
    chrome: {
      sidePanel: { setPanelBehavior: async () => {} },
      runtime: {
        getManifest: () => ({ version: "0.8.11" }),
        onMessage: { addListener() {} }
      },
      storage: {
        local: {
          get(_key, callback) { callback({ "gamepilot.deviceToken": "token" }); },
          set(_values, callback) { callback(); }
        }
      }
    }
  });
  let source = fs.readFileSync(path.join(__dirname, "../service-worker.js"), "utf8");
  source = source.replace(
    "chrome.runtime.onMessage.addListener",
    "globalThis.testTransport = { api, retryableStatus, socketRequest, stopSocket }; chrome.runtime.onMessage.addListener"
  );
  vm.runInContext(source, context);
  return context.testTransport;
}

function socketHarness() {
  const instances = [];
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = MockWebSocket.CONNECTING;
      this.sent = [];
      instances.push(this);
      queueMicrotask(() => {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
      });
    }
    send(serialized) {
      const message = JSON.parse(serialized);
      this.sent.push(message);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "ack", replyTo: message.id, ok: true, command: null }) }));
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.();
    }
  }
  return { MockWebSocket, instances };
}

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("retries an idempotent heartbeat after a transient network failure", async () => {
  let calls = 0;
  const { api } = transport(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("offline");
    return response(200, { ok: true });
  });
  const result = await api("/api/v1/agent/state", { method: "POST" }, { retries: 2 });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test("does not retry requests unless the caller marks them safe", async () => {
  let calls = 0;
  const { api } = transport(async () => {
    calls += 1;
    throw new TypeError("response lost");
  });
  await assert.rejects(api("/api/v1/agent/commands"), /response lost/);
  assert.equal(calls, 1);
});

test("does not retry permanent API failures", async () => {
  let calls = 0;
  const { api, retryableStatus } = transport(async () => {
    calls += 1;
    return response(401, { error: "Extensão não autorizada" });
  });
  await assert.rejects(api("/api/v1/agent/state", { method: "POST" }, { retries: 2 }), /não autorizada/);
  assert.equal(calls, 1);
  assert.equal(retryableStatus(503), true);
  assert.equal(retryableStatus(401), false);
});

test("multiplexes state messages over one authenticated WebSocket", async () => {
  const { MockWebSocket, instances } = socketHarness();
  const transportApi = transport(async () => response(200), MockWebSocket);
  try {
    const first = await transportApi.socketRequest("state", { state: { connectionKey: "connection-1" } });
    const second = await transportApi.socketRequest("state", { state: { connectionKey: "connection-2" } });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(instances.length, 1);
    assert.match(instances[0].url, /^wss:\/\//);
    assert.equal(JSON.stringify(instances[0].protocols), JSON.stringify(["gamepilot-v1", "gamepilot-device.token"]));
    assert.deepEqual(instances[0].sent.map(message => message.state.connectionKey), ["connection-1", "connection-2"]);
  } finally {
    transportApi.stopSocket();
  }
});

test("opens a replacement WebSocket after the active connection drops", async () => {
  const { MockWebSocket, instances } = socketHarness();
  const transportApi = transport(async () => response(200), MockWebSocket);
  try {
    await transportApi.socketRequest("ping");
    instances[0].close();
    await transportApi.socketRequest("ping");
    assert.equal(instances.length, 2);
  } finally {
    transportApi.stopSocket();
  }
});
