const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("selects Huntera's visible imbuement confirmation when a hidden dialog comes first", () => {
  const source = fs.readFileSync(path.join(__dirname, "../adapters/huntera.js"), "utf8");
  assert.match(source, /const confirmationSelector = "[^"]*\[role='dialog'\][^"]*"/);
  assert.match(source, /querySelectorAll\(confirmationSelector\)\]\.some\(visible\)/);
  assert.match(source, /querySelectorAll\(confirmationSelector\)\]\.find\(visible\)/);
});
