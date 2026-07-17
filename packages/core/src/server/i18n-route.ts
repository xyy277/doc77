/**
 * /api/i18n 路由的纯逻辑 —— 语言解析 + 词条表 + ETag。
 */
import { createHash } from 'node:crypto';
import { resolveLocale, getDict, listLocales, type LocaleInfo } from '../i18n/index.js';

export interface I18nResponse {
  lang: string;
  dict: Record<string, string>;
  available: LocaleInfo[];
  global: string;
  etag: string;
}

export function buildI18nResponse(q: { lang: string; hint: string; global: string }): I18nResponse {
  const lang = resolveLocale(q.lang || q.global, q.hint);
  const dict = getDict(lang);
  const etag =
    '"' +
    createHash('sha1')
      .update(lang + JSON.stringify(dict))
      .digest('hex') +
    '"';
  return { lang, dict, available: listLocales(), global: q.global, etag };
}
