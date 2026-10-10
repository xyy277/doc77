#!/usr/bin/env node
/**
 * 打包 CodeMirror 6 + 语言包为单个本地 ESM bundle（离线可用、模块同源）。
 *
 * 背景：此前 editor-core.js 从 esm.sh 逐个 import 模块，跨包加载导致
 * @codemirror/state 存在多个实例 —— 语言扩展被判为
 * "Unrecognized extension value in extension set"，且 esm.sh 是外部依赖
 * （与「本地优先、离线可用」定位冲突）。
 * 单 bundle 打包后所有模块共享同一 state 实例，Compartment 动态配置恢复可用。
 *
 * 输出：packages/core/src/web/assets/editor-bundle.js
 * 用法：node scripts/build-editor-bundle.mjs
 */
import * as esbuild from 'esbuild';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'packages/core/src/web/assets/editor-bundle.js');

const ENTRY = `
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, StateEffect } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { search, searchKeymap } from '@codemirror/search';
import { StreamLanguage } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { rust } from '@codemirror/lang-rust';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { go } from '@codemirror/lang-go';
import { php } from '@codemirror/lang-php';
import { shell as shellMode } from '@codemirror/legacy-modes/mode/shell';

// 语言工厂：key 与 preview.js getEditLanguage() 的返回值一一对应
export const LANGUAGES = {
  markdown: () => markdown(),
  javascript: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  jsx: () => javascript({ jsx: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  python: () => python(),
  json: () => json(),
  css: () => css(),
  html: () => html(),
  xml: () => xml(),
  sql: () => sql(),
  yaml: () => yaml(),
  rust: () => rust(),
  java: () => java(),
  cpp: () => cpp(),
  c: () => cpp(),
  go: () => go(),
  php: () => php(),
  shell: () => StreamLanguage.define(shellMode),
};

export { EditorView, EditorState, Compartment, StateEffect, keymap, basicSetup, oneDark, search, searchKeymap };
`;

async function main() {
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  const t0 = Date.now();
  // CodeMirror 依赖安装在 packages/core（pnpm 严格 node_modules 结构下
  // 根目录看不到），用 nodePaths 显式告诉 esbuild 解析位置。
  const coreNodeModules = path.join(root, 'packages', 'core', 'node_modules');
  const result = await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: root, loader: 'js', sourcefile: 'editor-entry.js' },
    bundle: true,
    format: 'esm',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    nodePaths: [coreNodeModules, path.join(root, 'node_modules')],
    metafile: true,
    outfile,
  });

  // 构建期守卫：CodeMirror 的 instanceof 检查要求 @codemirror/state（及 view/
  // language）在 bundle 内只有**一个**实例。依赖树里出现同一包的两个版本时，
  // 语言扩展会被判为 "Unrecognized extension value in extension set" ——
  // 这里直接让构建失败，避免把坏 bundle 发出去。
  const versions = new Map();
  for (const file of Object.keys(result.metafile.inputs)) {
    const m = file.match(/node_modules[\\/]\.pnpm[\\/](@(?:codemirror|lezer)[+][^\\/]+)/);
    if (!m) continue;
    const at = m[1].lastIndexOf('@');
    const name = m[1].slice(0, at).replace('+', '/');
    const ver = m[1].slice(at + 1);
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(ver);
  }
  const dupes = [...versions.entries()].filter(([, v]) => v.size > 1);
  if (dupes.length) {
    console.error('✗ bundle 内检测到同一 CodeMirror 包的多个版本（会破坏 instanceof 检查）：');
    for (const [name, v] of dupes) console.error(`   ${name}: ${[...v].join(', ')}`);
    console.error(
      '   修复：在根 package.json 的 pnpm.overrides 锁定该包版本后重新 pnpm install。',
    );
    process.exit(1);
  }

  const size = fs.statSync(outfile).size;
  console.log(
    `✅ editor bundle: ${path.relative(root, outfile)}  ${(size / 1024).toFixed(0)}KB  (${Date.now() - t0}ms)`,
  );
}

main().catch((e) => {
  console.error('editor bundle build failed:', e);
  process.exit(1);
});
