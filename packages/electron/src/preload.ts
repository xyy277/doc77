/**
 * Doc77 Electron — Preload bridge
 * Exposes window.doc77 with native dialog + environment info.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('doc77', {
  openNativeDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openDirectory'),
  getPort: (): Promise<number> =>
    ipcRenderer.invoke('getPort'),
  platform: process.platform,
});
