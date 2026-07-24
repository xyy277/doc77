/**
 * Doc77 Electron — Server lifecycle manager
 * Starts the core Express app in-process so Electron stays a thin desktop shell.
 */
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as http from 'http';
import { pathToFileURL } from 'url';
import { bindCoreT, TFn } from './i18n';

const DB_PATH = path.join(os.homedir(), '.doc77', 'data.db');

interface CoreModule {
  closeConnection: () => void;
  createApp: (
    restartCallback?: () => void,
    bindAddr?: string,
    port?: number,
  ) => http.RequestListener;
  initDatabase: (filePath: string) => Promise<unknown>;
  loadDefaults: () => void;
  runMigrations: () => void;
  t: TFn;
  // Optional-module wiring (one-click installs from the settings page)
  modulesDir: () => string;
  resolveModuleEntry: (pkgDir: string) => string | null;
  createAIChatHandler: (deps: Record<string, unknown>) => unknown;
  createQueueApproveHandler: (executeApprovedTasks: unknown) => unknown;
  createEventsHandler: (eventBus: unknown) => unknown;
  setCapabilities: (caps: { ai: boolean; mcp: boolean; translate: boolean; gallery: boolean }) => void;
  isEngineAvailable: () => Promise<boolean>;
  getConfig: (key: string) => string | undefined;
}

/** Minimal express-app surface we need for post-createApp route registration. */
interface ExpressLike {
  post: (route: string, handler: unknown) => void;
  get: (route: string, handler: unknown) => void;
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<any>;

async function loadCore(): Promise<CoreModule> {
  return dynamicImport('@doc77/core');
}

/**
 * Import a module installed by the one-click installer. Those packages live
 * under ~/.doc77/electron-modules — outside the app bundle — so bare
 * specifiers cannot resolve them; import their entry file by absolute URL.
 */
async function loadInstalledModule(core: CoreModule, pkgName: string): Promise<any | null> {
  try {
    const pkgDir = path.join(core.modulesDir(), 'node_modules', ...pkgName.split('/'));
    const entry = core.resolveModuleEntry(pkgDir);
    if (!entry) return null;
    return await dynamicImport(pathToFileURL(entry).href);
  } catch {
    return null;
  }
}

/**
 * Mirror of the CLI's optional-module registration (cli/src/bin/doc77.ts):
 * register MCP/AI routes for installed modules and publish capabilities so
 * the settings page stops offering the install button after a restart.
 */
async function registerInstalledModules(core: CoreModule, app: ExpressLike): Promise<void> {
  const mcp = await loadInstalledModule(core, '@doc77/mcp');
  const ai = await loadInstalledModule(core, '@doc77/ai');

  // @doc77/ai pulls `t` from its own sibling copy of @doc77/core — give that
  // copy its locale dictionaries (best-effort; falls back to en-US keys).
  if (ai) {
    const siblingCore = await loadInstalledModule(core, '@doc77/core');
    try {
      siblingCore?.initI18n?.('');
    } catch {
      /* non-fatal */
    }
  }

  if (mcp) {
    try {
      app.post('/api/queue/approve', core.createQueueApproveHandler(mcp.executeApprovedTasks));
      app.get('/api/events', core.createEventsHandler(mcp.getEventBus()));
    } catch {
      /* keep booting without MCP routes */
    }
  }

  if (ai) {
    try {
      const aiDeps: Record<string, unknown> = {
        AiProvider: ai.AiProvider,
        DocAgent: ai.DocAgent,
        getReadTools: ai.getReadTools,
      };
      // When MCP is installed, let the AI propose writes through the approval
      // queue by injecting its write functions + tool schemas.
      if (mcp) {
        aiDeps.getWriteTools = ai.getWriteTools;
        aiDeps.writeFns = {
          createFolder: mcp.createFolder,
          moveFile: mcp.moveFile,
          deleteFile: mcp.deleteFile,
          batchOperations: mcp.batchOperations,
        };
      }
      app.post('/api/ai/chat', core.createAIChatHandler(aiDeps));
    } catch {
      /* keep booting without AI routes */
    }
  }

  let translate = false;
  try {
    translate = await core.isEngineAvailable();
  } catch {
    /* engine probe failed — report unavailable */
  }

  // Gallery — first-party feature loaded from workspace, not a one-click module.
  let galleryAvailable = false;
  try {
    const gallery = await dynamicImport('@doc77/gallery');
    if (gallery?.registerGalleryRoutes) {
      const thumbnailsDir = path.join(os.homedir(), '.doc77', 'thumbnails');
      await gallery.registerGalleryRoutes(app, { thumbnailsDir });
      galleryAvailable = true;
    }
  } catch {
    /* gallery not built or unavailable */
  }

  core.setCapabilities({ ai: !!ai, mcp: !!mcp, translate, gallery: galleryAvailable });
}

/** Find an available port starting from `start`, up to `start + 99`. */
export function findAvailablePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    function tryPort(port: number) {
      if (port >= start + 100) return reject(new Error('No available port in range'));
      const server = net.createServer();
      server.listen(port, '127.0.0.1');
      server.on('listening', () => {
        server.close();
        resolve(port);
      });
      server.on('error', () => tryPort(port + 1));
    }
    tryPort(start);
  });
}

export interface ServerProcess {
  server: http.Server;
  port: number;
  kill: () => void;
}

export async function startServer(port: number, uiLocale?: string): Promise<ServerProcess> {
  process.env.DOC77_ELECTRON = '1';
  // core's i18n auto-detection reads LANG/LC_ALL — absent on Windows. Inject
  // the Chromium-reported OS locale (e.g. "zh-CN") so backend messages
  // (install toasts, API errors) match the user's language. An explicit
  // locale.language config still takes precedence inside initI18n.
  if (uiLocale && !process.env.LANG && !process.env.LC_ALL) {
    process.env.LANG = uiLocale.replace('-', '_') + '.UTF-8';
  }
  // Local dev fallback: use ~/.doc77/vendor/ (process.resourcesPath points
  // to Electron binary dir in dev, not our project). In production packaging,
  // extraResources puts vendor at resources/vendor/ which is correct.
  if (!process.env.DOC77_VENDOR_DIR) {
    process.env.DOC77_VENDOR_DIR = path.join(os.homedir(), '.doc77', 'vendor');
  }
  // One-click-installed modules live outside the app bundle; core's translate
  // engine falls back to this directory when its bare import fails.
  if (!process.env.DOC77_MODULES_DIR) {
    process.env.DOC77_MODULES_DIR = path.join(os.homedir(), '.doc77', 'electron-modules');
  }

  const core = await loadCore();
  const { closeConnection, createApp, getConfig, initDatabase, loadDefaults, runMigrations } = core;
  // Make core's t() available to tray/dialog (see ./i18n shim).
  bindCoreT(core.t);

  await initDatabase(DB_PATH);
  runMigrations();
  loadDefaults();

  // Port policy: loadDefaults() seeds server.port with the CLI default
  // (27777), so its mere presence does NOT mean the user chose it — honouring
  // it blindly made the desktop app fight a running CLI instance for 27777
  // (listen → EADDRINUSE → boot rejected → windowless zombie process).
  // Only an explicit non-CLI-default override wins, and only if it is
  // actually free; otherwise keep the probed desktop port (28888+).
  const CLI_DEFAULT_PORT = 27777;
  const cfgPortNum = parseInt(getConfig('server.port') || '', 10);
  let effectivePort = port;
  if (Number.isFinite(cfgPortNum) && cfgPortNum > 0 && cfgPortNum !== CLI_DEFAULT_PORT) {
    effectivePort = await isPortFree(cfgPortNum).then((free) => (free ? cfgPortNum : port));
  }

  // Read the persisted bind address — only allow 0.0.0.0 to open LAN access.
  const dbBind = getConfig('security.bind_address') || '127.0.0.1';
  const effectiveBind = dbBind === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';

  const app = createApp(undefined, effectiveBind, effectivePort);
  await registerInstalledModules(core, app as unknown as ExpressLike);
  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(effectivePort, effectiveBind, () => {
      server.off('error', reject);
      resolve({
        server,
        port: effectivePort,
        kill: () => {
          server.close();
          closeConnection();
        },
      });
    });
  });
}

/** True if `port` can be bound on localhost right now. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}
