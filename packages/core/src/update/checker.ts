/**
 * Doc77 version update checker.
 *
 * Calls the npm registry API to discover the latest published version,
 * compares it against the running VERSION, and returns an UpdateInfo
 * result.  All errors are swallowed — this module must never throw,
 * never block startup, and never surface to the user as a failure.
 *
 * Cached for 5 minutes so repeat calls (e.g. rapid page loads) do not
 * hammer the registry.
 */
import { VERSION } from '../version.gen.js';

export interface UpdateInfo {
  /** Running version (the VERSION constant baked into the build). */
  current: string;
  /** Latest version published to the npm registry. */
  latest: string;
  /** True when current is semantically older than latest. */
  hasUpdate: boolean;
  /** GitHub release page URL (derived from the version string). */
  htmlUrl: string;
}

// ── Lightweight semver comparison ───────────────────────────────────────

/**
 * Compare two bare semver strings (no `v` prefix, no build metadata).
 *
 * Returns -1 (a < b), 0 (a == b), or 1 (a > b).
 *
 * Pre-release tags (e.g. `1.0.0-beta`) are treated as *older* than the
 * same base version without a tag, which is the standard npm / semver
 * interpretation.
 */
export function semverCompare(a: string, b: string): -1 | 0 | 1 {
  const clean = (s: string) => s.split('-')[0];
  const aParts = clean(a).split('.').map(Number);
  const bParts = clean(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const aN = aParts[i] || 0;
    const bN = bParts[i] || 0;
    if (aN > bN) return 1;
    if (aN < bN) return -1;
  }
  // Base versions equal — check pre-release tags
  const aHasPre = a.includes('-');
  const bHasPre = b.includes('-');
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  return 0;
}

// ── Caching ─────────────────────────────────────────────────────────────

let cached: { data: UpdateInfo | null; expiresAt: number } | null = null;
const TTL = 5 * 60 * 1000; // 5 minutes
const TIMEOUT = 5000; // 5 second fetch timeout

export function clearUpdateCache(): void {
  cached = null;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Check the npm registry for a newer version of `idoc77`.
 *
 * The first call within a 5-minute window returns a cached result;
 * subsequent calls are free.  Returns `null` on any failure (network,
 * parse error, timeout) — consumers should degrade gracefully.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

    const res = await fetch('https://registry.npmjs.org/idoc77/latest', {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (!res.ok) {
      setCache(null);
      return null;
    }

    const body = (await res.json()) as { version?: string } | null;
    if (!body?.version) {
      setCache(null);
      return null;
    }

    const latest = body.version;
    const hasUpdate = semverCompare(VERSION, latest) < 0;

    const info: UpdateInfo = {
      current: VERSION,
      latest,
      hasUpdate,
      htmlUrl: `https://github.com/xyy277/doc77/releases/tag/v${latest}`,
    };
    setCache(info);
    return info;
  } catch {
    setCache(null);
    return null;
  }
}

function setCache(data: UpdateInfo | null): void {
  cached = { data, expiresAt: Date.now() + TTL };
}
