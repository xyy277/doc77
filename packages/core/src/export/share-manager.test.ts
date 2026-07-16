import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShareManager } from './share-manager.js';

describe('ShareManager', () => {
  let sm: ShareManager;

  beforeEach(() => {
    sm = new ShareManager();
  });

  afterEach(() => {
    sm.destroy();
  });

  it('should create a share token with given options', () => {
    const t = sm.create({ projectId: 1, filePath: '/test/doc.md', title: 'doc', theme: 'light' });
    expect(t.token).toBeTruthy();
    expect(t.token.length).toBe(36); // UUID v4
    expect(t.projectId).toBe(1);
    expect(t.filePath).toBe('/test/doc.md');
    expect(t.documentTitle).toBe('doc');
    expect(t.expiresAt).toBeGreaterThan(t.createdAt);
  });

  it('should validate a valid token', () => {
    const t = sm.create({ projectId: 1, filePath: '/a.md', title: 'a', theme: 'light' });
    const validated = sm.validate(t.token);
    expect(validated).not.toBeNull();
    expect(validated!.token).toBe(t.token);
  });

  it('should return null for invalid token', () => {
    expect(sm.validate('nonexistent')).toBeNull();
  });

  it('should return null for expired token', async () => {
    const t = sm.create({ projectId: 1, filePath: '/a.md', title: 'a', theme: 'light', ttlMs: 1 });
    await new Promise(r => setTimeout(r, 10)); // wait for expiry
    expect(sm.validate(t.token)).toBeNull();
  });

  it('should revoke a token', () => {
    const t = sm.create({ projectId: 1, filePath: '/a.md', title: 'a', theme: 'light' });
    expect(sm.revoke(t.token)).toBe(true);
    expect(sm.validate(t.token)).toBeNull();
  });

  it('should list active tokens only', () => {
    sm.create({ projectId: 1, filePath: '/a.md', title: 'a', theme: 'light' });
    sm.create({ projectId: 1, filePath: '/b.md', title: 'b', theme: 'dark' });
    expect(sm.list().length).toBe(2);
  });

  it('should cleanup tokens for a given project', () => {
    sm.create({ projectId: 1, filePath: '/a.md', title: 'a', theme: 'light' });
    sm.create({ projectId: 2, filePath: '/b.md', title: 'b', theme: 'light' });
    sm.cleanup(1);
    expect(sm.list().length).toBe(1);
    expect(sm.list()[0].projectId).toBe(2);
  });

  it('should return false when revoking non-existent token', () => {
    expect(sm.revoke('nonexistent')).toBe(false);
  });
});
