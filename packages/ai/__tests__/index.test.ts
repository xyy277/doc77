import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';

describe('@doc77/ai', () => {
  it('should export VERSION', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
