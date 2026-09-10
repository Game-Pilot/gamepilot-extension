const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function parse(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`Invalid version: ${version}`);
  const parts = version.split('.').map(Number);
  if (parts.some(n => n > 65535)) throw new Error('Chrome version component exceeds 65535');
  return parts;
}
function nextVersion(current, previous) {
  const a = parse(current), b = parse(previous);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return current; // Respect an explicit bump.
    if (a[i] < b[i]) throw new Error('Version must not decrease');
  }
  for (let i = 2; i >= 0; i--) {
    if (a[i] < 65535) { a[i]++; return a.join('.'); }
    a[i] = 0;
  }
  throw new Error('Chrome version range exhausted');
}
function runtimeFile(file) {
  return file === 'manifest.json' || (!/^(tests|scripts|\.github)\//.test(file) && /\.(js|css|html|png|svg|webp|ico|json)$/.test(file));
}
if (require.main === module) {
  const manifest = 'manifest.json';
  const text = fs.readFileSync(manifest, 'utf8');
  const current = JSON.parse(text).version;
  let version;
  if (process.argv[2] === '--bump') version = nextVersion(current, current);
  else {
    const base = process.argv[2];
    if (!/^[a-f0-9]{40}$/.test(base || '')) throw new Error('Expected a full base commit SHA');
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const files = git('diff', '--name-only', base, 'HEAD').split('\n');
    if (!files.some(runtimeFile)) process.exit(0);
    version = nextVersion(current, JSON.parse(git('show', `${base}:manifest.json`)).version);
  }
  if (version !== current) fs.writeFileSync(manifest, text.replace(/("version"\s*:\s*")[^"]+"/, `$1${version}"`));
  console.log(`Extension version: ${version}`);
}
module.exports = { nextVersion, runtimeFile };
