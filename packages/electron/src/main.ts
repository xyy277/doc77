/**
 * Doc77 Electron — Main process entry
 * Port probe → spawn server → BrowserWindow → system tray.
 */
import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { t } from './i18n';
import { findAvailablePort, startServer, ServerProcess } from './server';
import { createTray } from './tray';

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

let mainWindow: BrowserWindow | null = null;
let server: ServerProcess | null = null;
let tray: Tray | null = null;
let shuttingDown = false;

function createWindow(port: number): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
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

  mainWindow.loadURL(`http://localhost:${port}`);
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('close', (e) => {
    if (!shuttingDown) {
      e.preventDefault();
      mainWindow?.hide(); // minimize to tray
    }
  });
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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => boot().catch(reportBootFailure));
}

app.on('before-quit', () => {
  shuttingDown = true;
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
