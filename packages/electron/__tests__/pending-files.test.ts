import { describe, it, expect, vi } from 'vitest';
import { PendingFilesQueue, createPendingFilesQueue } from '../src/pending-files.js';

/**
 * PendingFilesQueue 纯逻辑测试 —— 不依赖 Electron API，可被 Vitest 直接测试。
 *
 * 验收对应（T6 验收标准）：
 *   - mock mainWindow 未就绪 → 调用 handleFileOpen → 队列长度 1
 *   - ready 后 drain → 队列长度 0
 *
 * 此处直接测队列类；main.ts 的 handleFileOpen 是该队列的薄包装
 * （!mainWindow 时 enqueue，ready 后 drain），逻辑等价。
 */
describe('PendingFilesQueue', () => {
  it('enqueue 后 size 递增；空字符串被忽略', () => {
    const q = createPendingFilesQueue();
    expect(q.size).toBe(0);
    expect(q.isEmpty).toBe(true);

    q.enqueue('a.md');
    expect(q.size).toBe(1);
    expect(q.isEmpty).toBe(false);

    // 空字符串入队应被忽略（防御性）
    q.enqueue('');
    expect(q.size).toBe(1);

    q.enqueue('b.txt');
    expect(q.size).toBe(2);
    expect(q.peek()).toBe('a.md'); // FIFO：队首是最早入队的
  });

  it('drain 按 FIFO 顺序消费；消费后队列空', () => {
    const q = new PendingFilesQueue();
    q.enqueue('a.md');
    q.enqueue('b.txt');
    q.enqueue('c.json');

    const consumed: string[] = [];
    const count = q.drain((f) => consumed.push(f));

    expect(count).toBe(3);
    expect(consumed).toEqual(['a.md', 'b.txt', 'c.json']);
    expect(q.size).toBe(0);
    expect(q.isEmpty).toBe(true);
  });

  it('drain 空队列是 no-op，返回 0', () => {
    const q = new PendingFilesQueue();
    const consumer = vi.fn();
    const count = q.drain(consumer);
    expect(count).toBe(0);
    expect(consumer).not.toHaveBeenCalled();
  });

  it('drain 过程中 consumer 抛错不影响后续文件消费', () => {
    const q = new PendingFilesQueue();
    q.enqueue('first.md');
    q.enqueue('second.md'); // 这条会触发 consumer 抛错
    q.enqueue('third.md');

    const consumed: string[] = [];
    const count = q.drain((f) => {
      consumed.push(f);
      if (f === 'second.md') throw new Error('boom');
    });

    // 第二条抛错但 drain 继续处理第三条
    expect(consumed).toEqual(['first.md', 'second.md', 'third.md']);
    // count 计数：first + second + third 都计入（即使 second 抛错）
    expect(count).toBe(3);
    expect(q.size).toBe(0);
  });

  it('clear 清空队列', () => {
    const q = new PendingFilesQueue();
    q.enqueue('a.md');
    q.enqueue('b.md');
    expect(q.size).toBe(2);

    q.clear();
    expect(q.size).toBe(0);
    expect(q.isEmpty).toBe(true);
  });

  it('drain 内 consumer 再次 enqueue 不会在当前轮被消费（避免无限循环）', () => {
    const q = new PendingFilesQueue();
    q.enqueue('first.md');

    const consumed: string[] = [];
    q.drain((f) => {
      consumed.push(f);
      // 模拟 consumer 在处理时再次入队一个新文件
      if (f === 'first.md') q.enqueue('follow-up.md');
    });

    // 第一轮只消费 first.md；follow-up.md 留在队列里等下次 drain
    expect(consumed).toEqual(['first.md']);
    expect(q.size).toBe(1);
    expect(q.peek()).toBe('follow-up.md');
  });
});

/**
 * 模拟 T6 验收场景的集成流程：
 *   1. 窗口未就绪 → handleFileOpen 入队 → 队列长度 1
 *   2. ready → drain → 队列长度 0，consumer 收到文件
 */
describe('handleFileOpen 等价流程（集成）', () => {
  it('未就绪时入队，就绪后 drain', () => {
    const q = createPendingFilesQueue();
    let windowReady = false;
    let serverPort: number | null = null;
    const navigated: string[] = [];

    // 模拟 main.ts handleFileOpen 的逻辑
    function handleFileOpen(filePath: string): void {
      q.enqueue(filePath);
      if (!windowReady || !serverPort) return;
      q.drain((f) => navigated.push(`http://localhost:${serverPort}/preview.html?file=${f}`));
    }

    // 场景 1：窗口未就绪，调用 handleFileOpen
    handleFileOpen('startup.md');
    expect(q.size).toBe(1);
    expect(navigated).toEqual([]);

    // 场景 2：窗口 ready，调用 drain（模拟 ready-to-show 钩子）
    windowReady = true;
    serverPort = 28888;
    // drain（main.ts 的 drainPendingFiles 等价调用）
    q.drain((f) => navigated.push(`http://localhost:${serverPort}/preview.html?file=${f}`));

    expect(q.size).toBe(0);
    expect(navigated).toEqual([
      'http://localhost:28888/preview.html?file=startup.md',
    ]);
  });
});
