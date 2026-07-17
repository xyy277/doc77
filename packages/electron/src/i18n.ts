/**
 * Doc77 Electron — main-process t() shim.
 *
 * The main process is compiled to CommonJS (tsconfig.main.json), but
 * @doc77/core's require entry (dist/index.cjs) pulls in ESM-only deps
 * (e.g. marked), which Electron's bundled Node cannot require() —
 * a static `import { t } from '@doc77/core'` here crashes the packaged
 * app at startup with ERR_REQUIRE_ESM. Core may therefore ONLY be loaded
 * via dynamic import (see server.ts loadCore).
 *
 * This shim delegates to core's t once the server has loaded it; before
 * that it returns the key itself (tray/dialog are created after
 * startServer resolves, so real translations are always available there).
 */

export type TFn = (key: string, params?: Record<string, string | number>) => string;

let coreT: TFn | null = null;

/** Called by server.ts once @doc77/core has been dynamically imported. */
export function bindCoreT(fn: TFn): void {
  coreT = fn;
}

export function t(key: string, params?: Record<string, string | number>): string {
  return coreT ? coreT(key, params) : key;
}
