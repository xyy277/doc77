/**
 * Doc77 Electron — Preload bridge
 * Exposes window.doc77 with native dialog + environment info.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('doc77', {
  openNativeDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openDirectory'),
  getPort: (): Promise<number> => ipcRenderer.invoke('getPort'),
  platform: process.platform,

  update: {
    checkForUpdates: (): Promise<void> => ipcRenderer.invoke('update:check'),
    downloadUpdate: (): Promise<void> => ipcRenderer.invoke('update:download'),
    quitAndInstall: (): Promise<void> => ipcRenderer.invoke('update:quit-and-install'),
    /** Listen for {type:'status'|'progress'|'error', ...} events. Returns unsubscribe. */
    onEvent: (callback: (event: Record<string, unknown>) => void): (() => void) => {
      const handler = (_event: unknown, data: Record<string, unknown>) => callback(data);
      ipcRenderer.on('update:event', handler);
      return () => {
        ipcRenderer.removeListener('update:event', handler);
      };
    },
  },
});
