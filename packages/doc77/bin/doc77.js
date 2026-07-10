#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');
const cliDir = path.dirname(require.resolve('@doc77/cli/package.json'));
const cliBin = path.join(cliDir, 'dist/bin/doc77.js');
const result = spawnSync(process.execPath, [cliBin, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status || 0);
