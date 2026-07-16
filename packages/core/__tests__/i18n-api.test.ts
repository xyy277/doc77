import { describe, it, expect } from 'vitest';
import { buildI18nResponse } from '../src/server/i18n-route.js';
import { initI18n } from '../src/i18n/index.js';

describe('buildI18nResponse', () => {
  it('explicit lang wins over global and hint', () => {
    initI18n('');
    const r = buildI18nResponse({ lang: 'zh-CN', hint: 'en-US', global: 'en-US' });
    expect(r.lang).toBe('zh-CN');
    expect(r.dict['test.hello']).toBe('你好');
    expect(r.global).toBe('en-US');
    expect(r.available.some((l) => l.code === 'en-US')).toBe(true);
  });

  it('falls back: no lang → global → hint', () => {
    initI18n('');
    expect(buildI18nResponse({ lang: '', hint: 'zh', global: '' }).lang).toBe('zh-CN');
    expect(buildI18nResponse({ lang: '', hint: '', global: 'en-US' }).lang).toBe('en-US');
  });

  it('etag is stable for same dict and changes across langs', () => {
    initI18n('');
    const a = buildI18nResponse({ lang: 'zh-CN', hint: '', global: '' });
    const b = buildI18nResponse({ lang: 'zh-CN', hint: '', global: '' });
    const c = buildI18nResponse({ lang: 'en-US', hint: '', global: '' });
    expect(a.etag).toBe(b.etag);
    expect(a.etag).not.toBe(c.etag);
  });
});
