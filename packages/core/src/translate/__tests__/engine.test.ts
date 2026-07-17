import { describe, it, expect, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  env: {
    cacheDir: '',
    allowLocalModels: false,
    allowRemoteModels: false,
    remoteHost: 'https://huggingface.co/',
  },
  pipeline: vi.fn(),
}));

import { isEngineAvailable, isModelReady, detectLang, translate } from '../engine.js';

describe('isEngineAvailable', () => {
  it('returns true when @huggingface/transformers is importable', async () => {
    expect(await isEngineAvailable()).toBe(true);
  });
});

describe('isModelReady', () => {
  it('returns false for unknown model pair', async () => {
    expect(await isModelReady('xx-yy')).toBe(false);
  });
});

describe('detectLang', () => {
  it('detects Chinese text', () => {
    expect(detectLang('文档')).toBe('zh');
    expect(detectLang('这是一段中文说明，包含 API 等英文术语')).toBe('zh');
  });

  it('detects English text', () => {
    expect(detectLang('Hello world')).toBe('en');
    expect(detectLang('A README with one 词 inside a long English sentence')).toBe('en');
  });

  it('defaults to en for empty/whitespace input', () => {
    expect(detectLang('   ')).toBe('en');
  });
});

describe('translate auto-detection', () => {
  it('returns text unchanged when detected source equals target (zh→zh no-op)', async () => {
    // Regression: '文档' with source auto + target zh used to run the en→zh
    // Marian model and produce degenerate repeated tokens.
    const r = await translate('文档', 'auto', 'zh');
    expect(r.translated_text).toBe('文档');
    expect(r.source_lang).toBe('zh');
    expect(r.model).toBe('noop');
  });

  it('returns text unchanged for explicit same-language request', async () => {
    const r = await translate('Hello', 'en', 'en');
    expect(r.translated_text).toBe('Hello');
    expect(r.model).toBe('noop');
  });
});
