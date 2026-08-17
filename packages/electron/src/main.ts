/**
 * Doc77 Electron — Main process entry
 * Port probe → spawn server → BrowserWindow → system tray.
 */
import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, globalShortcut } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { t } from './i18n';
import {
  findAvailablePort,
  startServer,
  ServerProcess,
  getInstalledEventBus,
  stopTunnel,
} from './server';
import { createTray } from './tray';
import { initAutoUpdater, checkForUpdates } from './updater';
import { PendingFilesQueue, createPendingFilesQueue } from './pending-files';
import {
  ElectronNotificationDispatcher,
  NotificationSubscriber,
  showNotification,
} from './notifications';

// Main is compiled to CommonJS but core's deps are ESM-only — core may only
// be loaded via dynamic import (see server.ts loadCore).
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<any>;

// 修复前强制 enable-gpu-rasterization / enable-zero-copy：无 GPU 环境
// （WSL2 / 虚拟机）强制退回 SwiftShader 软件渲染，反而增加 CPU 与内存。
// 删除后恢复 Chromium 自动策略（有 GPU 自动启用，无 GPU 自动降级）。
let mainWindow: BrowserWindow | null = null;
let server: ServerProcess | null = null;
// tray reference is kept to prevent garbage collection of the system tray.
let tray: Tray | null = null;
let shuttingDown = false;

// ═══ 待打开文件队列 ═══
// 在 mainWindow 尚未就绪时（启动早期 / 窗口被销毁），handleFileOpen 把
// 文件路径缓存到队列里，等窗口 ready 时按 FIFO drain。抽离为纯逻辑类
// （见 ./pending-files.ts）以便单元测试。
const pendingFiles: PendingFilesQueue = createPendingFilesQueue();

// ═══ 通知订阅器 ═══
// 订阅 mcp 事件总线（审批/任务执行/失败），转成桌面通知。事件总线
// 由 server.ts 在 mcp 模块加载后缓存；未安装 mcp 时为 null，跳过订阅。
let notificationSubscriber: NotificationSubscriber | null = null;

// ═══ Window state persistence ═══
const WINDOW_STATE_PATH = path.join(os.homedir(), '.doc77', 'window-state.json');
interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

function loadWindowState(): WindowState {
  try {
    const data = fs.readFileSync(WINDOW_STATE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { width: 1280, height: 800 };
  }
}

function saveWindowState(): void {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const state: WindowState = { ...bounds, maximized: mainWindow.isMaximized() };
  try {
    fs.mkdirSync(path.dirname(WINDOW_STATE_PATH), { recursive: true });
    fs.writeFileSync(WINDOW_STATE_PATH, JSON.stringify(state));
  } catch {}
}

function createWindow(port: number): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    title: 'Doc77',
    icon: iconPath,
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (state.maximized) mainWindow.maximize();
  mainWindow.loadURL(`http://localhost:${port}`);
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // 窗口就绪：排空此前入队的待打开文件（启动期间双击的 .md 等）
    drainPendingFiles();
  });

  // Save window state on resize/move
  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);

  // Intercept external links — open in system browser instead of leaving the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = new URL(url);
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('close', (e) => {
    if (!shuttingDown) {
      e.preventDefault();
      mainWindow?.hide(); // minimize to tray
    }
  });
}

/** Build minimal application menu — macOS keeps system menu, Windows/Linux get bare minimum. */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS: system app menu (About, Preferences, Quit) — platform convention
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    // macOS: standard Edit menu (Undo, Redo, Cut, Copy, Paste, Select All)
    ...(isMac ? [{ role: 'editMenu' as const }] : []),
    // Minimal Help menu
    {
      label: 'Help',
      role: 'help',
      submenu: [
        {
          label: 'About Doc77',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
            }
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot(): Promise<void> {
  const port = await findAvailablePort(28888);
  // Windows has no LANG/LC_ALL, so core's backend language auto-detection fell
  // back to en-US (English toasts in a Chinese UI). Chromium knows the real
  // OS locale — hand it to the server for i18n detection.
  server = await startServer(port, app.getLocale());

  // The server may have moved (explicit server.port override, or busy-port
  // fallback) — the window must load whatever port it actually listens on.
  createWindow(server.port);

  // Auto-update for packaged builds (no-op in dev)
  initAutoUpdater(mainWindow);

  const trayIconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  tray = createTray(
    trayIconPath,
    () => {
      if (mainWindow?.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow?.show();
        mainWindow?.focus();
        // 从托盘恢复时也排空待打开文件队列（窗口可能被 hide 期间入队）
        drainPendingFiles();
      }
    },
    {
      // 检查更新：直接调用 updater（无需经渲染进程绕一圈）
      onCheckUpdates: () => {
        void checkForUpdates();
      },
      // 设置：显示窗口并通知渲染进程打开设置页
      onSettings: () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents.send('shortcut:settings');
      },
    },
  );

  // ═══ 通知订阅器 ═══
  // mcp 安装后 server.ts 已缓存事件总线；这里尝试 attach。未安装时
  // getInstalledEventBus() 返回 null，订阅器保持 idle。
  if (!notificationSubscriber) {
    const dispatcher = new ElectronNotificationDispatcher(() => mainWindow);
    notificationSubscriber = new NotificationSubscriber(dispatcher);
    const bus = getInstalledEventBus();
    if (bus) notificationSubscriber.attachEventBus(bus);
  }
}

/** Surface boot failures instead of leaving a windowless zombie process. */
function reportBootFailure(err: Error): void {
  const message = `${new Date().toISOString()} boot failed\n${err.stack || err.message}\n`;
  try {
    const logDir = path.join(os.homedir(), '.doc77');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'electron-error.log'), message);
  } catch {
    /* logging must never mask the dialog */
  }
  dialog.showErrorBox(
    'Doc77 failed to start',
    `${err.message}\n\nDetails: ~/.doc77/electron-error.log`,
  );
  shuttingDown = true;
  app.quit();
}

// IPC: native directory picker
ipcMain.handle('dialog:openDirectory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: t('electron.dialog.selectDir'),
  });
  return result.canceled ? null : result.filePaths[0];
});

// IPC: get server port
ipcMain.handle('getPort', () => server?.port ?? 28888);

// Force reset — last-resort unlock when password AND recovery codes are
// lost. Gated twice: the IPC channel exists only inside Electron (a web/LAN
// client never reaches it), and this native dialog requires a deliberate
// confirmation before wiping auth state.
ipcMain.handle('auth:forceReset', async () => {
  if (!mainWindow) return { ok: false, error: 'no_window' };
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: t('electron.dialog.forceResetTitle'),
    message: t('electron.dialog.forceResetTitle'),
    detail: t('electron.dialog.forceResetBody'),
    buttons: [t('electron.dialog.forceResetCancel'), t('electron.dialog.forceResetConfirm')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (choice.response !== 1) return { ok: false, cancelled: true };
  try {
    const core = await dynamicImport('@doc77/core');
    core.forceResetPassword('electron');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    // Windows: file path passed as last command line arg
    const filePath = commandLine.find((arg) => /\.(md|txt|pdf|json|yaml|yml)$/i.test(arg));
    if (filePath) handleFileOpen(filePath);
  });

  app.whenReady().then(() => {
    buildAppMenu();
    boot().catch(reportBootFailure);

    // Global shortcut: Ctrl+Shift+D to toggle window
    globalShortcut.register('CommandOrControl+Shift+D', () => {
      if (mainWindow?.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow?.show();
        mainWindow?.focus();
      }
    });

    // Global shortcut: Ctrl+Shift+F — 触发前端搜索（渲染进程响应）
    globalShortcut.register('CommandOrControl+Shift+F', () => {
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send('shortcut:search');
    });

    // Global shortcut: Ctrl+Shift+S — 触发同步（渲染进程响应）
    globalShortcut.register('CommandOrControl+Shift+S', () => {
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send('shortcut:sync');
    });

    // Global shortcut: Ctrl+, — 打开设置（渲染进程响应）
    globalShortcut.register('CommandOrControl+,', () => {
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send('shortcut:settings');
    });
  });
}

// File association: open files passed via command line (Windows) or open-file event (macOS)
function handleFileOpen(filePath: string): void {
  // 先入队，保持 FIFO 顺序（启动早期入队的旧文件先 drain，避免被新文件抢占）
  pendingFiles.enqueue(filePath);
  // 窗口未就绪：保留在队列里等 ready-to-show / 再次 show 时统一 drain
  if (!mainWindow || !server) return;
  mainWindow.show();
  mainWindow.focus();
  drainPendingFiles();
}

/**
 * drainPendingFiles — 把队列里待打开的文件按 FIFO 顺序导航到预览页。
 * 仅在 mainWindow 与 server 都就绪时调用；否则保持入队状态等待下次。
 * 连续 loadURL 会互相覆盖，最终展示队尾文件 —— 这是可接受的，因为
 * 一个窗口只能显示一个文件，用户最近的操作即意图。
 */
function drainPendingFiles(): void {
  if (!mainWindow || !server) return;
  pendingFiles.drain((filePath) => {
    mainWindow?.loadURL(
      `http://localhost:${server?.port ?? 28888}/preview.html?file=${encodeURIComponent(filePath)}`,
    );
  });
}

// macOS: open-file event
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  handleFileOpen(filePath);
});

app.on('before-quit', () => {
  shuttingDown = true;
  globalShortcut.unregisterAll();
  saveWindowState();
  // 解绑通知订阅器，避免 EventEmitter 泄漏
  notificationSubscriber?.detachEventBus();
  notificationSubscriber = null;
  // 清空待打开文件队列（退出时丢弃未处理的文件）
  pendingFiles.clear();
  tray?.destroy();
  tray = null;
  server?.kill();
  // T6: 退出前尝试停止隧道管理器，避免 cloudflared/ngrok 子进程变孤儿。
  // T3 由另一 agent 实施，这里 fire-and-forget 调用 stop；
  // core 不可用 / 未加载 / 无隧道管理器时安静跳过（见 server.ts stopTunnel）。
  void stopTunnel();
});

app.on('window-all-closed', () => {
  // Don't quit — keep running in tray
});

// macOS: re-create window when dock icon clicked
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});
