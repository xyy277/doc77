#!/usr/bin/env node
/**
 * Generate latest.yml (or latest-mac.yml / latest-linux.yml) for
 * electron-updater from the artifacts produced by electron-builder.
 *
 * Usage (in CI, per platform job):
 *   node scripts/gen-latest-yml.cjs --platform win
 *   node scripts/gen-latest-yml.cjs --platform mac
 *   node scripts/gen-latest-yml.cjs --platform linux
 *
 * Output is written to packages/electron/release/latest.yml (or variant).
 * Only the current platform's installer is listed; electron-updater
 * selects the matching entry on the client.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RELEASE_DIR = path.join(__dirname, '..', 'release');
const PACKAGE_JSON = path.join(__dirname, '..', 'package.json');

// ── Resolve platform ────────────────────────────────────────────────────

const idx = process.argv.indexOf('--platform');
if (idx < 0) {
  console.error('Usage: gen-latest-yml.cjs --platform win|mac|linux');
  process.exit(1);
}
const platform = process.argv[idx + 1];

const YML_MAP = { win: 'latest.yml', mac: 'latest-mac.yml', linux: 'latest-linux.yml' };
const ymlName = YML_MAP[platform];
if (!ymlName) {
  console.error('Unknown platform:', platform);
  process.exit(1);
}

// ── Find installer file ─────────────────────────────────────────────────

const EXT_PRIORITY = {
  win: ['.exe'],
  mac: ['.dmg', '.zip'],
  linux: ['.AppImage', '.deb', '.snap'],
};
const candidates = fs
  .readdirSync(RELEASE_DIR)
  .filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return EXT_PRIORITY[platform]?.includes(ext) && f !== 'builder-debug.yml';
  })
  .sort((a, b) => fs.statSync(path.join(RELEASE_DIR, a)).size - fs.statSync(path.join(RELEASE_DIR, b)).size);

if (candidates.length === 0) {
  console.error('No installer found for platform', platform);
  process.exit(1);
}
// Pick the smallest (typically the NSIS exe or dmg)
const fileName = candidates[0];

const filePath = path.join(RELEASE_DIR, fileName);
const buf = fs.readFileSync(filePath);
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
const size = buf.length;

// ── Build YAML ──────────────────────────────────────────────────────────

const version = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')).version;
const yml = [
  'version: ' + version,
  'files:',
  '  - url: ' + fileName,
  '    sha512: ' + sha512,
  '    size: ' + size,
  'path: ' + fileName,
  'sha512: ' + sha512,
  'releaseDate: ' + new Date().toISOString(),
  '',
].join('\n');

fs.writeFileSync(path.join(RELEASE_DIR, ymlName), yml, 'utf8');
console.log(
  '[' + platform + '] ' + ymlName + ': ' + fileName + ' (' + (size / 1024 / 1024).toFixed(1) + 'MB, sha512)',
);
