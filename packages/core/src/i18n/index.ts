/**
 * Doc77 i18n — 轻量多语言模块（零第三方依赖）
 *
 * 回退链：当前语言 → en-US → key 本身。
 * 外部语言包：~/.doc77/locales/<lang>.json，与内置同码时外部覆盖内置同名 key。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

type Dict = Record<string, string>;
export interface LocaleInfo {
  code: string;
  name: string;
}

const FALLBACK = 'en-US';
const DEFAULT_EXTERNAL_DIR = path.join(os.homedir(), '.doc77', 'locales');

let dicts: Record<string, Dict> = {};
let locales: LocaleInfo[] = [];
let current = FALLBACK;

/** 从原始 JSON 对象拆出 _meta 与词条 */
function splitPack(raw: Record<string, unknown>): { meta: LocaleInfo | null; dict: Dict } {
  const dict: Dict = {};
  let meta: LocaleInfo | null = null;
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_meta' && v && typeof v === 'object') {
      const m = v as Record<string, unknown>;
      if (typeof m.code === 'string' && typeof m.name === 'string') {
        meta = { code: m.code, name: m.name };
      }
    } else if (typeof v === 'string') {
      dict[k] = v;
    }
  }
  return { meta, dict };
}

/**
 * 初始化：加载内置词条，扫描外部语言包目录并合并，然后按 resolveLocale 设定当前语言。
 * 可重复调用（幂等重建）。
 */
export function initI18n(lang?: string, opts?: { externalDir?: string }): void {
  dicts = {};
  locales = [];
  for (const raw of [enUS, zhCN] as Record<string, unknown>[]) {
    const { meta, dict } = splitPack(raw);
    if (meta) {
      dicts[meta.code] = dict;
      locales.push(meta);
    }
  }
  const dir = opts?.externalDir ?? DEFAULT_EXTERNAL_DIR;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<
          string,
          unknown
        >;
        const { meta, dict } = splitPack(raw);
        if (!meta) continue;
        if (dicts[meta.code]) {
          Object.assign(dicts[meta.code], dict); // 外部覆盖内置同名 key
        } else {
          dicts[meta.code] = dict;
          locales.push(meta);
        }
      } catch {
        // 忽略损坏的语言包文件
      }
    }
  } catch {
    // 目录不存在：正常，跳过
  }
  current = resolveLocale(lang ?? '');
}

/** 语言码归一化：zh* → zh-CN；命中已加载语言用之；否则 en-US */
function normalize(code: string): string {
  if (!code) return '';
  if (dicts[code]) return code;
  if (/^zh/i.test(code)) return dicts['zh-CN'] ? 'zh-CN' : FALLBACK;
  const base = code.split(/[-_]/)[0].toLowerCase();
  const hit = Object.keys(dicts).find((c) => c.toLowerCase().startsWith(base));
  return hit ?? '';
}

/** 解析优先级：explicit（非空）> hint > 系统 LANG/LC_ALL > en-US */
export function resolveLocale(explicit?: string, hint?: string): string {
  for (const cand of [explicit, hint, process.env.LC_ALL, process.env.LANG]) {
    if (!cand) continue;
    const n = normalize(cand.split('.')[0].replace('_', '-'));
    if (n) return n;
  }
  return FALLBACK;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const v = dicts[current]?.[key] ?? dicts[FALLBACK]?.[key] ?? key;
  if (!params) return v;
  return v.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

export function setLocale(lang: string): void {
  current = normalize(lang) || FALLBACK;
}

export function getLocale(): string {
  return current;
}

export function listLocales(): LocaleInfo[] {
  return locales.slice();
}

/** 返回某语言合并后的完整词条表（含 en 回退补齐），供 /api/i18n 下发 */
export function getDict(lang?: string): Dict {
  const code = lang ? normalize(lang) || FALLBACK : current;
  return { ...dicts[FALLBACK], ...dicts[code] };
}
