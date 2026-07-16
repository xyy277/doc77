/**
 * Doc77 Electron — System tray
 */
import { Tray, Menu, app, nativeImage } from 'electron';
import { t } from '@doc77/core';

export function createTray(iconPath: string, onClick: () => void): Tray {
  const icon = nativeImage.createFromPath(iconPath);
  const tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Doc77');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: t('electron.tray.open'),
      click: () => onClick(),
    },
    { type: 'separator' },
    {
      label: t('electron.tray.quit'),
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', onClick);

  return tray;
}
