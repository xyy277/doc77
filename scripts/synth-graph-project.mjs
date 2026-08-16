#!/usr/bin/env node
/**
 * 5000 节点合成图谱项目生成器（独立验证 Phase 5 — 用户环境端到端性能验证）。
 *
 * 用法：
 *   node scripts/synth-graph-project.mjs [dir] [n=5000]
 *   node scripts/synth-graph-project.mjs [dir] [n] --register <baseUrl>   # 顺带注册项目
 *
 * 生成内容（链环 wikilink，~2n 条 resolved 边）+ 缺陷注入：
 *   - 每 500 个文件加一条断链 [[missing-target-N]]（n/500 条）
 *   - doc4999.md 无任何链接（1 个孤儿）
 *   - doc0001.md 3 条出链（入链尖峰 → 更大节点半径）
 *
 * 输出预期统计：nodes=n / edges≈2n / broken≈n/500 / orphans=1。
 * 注册后等待启动 bootstrap 或手动触发重建索引（图谱页按钮）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const dir = process.argv[2] || path.join(os.homedir(), 'doc77-graph-perf-5000');
const n = parseInt(process.argv[3] || '5000', 10) || 5000;
const regIdx = process.argv.indexOf('--register');
const baseUrl = regIdx >= 0 ? process.argv[regIdx + 1] : null;

fs.mkdirSync(dir, { recursive: true });
let broken = 0;

for (let i = 0; i < n; i++) {
  const next = i + 1 < n ? `doc${String(i + 1).padStart(4, '0')}` : `doc0000`;
  const prev = i > 0 ? `doc${String(i - 1).padStart(4, '0')}` : `doc${String(n - 1).padStart(4, '0')}`;
  let links = `参见 [[${next}]] 和 [[${prev}]]`;
  if (i % 500 === 0) {
    links += ` 以及 [[missing-target-${i}]]`;
    broken++;
  }
  if (i === 1) links += ` 以及 [[doc0500]]`; // 高入链节点（半径尖峰）
  const content = `# Doc ${i}\n\n${links}\n\n合成性能验证文档第 ${i} 号。`;
  fs.writeFileSync(path.join(dir, `doc${String(i).padStart(4, '0')}.md`), content);
}

// doc4999 保持无链接（孤儿）
fs.writeFileSync(
  path.join(dir, `doc${String(n - 1).padStart(4, '0')}.md`),
  `# Doc ${n - 1}\n\n无任何链接的孤立页。`,
);

const orphans = 1; // 链环结构下仅 doc4999 无链接
console.log(`✅ 生成完成: ${dir}`);
console.log(`   文件数: ${n}`);
console.log(`   预期节点: ${n}（全部为 markdown 且被索引）`);
console.log(`   预期边: ~${2 * n - 1} 条 resolved（链环 ${n} 条 + 回链 ${n - 1} 条）`);
console.log(`   预期断链: ${broken} 条（missing-target-*）`);
console.log(`   预期孤儿: ${orphans} 个（doc${String(n - 1).padStart(4, '0')}）`);
console.log(`   高入链节点: doc0001（3 条出链）`);

if (baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'GraphPerf5000', path: dir }),
    });
    const d = await res.json();
    console.log(res.ok ? `✅ 已注册项目 id=${d.id}（等待启动 bootstrap 或手动重建索引）` : `⚠️ 注册失败: ${d.error || res.status}`);
  } catch (e) {
    console.error(`⚠️ 注册失败（网络错误）: ${e instanceof Error ? e.message : e}`);
    console.log('   手动注册：设置页 → 项目 → 添加路径 → ' + dir);
  }
} else {
  console.log('\n注册方式（二选一）：');
  console.log('  1. 设置页 → 项目 → 添加路径 → ' + dir);
  console.log('  2. 或重跑本脚本加 --register <baseUrl>');
}
