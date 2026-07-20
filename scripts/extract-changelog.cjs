#!/usr/bin/env node
/**
 * Extract the CHANGELOG entry for a given version.
 *
 * Usage:
 *   node scripts/extract-changelog.cjs --version 1.0.3 > /tmp/release-notes.md
 */

const fs = require('fs');
const path = require('path');

const idx = process.argv.indexOf('--version');
if (idx < 0) {
  console.error('Usage: extract-changelog.cjs --version <semver>');
  process.exit(1);
}
const version = process.argv[idx + 1];

const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');

// Find the line `## [...] — \`version\``
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headerRe = new RegExp('##\\s+\\[[^\\]]+\\]\\s+—\\s+`' + escaped + '`');
const headerMatch = changelog.match(headerRe);

if (!headerMatch) {
  console.error('No CHANGELOG entry found for version', version);
  process.exit(1);
}

const start = headerMatch.index;
// Find the next `## [` header after ours — that's where this entry ends
const nextRe = /\n##\s+\[/g;
nextRe.lastIndex = start + headerMatch[0].length;
const nextMatch = nextRe.exec(changelog);
const end = nextMatch ? nextMatch.index : changelog.length;

process.stdout.write(changelog.slice(start, end).trim() + '\n');
