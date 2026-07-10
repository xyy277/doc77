/**
 * Doc77 Electron — System tray
 */
import { Tray, Menu, app, nativeImage } from 'electron';

export function createTray(iconPath: string, onClick: () => void): Tray {
  const icon = nativeImage.createFromPath(iconPath);
  const tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Doc77');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '📁 打开 Doc77',
      click: () => onClick(),
    },
    { type: 'separator' },
    {
      label: '❌ 退出 Doc77',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', onClick);

  return tray;
}
