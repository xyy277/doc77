/**
 * Electron one-click module install — implementation behind POST /api/electron/install.
 *
 * Two install strategies:
 * - tarball: npm-free download+extract from the registry. Only viable for packages
 *   whose runtime deps are all @doc77-scoped (we install the closure ourselves).
 *   Used for `ai` (deps: @doc77/core only at runtime).
 * - npm: `npm install --prefix <modulesDir>` using the system npm. Required for
 *   packages with third-party/native dependency trees (`translate` →
 *   @huggingface/transformers, `mcp` → @modelcontextprotocol/sdk + zod).
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { t } from '../i18n/index.js';
import { VERSION } from '../version.gen.js';

const execAsync = promisify(exec);

/**
 * Where Electron-installed modules live. Must use os.homedir(): `process.env.HOME`
 * is unset on Windows, and the old `HOME || '/tmp'` fallback resolved to `D:\tmp`.
 */
export function modulesDir(): string {
  return path.join(os.homedir(), '.doc77', 'electron-modules');
}

export type InstallPlan =
  | { method: 'tarball'; packages: string[] }
  | { method: 'npm'; spec: string };

export function buildInstallPlan(mod: string): InstallPlan {
  if (mod === 'ai') return { method: 'tarball', packages: ['@doc77/ai', '@doc77/core'] };
  if (mod === 'mcp') return { method: 'npm', spec: '@doc77/mcp' };
  // No @doc77/translate package exists — the translation engine is transformers.js.
  return { method: 'npm', spec: '@huggingface/transformers@latest' };
}

export interface RegistryPackageInfo {
  version: string;
  dist: { tarball: string };
}

/**
 * Parse + validate a registry metadata response. The registry answers 404s with
 * `{"error":"Not Found"}` — reading `.dist.tarball` off that crashed with a
 * TypeError before; fail with a message that names the package instead.
 */
export function parsePackageInfo(raw: string, pkgName: string): RegistryPackageInfo {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* non-JSON response (proxy error page, network failure) */
  }
  const info = parsed as { version?: string; dist?: { tarball?: string }; error?: string } | null;
  if (!info?.version || !info.dist?.tarball) {
    throw new Error(
      t('api.electron.registryError', {
        pkg: pkgName,
        detail: info?.error || 'unexpected registry response',
      }),
    );
  }
  return info as RegistryPackageInfo;
}

/**
 * Move the extracted `package/` dir into node_modules/<scope>/<name>.
 * Creates the parent dirs first — renameSync into a non-existent
 * node_modules/@doc77/ threw ENOENT on fresh installs.
 */
export function moveExtracted(dest: string, pkgName: string): string {
  const src = path.join(dest, 'package');
  const target = path.join(dest, 'node_modules', ...pkgName.split('/'));
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(src, target);
  return target;
}

/**
 * Resolve a package's importable entry file from its package.json
 * (exports["."].import → module → main → index.js). Returns null when the
 * package or entry is missing. Used to import modules that live outside the
 * app bundle (Electron cannot resolve them as bare specifiers).
 */
export function resolveModuleEntry(pkgDir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
    let entry: unknown = pkg.exports?.['.'] ?? pkg.exports;
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      entry = e.import ?? e.node ?? e.default;
      if (entry && typeof entry === 'object') {
        entry = (entry as Record<string, unknown>).default;
      }
    }
    const rel = (typeof entry === 'string' ? entry : null) ?? pkg.module ?? pkg.main ?? 'index.js';
    const abs = path.join(pkgDir, rel);
    return fs.existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

export function isNpmAvailable(): boolean {
  try {
    execSync('npm --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch registry metadata for a package. Prefers the version matching the
 * running app (avoids a beta app pulling `latest` modules with a different
 * API), falling back to `latest` when the exact version was never published.
 */
async function fetchPackageInfo(pkgName: string): Promise<RegistryPackageInfo> {
  const get = async (ref: string) =>
    (await execAsync(`curl -s https://registry.npmjs.org/${pkgName}/${ref}`)).stdout;
  try {
    return parsePackageInfo(await get(VERSION), pkgName);
  } catch {
    return parsePackageInfo(await get('latest'), pkgName);
  }
}

async function installViaTarball(dest: string, packages: string[]): Promise<string> {
  let mainVersion = '';
  for (const pkgName of packages) {
    const info = await fetchPackageInfo(pkgName);
    if (!mainVersion) mainVersion = info.version;
    const tgz = path.join(dest, `${pkgName.replace(/[@/]/g, '_')}.tgz`);
    await execAsync(`curl -sL "${info.dist.tarball}" -o "${tgz}"`);
    await execAsync(`tar -xzf "${tgz}" -C "${dest}"`);
    moveExtracted(dest, pkgName);
    fs.unlinkSync(tgz);
  }
  return mainVersion;
}

async function installViaNpm(dest: string, spec: string): Promise<string> {
  if (!isNpmAvailable()) {
    throw new Error(t('api.electron.npmRequired', { pkg: spec }));
  }
  let fullSpec = spec;
  if (!spec.includes('@', 1)) {
    // Unpinned @doc77 package — resolve to the version matching the running app.
    const info = await fetchPackageInfo(spec);
    fullSpec = `${spec}@${info.version}`;
  }
  await execAsync(`npm install --prefix "${dest}" ${fullSpec} --no-audit --no-fund --loglevel=error`, {
    cwd: dest,
    maxBuffer: 16 * 1024 * 1024,
  });
  const pkgName = fullSpec.slice(0, fullSpec.lastIndexOf('@'));
  try {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(dest, 'node_modules', ...pkgName.split('/'), 'package.json'),
        'utf-8',
      ),
    );
    return pkg.version || '';
  } catch {
    return '';
  }
}

/** Install one module (`ai` | `mcp` | `translate`) into modulesDir(). */
export async function installElectronModule(mod: string): Promise<{ message: string }> {
  const plan = buildInstallPlan(mod);
  const dest = modulesDir();
  fs.mkdirSync(dest, { recursive: true });
  let version: string;
  let display: string;
  if (plan.method === 'tarball') {
    version = await installViaTarball(dest, plan.packages);
    display = plan.packages[0];
  } else {
    version = await installViaNpm(dest, plan.spec);
    display = plan.spec.includes('@', 1) ? plan.spec.slice(0, plan.spec.lastIndexOf('@')) : plan.spec;
  }
  return { message: t('api.electron.installDone', { mod: display, version }) };
}
