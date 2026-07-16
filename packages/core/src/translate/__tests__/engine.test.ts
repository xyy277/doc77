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

import { isEngineAvailable, isModelReady } from '../engine.js';

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
