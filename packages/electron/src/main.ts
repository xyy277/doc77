/**
 * Doc77 Electron — Main process entry
 * Port probe → spawn server → BrowserWindow → system tray.
 */
import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import { findAvailablePort, startServer, ServerProcess } from './server';
import { createTray } from './tray';

let mainWindow: BrowserWindow | null = null;
let server: ServerProcess | null = null;
let tray: Tray | null = null;
let shuttingDown = false;

const isDev = !app.isPackaged;

function createWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Doc77',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.on('close', (e) => {
    if (!shuttingDown) {
      e.preventDefault();
      mainWindow?.hide(); // minimize to tray
    }
  });
}

async function boot(): Promise<void> {
  const port = await findAvailablePort(3099);
  server = await startServer(port);
  server.child.on('exit', (code) => {
    if (code !== 0 && !shuttingDown) {
      dialog.showErrorBox('服务异常', `Doc77 服务意外退出 (code ${code})`);
    }
  });

  createWindow(port);

  const iconPath = isDev
    ? path.join(__dirname, '..', 'assets', 'tray.png')
    : path.join(process.resourcesPath, 'assets', 'tray.png');
  tray = createTray(iconPath, () => {
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
ipcMain.handle('getPort', () => server?.port ?? 3099);

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
