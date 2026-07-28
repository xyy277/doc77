/**
 * InterruptQueue — real-time steering for the AgentLoop.
 *
 * Allows the user to interrupt an in-progress agent turn with two signals:
 *   - 'cancel': stop generation after the current tool/stream chunk completes
 *   - 'inject': append a follow-up instruction mid-stream without cancelling
 *
 * The queue is non-blocking: the agent loop polls `peek()` / `drain()` between
 * stream chunks. If no interrupt is pending, execution continues immediately.
 *
 * Design borrowed from Claude Code's "real-time steering" concept: the user
 * never has to wait for a long tool batch to finish before redirecting the
 * agent.
 */

export type InterruptType = 'cancel' | 'inject';

export interface UserInterrupt {
  type: InterruptType;
  /** Present only for 'inject' — the follow-up message to append. */
  message?: string;
  /** Monotonic timestamp for debugging / ordering. */
  timestamp: number;
}

export class InterruptQueue {
  private queue: UserInterrupt[] = [];

  /** Enqueue a cancel signal. */
  cancel(): void {
    this.queue.push({ type: 'cancel', timestamp: Date.now() });
  }

  /** Enqueue an inject signal with a follow-up message. */
  inject(message: string): void {
    if (!message.trim()) return;
    this.queue.push({ type: 'inject', message, timestamp: Date.now() });
  }

  /** Non-blocking peek — returns the next interrupt without removing it. */
  peek(): UserInterrupt | undefined {
    return this.queue[0];
  }

  /** Dequeue and return the next interrupt, or undefined if empty. */
  dequeue(): UserInterrupt | undefined {
    return this.queue.shift();
  }

  /** Drain all pending interrupts as an array (FIFO order). */
  drain(): UserInterrupt[] {
    const items = this.queue;
    this.queue = [];
    return items;
  }

  /** True if a cancel is pending (checked between stream chunks). */
  get cancelPending(): boolean {
    return this.queue.some((i) => i.type === 'cancel');
  }

  /** Remove all pending interrupts. */
  clear(): void {
    this.queue = [];
  }

  get size(): number {
    return this.queue.length;
  }
}
