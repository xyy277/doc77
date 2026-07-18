#!/usr/bin/env node
/**
 * Sync the root README.md into packages/doc77/README.md for npm.
 *
 * Why: the npm page for `idoc77` renders the README bundled in the tarball;
 * relative image/link paths that work on GitHub 404 on npmjs.com, so every
 * relative reference is rewritten to an absolute GitHub URL (raw for images,
 * blob for documents/links).
 *
 * Run manually (commit the result) and in release-npm.yml before publishing.
 */
const fs = require('fs');
const path = require('path');

const REPO = 'xyy277/doc77';
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
const BLOB = `https://github.com/${REPO}/blob/main/`;

const root = path.resolve(__dirname, '..');
let md = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const isRelative = (u) => u && !/^(https?:|mailto:|#|data:)/.test(u);

// Markdown images: ![alt](relative) → raw URL
md = md.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (m, pre, url, post) =>
  isRelative(url) ? pre + RAW + url.replace(/^\.\//, '') + post : m,
);
// Markdown links: [text](relative) → blob URL
md = md.replace(/(?<!!)(\[[^\]]*\]\()([^)\s]+)(\))/g, (m, pre, url, post) =>
  isRelative(url) ? pre + BLOB + url.replace(/^\.\//, '') + post : m,
);
// HTML img src / a href
md = md.replace(/(src=")([^"]+)(")/g, (m, pre, url, post) =>
  isRelative(url) ? pre + RAW + url.replace(/^\.\//, '') + post : m,
);
md = md.replace(/(href=")([^"]+)(")/g, (m, pre, url, post) =>
  isRelative(url) ? pre + BLOB + url.replace(/^\.\//, '') + post : m,
);

const out = path.join(root, 'packages', 'doc77', 'README.md');
fs.writeFileSync(out, md);
console.log(`synced README → ${path.relative(root, out)} (${md.length} bytes)`);
