/**
 * Doc77 Electron — 待打开文件队列（纯逻辑，不依赖 Electron API）
 *
 * 抽离自 main.ts，便于单元测试。
 *
 * 场景：用户在 mainWindow 尚未就绪时（启动早期 / 隐藏到托盘后窗口被销毁）
 * 双击 .md 文件或触发 second-instance。此时 handleFileOpen 无法导航，
 * 必须先把文件路径缓存到队列里，等窗口再次 ready 时按 FIFO 顺序 drain。
 *
 * 设计为纯函数集合 + 一个轻量容器类，不引用任何 Electron 类型，
 * 因此 Vitest 可以直接 import 测试，无需 mock Electron。
 */

/** 队列消费者：拿到一个文件路径后执行导航等动作。返回值目前不使用。 */
export type FileConsumer = (filePath: string) => void;

/**
 * PendingFilesQueue — FIFO 待打开文件队列。
 *
 * 不持有任何 Electron 引用，由调用方注入消费者。
 * 仅当调用方主动调用 drain 时才会消费，避免竞态。
 */
export class PendingFilesQueue {
  private readonly files: string[] = [];

  /** 入队一个文件路径。 */
  enqueue(filePath: string): void {
    if (!filePath) return;
    this.files.push(filePath);
  }

  /** 当前队列长度（测试与诊断用）。 */
  get size(): number {
    return this.files.length;
  }

  /** 队列是否为空。 */
  get isEmpty(): boolean {
    return this.files.length === 0;
  }

  /** 窥探队首（不弹出），便于调试。 */
  peek(): string | undefined {
    return this.files[0];
  }

  /**
   * 排空队列：按 FIFO 顺序对每个待处理文件调用 consumer。
   * 调用过程中新加入的文件不会被消费（先快照再迭代），
   * 避免消费者回调里再次 enqueue 导致无限循环。
   *
   * @returns 实际尝试消费的文件数量（即使 consumer 抛错也计入；
   *          抛错的文件不会重新入队，避免死循环）
   */
  drain(consumer: FileConsumer): number {
    if (this.files.length === 0) return 0;
    // 先快照再清空，保证 consumer 内若再次 enqueue 只会进入下一轮
    const snapshot = this.files.splice(0, this.files.length);
    let consumed = 0;
    for (const f of snapshot) {
      try {
        consumer(f);
      } catch {
        // 单个文件消费失败不影响后续文件；继续 drain
        // （此处不重新入队，避免死循环；上层可重试）
      }
      // 无论成功或失败都计入"已尝试消费"
      consumed++;
    }
    return consumed;
  }

  /** 清空队列（用于退出时丢弃待处理文件）。 */
  clear(): void {
    this.files.length = 0;
  }
}

/**
 * createPendingFilesQueue — 工厂函数，便于测试与依赖注入。
 */
export function createPendingFilesQueue(): PendingFilesQueue {
  return new PendingFilesQueue();
}
