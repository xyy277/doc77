/**
 * Doc77 Electron — System tray
 */
import { Tray, Menu, app, nativeImage } from 'electron';
import { t } from './i18n';

/** 托盘菜单附加动作 —— 由 main.ts 注入（触发 IPC / 调用 updater）。 */
export interface TrayActions {
  /** 用户点击"检查更新"时触发。 */
  onCheckUpdates?: () => void;
  /** 用户点击"设置"时触发。 */
  onSettings?: () => void;
}

export function createTray(iconPath: string, onClick: () => void, actions: TrayActions = {}): Tray {
  const icon = nativeImage.createFromPath(iconPath);
  const tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Doc77');

  const template: Array<Electron.MenuItemConstructorOptions> = [
    {
      label: t('electron.tray.open'),
      click: () => onClick(),
    },
    { type: 'separator' },
  ];

  // 检查更新项：仅在注入了 onCheckUpdates 回调时显示（避免 dev 模式误导用户）
  if (actions.onCheckUpdates) {
    template.push({
      label: t('electron.tray.checkUpdates'),
      click: () => actions.onCheckUpdates?.(),
    });
  }

  // 设置项：打开设置页面
  if (actions.onSettings) {
    template.push({
      label: t('electron.tray.settings'),
      click: () => actions.onSettings?.(),
    });
  }

  template.push({ type: 'separator' });
  template.push({
    label: t('electron.tray.quit'),
    click: () => {
      app.quit();
    },
  });

  const contextMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(contextMenu);

  // 单击：切换窗口可见性（保留原有行为）
  tray.on('click', onClick);
  // 双击：与单击一致，符合 Windows/macOS 用户的直觉期望
  tray.on('double-click', onClick);

  return tray;
}
