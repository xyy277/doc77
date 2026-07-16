/**
 * Minimal type shim for @doc77/core (core builds with tsup dts:false).
 * Mirrors packages/core/src/i18n/index.ts — delete once core emits .d.ts.
 */
declare module '@doc77/core' {
  export function t(key: string, params?: Record<string, string | number>): string;
}
