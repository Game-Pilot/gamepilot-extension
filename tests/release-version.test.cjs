const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextVersion, runtimeFile } = require('../scripts/version.cjs');
test('automatic versioning bumps missing patches and respects manual releases', () => {
  assert.equal(nextVersion('0.9.2', '0.9.2'), '0.9.3');
  assert.equal(nextVersion('0.10.0', '0.9.2'), '0.10.0');
  assert.equal(nextVersion('0.9.65535', '0.9.65535'), '0.10.0');
  assert.throws(() => nextVersion('0.9.1', '0.9.2'), /decrease/);
  assert.throws(() => nextVersion('0.09.2', '0.9.2'), /Invalid/);
});
test('runtime changes require a version, documentation and tests do not', () => {
  for (const file of ['manifest.json', 'popup.css', 'popup.html', 'adapters/huntera.js']) assert.equal(runtimeFile(file), true);
  for (const file of ['README.md', 'tests/version.test.cjs', 'scripts/version.cjs', '.github/workflows/version.yml']) assert.equal(runtimeFile(file), false);
});
