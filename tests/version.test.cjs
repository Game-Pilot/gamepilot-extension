const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function versionApi(latest = "0.8.4", installed = "0.8.3") {
  const context = vm.createContext({
    URL,
    Date,
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ version: latest }) }),
    chrome: {
      sidePanel: { setPanelBehavior: async () => {} },
      runtime: {
        getManifest: () => ({ version: installed }),
        onMessage: { addListener() {} }
      },
      storage: {
        local: {
          get(_key, callback) { callback({}); },
          set(_values, callback) { callback(); }
        }
      }
    }
  });
  let source = fs.readFileSync(path.join(__dirname, "../service-worker.js"), "utf8");
  source = source.replace(
    "chrome.runtime.onMessage.addListener",
    "globalThis.testVersionApi = { compareVersions, extensionVersionStatus }; chrome.runtime.onMessage.addListener"
  );
  vm.runInContext(source, context);
  return context.testVersionApi;
}

test("compares numeric extension versions", () => {
  const api = versionApi();
  assert.equal(api.compareVersions("0.8.4", "0.8.3"), 1);
  assert.equal(api.compareVersions("0.8.3", "0.8.3"), 0);
  assert.equal(api.compareVersions("0.9.0", "0.10.0"), -1);
});

test("marks an installed extension as outdated against the published package", async () => {
  const api = versionApi("0.8.4", "0.8.3");
  const status = await api.extensionVersionStatus();
  assert.deepEqual(JSON.parse(JSON.stringify(status)), {
    installed: "0.8.3",
    latest: "0.8.4",
    updateAvailable: true,
    aheadOfPublished: false
  });
});

test("marks an unpublished local build as a preview", async () => {
  const api = versionApi("0.8.3", "0.8.4");
  const status = await api.extensionVersionStatus();
  assert.equal(status.updateAvailable, false);
  assert.equal(status.aheadOfPublished, true);
});
