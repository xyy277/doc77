/**
 * Doc77 Electron — Server lifecycle manager
 * Starts the core Express app in-process so Electron stays a thin desktop shell.
 */
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as http from 'http';
import { pathToFileURL } from 'url';
import type { DatabaseCompat } from '@doc77/core';
import { bindCoreT, TFn } from './i18n';

/** 事件总线最小契约 —— 与 core/events-handler MinimalBus 同构。 */
export interface EventBus {
  on(event: string, listener: (payload: unknown) => void): void;
  off(event: string, listener: (payload: unknown) => void): void;
}

/** 当前已安装模块的事件总线（若有）；由 registerInstalledModules 缓存。 */
let installedEventBus: EventBus | null = null;

/** 取已安装 mcp 的事件总线，未安装时返回 null。供 notifications 模块订阅。 */
export function getInstalledEventBus(): EventBus | null {
  return installedEventBus;
}

/**
 * stopTunnel — 退出前尝试停止 core 的隧道管理器。
 *
 * 必须用 dynamic import：electron 不能静态 require @doc77/core（ESM-only
 * 依赖会让打包后的 app 启动崩溃，见 verify-no-static-core.cjs）。
 * 若 core 不可用或 getTunnelManager 不存在，安静跳过（T3 由另一 agent
 * 实施，这里只负责尽力调用 stop）。
 */
export async function stopTunnel(): Promise<void> {
  try {
    const core = await loadCore();
    const mgr = (
      core as unknown as { getTunnelManager?: () => { stop: () => Promise<void> } }
    ).getTunnelManager?.();
    await mgr?.stop?.();
  } catch {
    // 隧道管理器不可用 / 未加载 —— 退出路径不可阻塞，安静跳过
  }
}

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
  setCapabilities: (caps: {
    ai: boolean;
    mcp: boolean;
    translate: boolean;
    gallery: boolean;
  }) => void;
  startFileWatcher: (opts?: { debounceMs?: number }) => void;
  isEngineAvailable: () => Promise<boolean>;
  getConfig: (key: string) => string | undefined;
  getConnection: () => DatabaseCompat;
  pruneAiSessions: (ttlHours?: number) => number;
  registerAiRagRoutes: (app: ExpressLike, deps: { engine: unknown; db: DatabaseCompat }) => void;
  registerPluginRoutes: (app: ExpressLike, deps: { db: DatabaseCompat; pluginDir: string }) => void;
}

/** Minimal express-app surface we need for post-createApp route registration. */
interface ExpressLike {
  get: (route: string, handler: any) => void;
  post: (route: string, handler: any) => void;
  put: (route: string, handler: any) => void;
  delete: (route: string, handler: any) => void;
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
 * 非 Electron 依赖的「路由挂载」纯函数 —— 镜像 cli/src/bin/doc77.ts:305-414，
 * 把 sync / RAG / plugins / gallery 四组路由挂到 express app 上。
 *
 * 设计：模块对象由调用方 dynamic import 后注入（本函数自身不做任何 import），
 * 因此可被 vitest 直接加载、用真实模块跑通挂载逻辑（而非复刻品）。
 */
export interface HttpRoutesDeps {
  getConnection: () => DatabaseCompat;
  getConfig: (key: string) => string | undefined;
  thumbnailsDir: string;
  pluginDir: string;
  /**
   * @doc77/sync 已加载则传，缺失 = 不挂载 sync 路由。
   * 模块函数用 any 签名：调用方 dynamic import 得到的就是 any，测试方注入的
   * 是具体实现 —— any 对两侧都兼容（详见 registerInstalledModules / 接线测试）。
   */
  sync?: {
    createSyncEngine: () => unknown;
    createSyncScheduler: (deps: any) => unknown;
    registerSyncRoutes: (app: any, deps: any) => void;
  };
  /** @doc77/ai 已加载（提供 RagEngine）则传，缺失 = 不挂载 RAG 路由 */
  rag?: {
    RagEngine: new (deps: any) => unknown;
    registerAiRagRoutes: (app: any, deps: any) => void;
    /** 测试注入用：自定义嵌入函数；生产不传，走真实 embedder */
    embedFn?: (texts: string[]) => Promise<number[][]>;
  };
  /** @doc77/core 的 registerPluginRoutes 存在则传 */
  plugins?: {
    registerPluginRoutes: (app: any, deps: any) => void;
  };
  /** @doc77/gallery 已加载则传 */
  gallery?: {
    registerGalleryRoutes: (app: any, deps: any) => Promise<unknown>;
  };
}

export async function registerHttpRoutes(app: ExpressLike, deps: HttpRoutesDeps): Promise<void> {
  // T8: sync routes（sync engine + scheduler）
  if (deps.sync) {
    try {
      const db = deps.getConnection();
      const engine = deps.sync.createSyncEngine();
      const getProjectPath = (pid: number): string | null => {
        const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(pid) as
          { path: string } | undefined;
        return row?.path || null;
      };
      const scheduler = deps.sync.createSyncScheduler({ engine, db, getProjectPath });
      deps.sync.registerSyncRoutes(app, { engine, scheduler, db, getProjectPath });
    } catch {
      /* @doc77/sync 不可用 —— 静默跳过 */
    }
  }

  // T10: RAG routes（索引/查询/清除）
  if (deps.rag) {
    try {
      const db = deps.getConnection();
      const provider = (deps.getConfig('ai.provider') as 'custom' | 'ollama') || 'custom';
      const embedModel = deps.getConfig('ai.embed_model') || 'nomic-embed-text';
      const ollamaUrl = deps.getConfig('ai.ollama_url') as string | undefined;
      const ragEngine = new deps.rag.RagEngine({
        db,
        config: { embedder: { provider, embedModel, ollamaUrl } },
        ...(deps.rag.embedFn ? { embedFn: deps.rag.embedFn } : {}),
      });
      deps.rag.registerAiRagRoutes(app, { engine: ragEngine, db });
    } catch {
      /* RAG 不可用 —— 需要 @doc77/ai */
    }
  }

  // T11: plugin routes（安装/卸载/配置）
  if (deps.plugins) {
    try {
      deps.plugins.registerPluginRoutes(app, {
        db: deps.getConnection(),
        pluginDir: deps.pluginDir,
      });
    } catch {
      /* Plugin routes 不可用 */
    }
  }

  // Gallery —— 与 cli 一致，best-effort 挂载
  if (deps.gallery) {
    try {
      await deps.gallery.registerGalleryRoutes(app, { thumbnailsDir: deps.thumbnailsDir });
    } catch {
      /* Gallery init failed */
    }
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
      const bus = mcp.getEventBus();
      app.post('/api/queue/approve', core.createQueueApproveHandler(mcp.executeApprovedTasks));
      // SSE 通道（/api/events）已由 core 的 createApp 无条件注册；mcp 的
      // getEventBus 现为 core globalThis 单例的 re-export，同一实例
      installedEventBus = bus as EventBus;
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

  // ── First-party feature routes: sync / RAG / plugins / gallery ──
  // 镜像 cli/src/bin/doc77.ts:305-414。sync/plugins 由 workspace 包提供；
  // RAG 需要已一键安装的 @doc77/ai（RagEngine），未安装则跳过。全部 best-effort。
  let syncModule: any = null;
  try {
    syncModule = await dynamicImport('@doc77/sync');
  } catch {
    /* @doc77/sync 不可用 —— 跳过 sync 路由 */
  }
  let galleryModule: any = null;
  try {
    const gallery = await dynamicImport('@doc77/gallery');
    if (gallery?.registerGalleryRoutes) galleryModule = gallery;
  } catch {
    /* gallery not built or unavailable */
  }

  await registerHttpRoutes(app, {
    getConnection: core.getConnection,
    getConfig: core.getConfig,
    thumbnailsDir: path.join(os.homedir(), '.doc77', 'thumbnails'),
    pluginDir: path.join(os.homedir(), '.doc77', 'plugins'),
    sync: syncModule
      ? {
          createSyncEngine: syncModule.createSyncEngine,
          createSyncScheduler: syncModule.createSyncScheduler,
          registerSyncRoutes: syncModule.registerSyncRoutes,
        }
      : undefined,
    rag:
      ai?.RagEngine && core.registerAiRagRoutes
        ? {
            RagEngine: ai.RagEngine,
            registerAiRagRoutes: core.registerAiRagRoutes,
          }
        : undefined,
    plugins: core.registerPluginRoutes
      ? { registerPluginRoutes: core.registerPluginRoutes }
      : undefined,
    gallery: galleryModule
      ? { registerGalleryRoutes: galleryModule.registerGalleryRoutes }
      : undefined,
  });

  core.setCapabilities({ ai: !!ai, mcp: !!mcp, translate, gallery: !!galleryModule });
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

  // v1.1.4 (F3)：启动 GC —— 遏制"用久了越来越卡"（表无限累积 → sql.js
  // 全库序列化越来越贵）。与 CLI 的 pruneAiSessions(24) 对齐；日志保留 90 天。
  try {
    core.pruneAiSessions(24);
  } catch {
    /* best-effort */
  }
  try {
    core.getConnection().exec(
      `DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days');
       DELETE FROM sync_log WHERE created_at < datetime('now', '-90 days');`,
    );
  } catch {
    /* best-effort */
  }

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
  // v1.1.4：文件监听改为惰性启动 —— 首个 SSE 客户端连接时才由 core 的
  // /api/events 包装启动（无 UI 客户端时零开销），不再在此无条件启动
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
