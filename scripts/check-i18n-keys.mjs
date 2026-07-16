// zh-CN 与 en-US key 集合双向 diff（test.* 为单测专用词条，允许不对称）
import { readFileSync } from 'node:fs';

const load = (p) => {
  const o = JSON.parse(readFileSync(p, 'utf8'));
  return new Set(Object.keys(o).filter((k) => k !== '_meta' && !k.startsWith('test.')));
};
const zh = load('packages/core/src/i18n/locales/zh-CN.json');
const en = load('packages/core/src/i18n/locales/en-US.json');
const onlyZh = [...zh].filter((k) => !en.has(k));
const onlyEn = [...en].filter((k) => !zh.has(k));
if (onlyZh.length || onlyEn.length) {
  if (onlyZh.length) console.error('❌ 仅存在于 zh-CN 的 key:', onlyZh);
  if (onlyEn.length) console.error('❌ 仅存在于 en-US 的 key:', onlyEn);
  process.exit(1);
}
console.log(`✅ i18n key parity OK (${zh.size} keys)`);
