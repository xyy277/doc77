import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initI18n, t, setLocale, getLocale, listLocales, resolveLocale, getDict,
} from '../src/i18n/index.js';

describe('i18n', () => {
  beforeEach(() => {
    initI18n('zh-CN', { externalDir: path.join(os.tmpdir(), 'doc77-no-such-dir') });
  });

  it('returns zh value when locale is zh-CN', () => {
    expect(t('test.hello')).toBe('你好');
  });

  it('falls back to en-US when key missing in current locale', () => {
    expect(t('test.enOnly')).toBe('English only');
  });

  it('falls back to key itself when missing everywhere', () => {
    expect(t('no.such.key')).toBe('no.such.key');
  });

  it('interpolates {name} params', () => {
    expect(t('test.sized', { maxSizeMB: 2 })).toBe('上限 2MB');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(t('test.sized')).toBe('上限 {maxSizeMB}MB');
  });

  it('setLocale/getLocale round-trip', () => {
    setLocale('en-US');
    expect(getLocale()).toBe('en-US');
    expect(t('test.hello')).toBe('Hello');
  });

  it('resolveLocale: explicit > hint > env > en-US, zh* normalizes to zh-CN', () => {
    const oldLang = process.env.LANG;
    const oldLc = process.env.LC_ALL;
    process.env.LANG = 'en_US.UTF-8';
    delete process.env.LC_ALL;
    try {
      expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
      expect(resolveLocale('', 'zh')).toBe('zh-CN');
      expect(resolveLocale('', 'zh-TW')).toBe('zh-CN');
      expect(resolveLocale('', 'fr-FR')).toBe('en-US'); // 未安装的语言落到 env → en-US
      process.env.LANG = 'zh_CN.UTF-8';
      expect(resolveLocale('', '')).toBe('zh-CN'); // env 检测
    } finally {
      process.env.LANG = oldLang;
      if (oldLc !== undefined) process.env.LC_ALL = oldLc;
    }
  });

  it('merges external pack: same-code overrides builtin, new code registers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-loc-'));
    fs.writeFileSync(path.join(dir, 'zh-CN.json'),
      JSON.stringify({ _meta: { code: 'zh-CN', name: '简体中文' }, 'test.hello': '您好' }));
    fs.writeFileSync(path.join(dir, 'ja-JP.json'),
      JSON.stringify({ _meta: { code: 'ja-JP', name: '日本語' }, 'test.hello': 'こんにちは' }));
    initI18n('zh-CN', { externalDir: dir });
    expect(t('test.hello')).toBe('您好'); // 外部覆盖内置
    setLocale('ja-JP');
    expect(t('test.hello')).toBe('こんにちは');
    expect(t('test.enOnly')).toBe('English only'); // 外部语言缺 key 回退 en
    expect(listLocales().map((l) => l.code)).toContain('ja-JP');
  });

  it('getDict returns merged flat dict without _meta', () => {
    const d = getDict('zh-CN');
    expect(d['test.hello']).toBe('你好');
    expect(d['_meta']).toBeUndefined();
  });

  it('ignores malformed external json without crashing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc77-loc-'));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    expect(() => initI18n('zh-CN', { externalDir: dir })).not.toThrow();
  });
});
