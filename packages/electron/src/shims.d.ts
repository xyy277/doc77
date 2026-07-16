/**
 * Type shims for @doc77/core (which does not publish .d.ts files).
 */
declare module '@doc77/core' {
  export function t(key: string, params?: Record<string, string | number>): string;
  export function initI18n(lang?: string, opts?: { externalDir?: string }): void;
  export function getConfig(key: string): string | undefined;
  export function setConfig(key: string, value: string): void;
  export function resolveLocale(explicit?: string, hint?: string): string;
}
