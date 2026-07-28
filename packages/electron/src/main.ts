/**
 * Doc77 Electron — Main process entry
 * Port probe → spawn server → BrowserWindow → system tray.
 */
import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, globalShortcut } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { t } from './i18n';
import { findAvailablePort, startServer, ServerProcess } from './server';
import { createTray } from './tray';
import { initAutoUpdater } from './updater';

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

let mainWindow: BrowserWindow | null = null;
let server: ServerProcess | null = null;
// tray reference is kept to prevent garbage collection of the system tray.
let tray: Tray | null = null;
let shuttingDown = false;

// ═══ Window state persistence ═══
const WINDOW_STATE_PATH = path.join(os.homedir(), '.doc77', 'window-state.json');
interface WindowState { x?: number; y?: number; width: number; height: number; maximized?: boolean }

function loadWindowState(): WindowState {
  try {
    const data = fs.readFileSync(WINDOW_STATE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch { return { width: 1280, height: 800 }; }
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
  mainWindow.once('ready-to-show', () => mainWindow?.show());

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
  tray = createTray(trayIconPath, () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
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
  });
}

// File association: open files passed via command line (Windows) or open-file event (macOS)
function handleFileOpen(filePath: string): void {
  if (!mainWindow || !server) return;
  mainWindow.show();
  mainWindow.focus();
  // Navigate to preview with the file path
  mainWindow.loadURL(`http://localhost:${server.port}/preview.html?file=${encodeURIComponent(filePath)}`);
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
  tray?.destroy();
  tray = null;
  server?.kill();
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
