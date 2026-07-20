/**
 * Doc77 Electron — Auto-updater (electron-updater).
 *
 * Checks GitHub Releases for newer desktop installers, notifies
 * the renderer via a unified IPC event channel, and lets the user
 * trigger download + restart-to-install.  Disabled in dev mode
 * (app.isPackaged === false) because electron-updater needs a
 * signed/packaged build and a published latest.yml.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater, UpdateInfo as EUpdateInfo } from 'electron-updater';

let initialized = false;

export function initAutoUpdater(mainWindow: BrowserWindow | null): void {
  if (initialized) return;
  initialized = true;

  // In dev mode electron-updater cannot function — the app is neither
  // packaged nor signed, and no latest.yml exists.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.allowPrerelease = false;

  /** Push a typed event to the renderer via the unified event channel. */
  function send(type: string, payload: Record<string, unknown> = {}): void {
    mainWindow?.webContents.send('update:event', { type, ...payload });
  }

  autoUpdater.on('checking-for-update', () => send('status', { status: 'checking' }));
  autoUpdater.on('update-available', (info: EUpdateInfo) =>
    send('status', { status: 'available', version: info.version }),
  );
  autoUpdater.on('update-not-available', () => send('status', { status: 'up-to-date' }));
  autoUpdater.on('download-progress', (p) => send('progress', { percent: p.percent }));
  autoUpdater.on('update-downloaded', () => send('status', { status: 'downloaded' }));
  autoUpdater.on('error', (err: Error) => send('error', { message: err.message }));

  ipcMain.handle('update:check', async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      /* silently ignore */
    }
  });
  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      /* silently ignore */
    }
  });
  ipcMain.handle('update:quit-and-install', () => {
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });

  // Initial check 5s after boot
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}
