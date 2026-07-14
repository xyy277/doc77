import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/server/rate-limit.js';

describe('createRateLimiter', () => {
  it('allows up to the limit within the window, then rejects', () => {
    const rl = createRateLimiter();
    const window = 60_000;
    expect(rl.check('s1', 2, window, 1000).allowed).toBe(true);
    expect(rl.check('s1', 2, window, 1500).allowed).toBe(true);
    const third = rl.check('s1', 2, window, 1800);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it('recovers after the window slides past old hits', () => {
    const rl = createRateLimiter();
    const window = 60_000;
    rl.check('s2', 1, window, 1000);
    expect(rl.check('s2', 1, window, 2000).allowed).toBe(false);
    // 61s later, the first hit has aged out of the window
    expect(rl.check('s2', 1, window, 62_000).allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    const rl = createRateLimiter();
    rl.check('a', 1, 1000, 0);
    expect(rl.check('a', 1, 1000, 100).allowed).toBe(false);
    expect(rl.check('b', 1, 1000, 100).allowed).toBe(true);
  });
});
