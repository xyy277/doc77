/**
 * Build guard: the Electron main process must NEVER statically require
 * @doc77/core — its CJS entry pulls ESM-only deps (marked) that Electron's
 * bundled Node cannot require(), crashing the packaged app at startup with
 * ERR_REQUIRE_ESM (1.0.0-beta.1 shipped with this bug). Core may only be
 * loaded via dynamic import (server.ts loadCore). Local dev on Node >= 22.12
 * masks the bug because require(esm) is enabled there — hence this check.
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const offenders = [];
for (const f of fs.readdirSync(dist)) {
  if (!f.endsWith('.js')) continue;
  const s = fs.readFileSync(path.join(dist, f), 'utf8');
  if (/require\(["']@doc77\/core["']\)/.test(s)) offenders.push(f);
}
if (offenders.length) {
  console.error('❌ Static require("@doc77/core") found in: ' + offenders.join(', '));
  console.error('   Use the ./i18n shim / dynamic import instead (see server.ts loadCore).');
  process.exit(1);
}
console.log('✅ no static @doc77/core require in electron dist');
