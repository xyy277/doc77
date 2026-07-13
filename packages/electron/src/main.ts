/**
 * Doc77 Electron — Main process entry
 * Port probe → spawn server → BrowserWindow → system tray.
 */
import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
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
  const port = await findAvailablePort(2777);
  server = await startServer(port);

  createWindow(port);

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

// IPC: native directory picker
ipcMain.handle('dialog:openDirectory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择项目目录',
  });
  return result.canceled ? null : result.filePaths[0];
});

// IPC: get server port
ipcMain.handle('getPort', () => server?.port ?? 2777);

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

  app.whenReady().then(boot);
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
