import * as crypto from 'node:crypto';

export interface ShareToken {
  token: string;
  projectId: number;
  filePath: string;
  documentTitle: string;
  theme: 'light' | 'dark';
  createdAt: number;
  expiresAt: number;
}

export interface CreateShareOptions {
  projectId: number;
  filePath: string;
  title: string;
  theme: 'light' | 'dark';
  /** TTL in milliseconds (defaults to 24 hours) */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

export class ShareManager {
  private tokens = new Map<string, ShareToken>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanup();
  }

  /** Create a new share token */
  create(options: CreateShareOptions): ShareToken {
    const token: ShareToken = {
      token: crypto.randomUUID(),
      projectId: options.projectId,
      filePath: options.filePath,
      documentTitle: options.title,
      theme: options.theme || 'light',
      createdAt: Date.now(),
      expiresAt: Date.now() + (options.ttlMs || DEFAULT_TTL_MS),
    };
    this.tokens.set(token.token, token);
    return token;
  }

  /** Validate a token — returns null if invalid or expired */
  validate(token: string): ShareToken | null {
    const t = this.tokens.get(token);
    if (!t) return null;
    if (Date.now() > t.expiresAt) {
      this.tokens.delete(token);
      return null;
    }
    return t;
  }

  /** Revoke a share by token string. Returns true if existed. */
  revoke(token: string): boolean {
    return this.tokens.delete(token);
  }

  /** List all active (non-expired) share tokens */
  list(): ShareToken[] {
    this.removeExpired();
    return Array.from(this.tokens.values());
  }

  /** Remove all tokens for a given project (e.g. when project is deleted) */
  cleanup(projectId: number): void {
    for (const [token, t] of this.tokens) {
      if (t.projectId === projectId) this.tokens.delete(token);
    }
  }

  /** Destroy the manager and stop cleanup timer */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.tokens.clear();
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [token, t] of this.tokens) {
      if (now > t.expiresAt) this.tokens.delete(token);
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.removeExpired(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }
}
