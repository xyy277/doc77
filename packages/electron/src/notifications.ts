/**
 * Doc77 Electron — 系统通知模块
 *
 * 封装 Electron Notification API 并订阅事件总线，将后端关键事件
 * （审批通过 / 任务执行成功 / 任务失败 / 文件树变更）转成桌面通知。
 *
 * 设计要点：
 *   1. 纯逻辑部分（事件→通知文案映射）抽离为 buildNotification 函数，
 *      不依赖 Electron，可被 Vitest 直接测试。
 *   2. Electron Notification 调用封装到 ElectronNotificationDispatcher，
 *      依赖运行时 require('electron')，避免测试时强依赖 Electron。
 *   3. 事件总线注入：attachEventBus(bus, dispatcher) 注册订阅；detachEventBus 解绑。
 *
 * 文案经 electron/src/i18n.ts 的 t() shim 走 @doc77/core 词条
 * （zh-CN.json / en-US.json 同步维护，coreT 由 server.ts startServer 绑定）。
 */
import { t } from './i18n';

/** 通知参数：标题、正文、可选点击动作标签。 */
export interface NotificationOptions {
  title: string;
  body: string;
  /** 点击通知后用于路由的 IPC 事件名或路由标识（由调用方解释）。 */
  clickAction?: string;
}

/** 通知分发器接口：便于在测试中注入 mock 替代 Electron Notification。 */
export interface NotificationDispatcher {
  show(options: NotificationOptions): void;
}

/**
 * 事件总线的最小契约（与 core events-handler 的 MinimalBus 同构）。
 * 仅声明我们需要的方法；运行时由调用方注入 EventEmitter 或 mcp.getEventBus()。
 */
export interface EventBus {
  on(event: string, listener: (payload: unknown) => void): void;
  off(event: string, listener: (payload: unknown) => void): void;
}

/** 支持的事件名白名单 —— 仅订阅实际存在的事件。 */
export type NotificationEvent =
  | 'task:approved'
  | 'task:executed'
  | 'task:failed'
  | 'file-tree:changed';

/** 事件→通知文案的纯函数映射。抽离以便测试。 */
export function buildNotification(
  event: NotificationEvent,
  payload: unknown,
): NotificationOptions | null {
  // 防御性解析：payload 可能是任意形状
  const p = (payload ?? {}) as Record<string, unknown>;

  switch (event) {
    case 'task:approved': {
      const taskId = String(p.task_id ?? '');
      return {
        title: t('notification.approved.title'),
        body: t('notification.approved.body', { taskId }),
        clickAction: 'queue',
      };
    }
    case 'task:executed': {
      const taskId = String(p.task_id ?? '');
      return {
        title: t('notification.executed.title'),
        body: t('notification.executed.body', { taskId }),
        clickAction: 'queue',
      };
    }
    case 'task:failed': {
      const taskId = String(p.task_id ?? '');
      const err = typeof p.error_message === 'string' ? p.error_message : t('notification.unknownError');
      return {
        title: t('notification.failed.title'),
        body: t('notification.failed.body', { taskId, err }),
        clickAction: 'queue',
      };
    }
    case 'file-tree:changed':
      // 文件树变更频繁，不弹通知（避免骚扰），仅保留扩展点
      return null;
    default:
      return null;
  }
}

/**
 * 最小化的 Notification 形态：Electron Notification 实际对象的子集。
 * 用结构化类型而不是直接引用 Electron 类型，便于测试注入 mock。
 */
export interface NotificationLike {
  show(): void;
  on(event: 'click', listener: () => void): void;
}

/** Notification 构造器签名（Electron Notification 的子集）。 */
export type NotificationCtor = new (options: {
  title: string;
  body: string;
}) => NotificationLike;

/** 浏览器窗口的最小形态：仅需要 webContents.send 用于点击通知后 IPC 通知渲染进程。 */
export interface WindowLike {
  webContents: { send: (channel: string, ...args: unknown[]) => void };
}

/**
 * ElectronNotificationDispatcher — 默认实现，调用 Electron Notification。
 *
 * 在 main 进程上下文使用。点击通知后通过 IPC 通知渲染进程（clickAction
 * 作为事件名发送给 mainWindow）。mainWindow 可能为 null（启动早期或被
 * 关闭），因此调用方需传入一个稳定可获取当前窗口的 getter。
 */
export class ElectronNotificationDispatcher implements NotificationDispatcher {
  private readonly getWindow: () => WindowLike | null;
  private readonly NotificationCtor: NotificationCtor | null;

  constructor(
    getWindow: () => WindowLike | null,
    NotificationCtor?: NotificationCtor | null,
  ) {
    this.getWindow = getWindow;
    if (NotificationCtor !== undefined) {
      this.NotificationCtor = NotificationCtor;
    } else {
      // 延迟到运行时 require，避免测试环境强依赖 Electron
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        this.NotificationCtor = require('electron').Notification as NotificationCtor;
      } catch {
        this.NotificationCtor = null;
      }
    }
  }

  show(options: NotificationOptions): void {
    const Ctor = this.NotificationCtor;
    if (!Ctor) return;
    try {
      const n = new Ctor({ title: options.title, body: options.body });
      if (options.clickAction) {
        n.on('click', () => {
          const win = this.getWindow();
          win?.webContents.send('notification:click', { action: options.clickAction });
        });
      }
      n.show();
    } catch {
      // 通知失败不应阻塞主流程（例如 macOS 通知权限被拒）
    }
  }
}

/**
 * NotificationSubscriber — 事件总线订阅器。
 * 负责把后端事件转成桌面通知；可在事件总线可用后 attach，
 * 在退出前 detach 避免泄漏 listener。
 */
export class NotificationSubscriber {
  private readonly dispatcher: NotificationDispatcher;
  private readonly listeners = new Map<string, (payload: unknown) => void>();
  private bus: EventBus | null = null;

  constructor(dispatcher: NotificationDispatcher) {
    this.dispatcher = dispatcher;
  }

  /** 订阅事件总线。重复 attach 会先 detach 之前的订阅。 */
  attachEventBus(bus: EventBus): void {
    if (this.bus) this.detachEventBus();
    this.bus = bus;
    for (const event of [
      'task:approved',
      'task:executed',
      'task:failed',
      'file-tree:changed',
    ] as NotificationEvent[]) {
      const listener = (payload: unknown) => {
        const opts = buildNotification(event, payload);
        if (opts) this.dispatcher.show(opts);
      };
      bus.on(event, listener);
      this.listeners.set(event, listener);
    }
  }

  /** 解绑所有订阅，避免进程退出前 EventEmitter 泄漏。 */
  detachEventBus(): void {
    if (!this.bus) return;
    for (const [event, listener] of this.listeners) {
      this.bus.off(event, listener);
    }
    this.listeners.clear();
    this.bus = null;
  }
}

/**
 * showNotification — 一次性发送通知的便捷封装。
 * 适用于不依赖事件总线的临时通知（如手动触发同步完成提示）。
 */
export function showNotification(
  dispatcher: NotificationDispatcher,
  options: NotificationOptions,
): void {
  dispatcher.show(options);
}
