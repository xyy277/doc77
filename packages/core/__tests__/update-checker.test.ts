import { describe, it, expect } from 'vitest';
import { semverCompare, clearUpdateCache } from '../src/update/checker.js';

describe('semverCompare', () => {
  it('equal versions → 0', () => {
    expect(semverCompare('1.0.0', '1.0.0')).toBe(0);
    expect(semverCompare('0.0.0', '0.0.0')).toBe(0);
  });

  it('patch ascending → -1', () => {
    expect(semverCompare('1.0.0', '1.0.1')).toBe(-1);
  });

  it('minor ascending → -1', () => {
    expect(semverCompare('1.0.9', '1.1.0')).toBe(-1);
  });

  it('major ascending → -1', () => {
    expect(semverCompare('1.9.9', '2.0.0')).toBe(-1);
  });

  it('pre-release < release', () => {
    expect(semverCompare('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(semverCompare('1.0.0-beta.2', '1.0.0')).toBe(-1);
  });

  it('release > pre-release', () => {
    expect(semverCompare('1.0.0', '1.0.0-beta')).toBe(1);
  });

  it('equal pre-releases → 0', () => {
    expect(semverCompare('1.0.0-beta.1', '1.0.0-beta.1')).toBe(0);
  });
});

describe('clearUpdateCache', () => {
  it('does not throw', () => {
    expect(() => clearUpdateCache()).not.toThrow();
  });
});
