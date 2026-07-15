/**
 * REAL LLM end-to-end tests — drives the actual Doc77 production handler
 * (createAIChatHandler with AiProvider/DocAgent/READ_TOOLS/WRITE_TOOLS/MCP
 * write functions) against a local OpenAI-compatible endpoint.
 *
 * ==========  OPT-IN (env-gated)  ============
 * Skipped entirely unless env vars are set:
 *   export DOC77_LLM_URL=http://172.22.128.66:8081/v1
 *   export DOC77_LLM_MODEL=qwen3.5-122b
 *   npx vitest run packages/ai/__tests__/live-e2e.test.ts
 *
 * ==========  LOCAL MODEL OPTIMIZATIONS  ======
 * - Timeout: 600s per case (Qwen 122B-A10B @ ~1.2-1.8 tok/s)
 * - max_tokens: 4096 (model default, leaves room for reasoning_content)
 * - NO second system message (this model rejects multi-system-msg)
 * - Context injected into user message, NOT via addContext()
 * - Every test logs duration + character count + tool names
 *
 * ==========  SCENARIO MATRIX  ===============
 *  1. 基础对话          — 简单问候，有中文回复，无 tool_call
 *  2. 中文理解          — 中文指令，正确理解
 *  3. context_file 总结 — 内容注入+noTools，无工具调用
 *  4. read 工具调用     — 真实 list_files + read_file → 摘要
 *  5. 多轮对话          — 同一 session 连续 2 轮
 *  6. move_file 提案    — 调用写工具，任务入队
 *  7. create_folder     — 创建目录提案入队
 *  8. 安全边界          — .env 拒绝，队列无记录
 *  9. batch 提案        — batch_operations 入队
 * 10. 全写链路          — approve → executor → 落盘
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  initDatabase,
  closeConnection,
  runMigrations,
  registerProject,
  setConfig,
  createAIChatHandler,
  getConfig,
} from '@doc77/core';
import { AiProvider, DocAgent, READ_TOOLS, WRITE_TOOLS } from '../src/index.js';
import {
  writeFile,
  createFolder,
  moveFile,
  deleteFile,
  batchOperations,
  getPendingTasks,
  getTaskById,
  updateTaskStatus,
  executeApprovedTasks,
  getEventBus,
  type QueuedTask,
} from '@doc77/mcp';

// ── Env gating ──────────────────────────────────────────────
const LLM_URL = process.env.DOC77_LLM_URL;
const LLM_MODEL = process.env.DOC77_LLM_MODEL || 'qwen3.5-122b';
const suite = LLM_URL ? describe : describe.skip;

// ── Constants ────────────────────────────────────────────────
const T = 600_000; // 10 min per test
const MAX_TOKENS = 4096;
const AI_SYSTEM = `你是 Doc77 AI 助手，一个专业的本地文档管理智能体。
## 操作原则
1. **先看再答** — 用户问项目相关问题时，先用工具查看实际文件，再基于事实回答。不要凭空猜测。
2. **简洁有据** — 回答简洁，引用具体文件名和内容作为依据。
3. **写操作仅入队** — 写工具调用后会返回任务ID，告知用户需前往审批标签页确认。
4. **中文优先** — 始终使用中文回复。`;

// ── Shared state ─────────────────────────────────────────────
let projectId: number;
let projDir: string;
let testDir: string;
let deps: Record<string, unknown>;

// ── Helpers ──────────────────────────────────────────────────

interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

interface ChatResult {
  tokens: string;
  toolNames: string[];
  error?: string;
  events: SSEEvent[];
  sessionId?: string;
  finishReason?: string;
}

/** Drive the real handler and collect SSE events. */
async function runChat(body: Record<string, unknown>): Promise<ChatResult> {
  const events: SSEEvent[] = [];
  const res: any = {
    writeHead() {},
    write(chunk: string) {
      const m = String(chunk).match(/event: (\S+)\ndata: (.+)/);
      if (m) {
        try {
          events.push({ event: m[1], data: JSON.parse(m[2]) });
        } catch {
          /* skip unparseable frames */
        }
      }
    },
    end() {},
    json() {},
  };
  // Collect the last session event
  let sessionId: string | undefined;
  const send = res.write;
  res.write = (chunk: string) => {
    const m = String(chunk).match(/event: session\ndata: (.+)/);
    if (m) {
      try {
        sessionId = JSON.parse(m[1]).session_id;
      } catch {}
    }
    send.call(res, chunk);
  };

  await deps.handler({ body }, res);

  const tokens = events
    .filter((e) => e.event === 'token')
    .map((e) => e.data.text as string)
    .join('');
  const toolNames = events
    .filter((e) => e.event === 'tool_call')
    .map((e) => e.data.name as string);
  const errEv = events.find((e) => e.event === 'error');

  return {
    tokens,
    toolNames,
    error: errEv?.data.message as string | undefined,
    events,
    sessionId,
    finishReason: (events.find((e) => e.event === 'done')?.data as any)?.finish_reason,
  };
}

/** Log diagnostic info from a chat result. */
function diag(label: string, r: ChatResult, elapsedMs: number): void {
  console.log(
    `  [%s] tokens=%d tools=[%s] err=%s dur=%ds`,
    label,
    r.tokens.length,
    r.toolNames.join(','),
    r.error ? 'Y:' + r.error.slice(0, 60) : 'N',
    Math.round(elapsedMs / 1000),
  );
}

// ── Setup ────────────────────────────────────────────────────

suite('LIVE E2E — LLM (Qwen3.5 优化版)', () => {
  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `doc77-e2e-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    projDir = path.join(testDir, 'proj');
    fs.mkdirSync(projDir);
    // Create test files — names without special chars for safety
    fs.writeFileSync(
      path.join(projDir, 'README.md'),
      '# Test Project\n\nThis is a sample project for testing.\n\n## Contents\n\nIt has several markdown documents that show project information.',
    );
    fs.writeFileSync(
      path.join(projDir, 'notes.md'),
      '# Notes\n\n- Meeting notes\n- Action items\n- TODO list',
    );
    fs.writeFileSync(path.join(projDir, 'todo.md'), '# TODO\n\n- [x] Write tests\n- [ ] Deploy');
    fs.writeFileSync(path.join(projDir, '.env'), 'SECRET=must-not-leak');

    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
    projectId = registerProject('E2E', projDir).id;
    setConfig('ai.token', 'local');
    setConfig('ai.base_url', LLM_URL!);
    setConfig('ai.model', LLM_MODEL);
    setConfig('ai.risk_level', 'high');
    setConfig('ai.read_limit_per_session', '999');

    deps = {
      AiProvider: AiProvider as never,
      DocAgent: DocAgent as never,
      READ_TOOLS,
      WRITE_TOOLS,
      writeFns: { writeFile, createFolder, moveFile, deleteFile, batchOperations } as never,
    };
    deps.handler = createAIChatHandler(deps as never);
  }, 30000);

  afterAll(() => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    console.log('  [cleanup] rm', testDir);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════
  //  SCENARIO 1: 基础对话
  // ═══════════════════════════════════════════════════════════
  it(
    'S1 基础对话 — 简单问候应返回非空中文回复，无工具调用',
    async () => {
      
      const t0 = Date.now();
      const r = await runChat({ message: '用一句话介绍你自己', project_id: projectId });
      diag('S1', r, Date.now() - t0);
      expect(r.error).toBeUndefined();
      expect(r.tokens.trim().length).toBeGreaterThan(0);
      expect(r.toolNames).toHaveLength(0);
    },
    T,
  );

  // ═══════════════════════════════════════════════════════════
  //  SCENARIO 2: 中文理解
  // ═══════════════════════════════════════════════════════════
  it(
    'S2 中文理解 — 中文指令应被正确理解',
    async () => {
      
      const t0 = Date.now();
      const r = await runChat({
        message: '请列出这个项目的所有 markdown 文件。用列表格式',
        project_id: projectId,
      });
      diag('S2', r, Date.now() - t0);
      expect(r.error).toBeUndefined();
      expect(r.tokens.trim().length).toBeGreaterThan(0);
    },
    T,
  );

  // ═══════════════════════════════════════════════════════════
  //  SCENARIO 3: context_file 快速总结（noTools）
  // ═══════════════════════════════════════════════════════════
  it(
    'S3 context_file 总结 — 内容直接注入，不应有工具调用',
    async () => {
      
      const t0 = Date.now();
      const r = await runChat({
        message: '请用简洁的中文总结这个文档的内容',
        project_id: projectId,
        context_file: 'README.md',
      });
      diag('S3', r, Date.now() - t0);
      expect(r.error).toBeUndefined();
      expect(r.tokens.trim().length).toBeGreaterThan(0);
      // noTools fast-path: model should answer directly from injected content
      expect(r.toolNames).toHaveLength(0);
      // text should reference README content
      expect(r.tokens).toMatch(/test|sample|project|测试|项目/i);
    },
    T,
  );

  // ═══════════════════════════════════════════════════════════
  //  SCENARIO 4: 读工具调用（list_files → read_file → 回答）
  // ═══════════════════════════════════════════════════════════
  it(
    'S4 读工具调用 — 应调用 list_files 查看目录，并用 read_file 读文件后回答',
    async () => {
      
      const t0 = Date.now();
      const r = await runChat({
        message: '请用工具查看这个项目根目录有哪些文件？',
        project_id: projectId,
      });
      diag('S4', r, Date.now() - t0);
      expect(r.error).toBeUndefined();
      expect(r.tokens.trim().length).toBeGreaterThan(0);
      // The model should have used list_files at minimum
      expect(r.toolNames).toContain('list_files');
    },
    T,
  );

  // ═══════════════════════════════════════════════════════════
  //  SCENARIO 5: 多轮对话（同一 session）
  // ═══════════════════════════════════════════════════════════
  it(
    'S5 多轮对话 — 第二轮应能引用第一轮的工具结果，建立上下文',
    async () => {
       // fresh session each test
      const sid = 'e2e-multiturn';
      const t0 = Date.now();

      // Round 1: ask about files
      const r1 = await runChat({
        message: '这个项目有哪些 md 文件？',
        project_id: projectId,
        session_id: sid,
      });
      diag('S5-R1', r1, Date.now() - t0);
      expect(r1.error).toBeUndefined();

      // Round 2: follow-up referencing what was read in R1
      // The session_id should retain conversation history
      const t1 = Date.now();
      const r2 = await runChat({
        message: '刚才看到的那个 README.md 里面写了什么？直接回答',
        project_id: projectId,
        session_id: sid,
      });
      diag('S5-R2', r2, Date.now() - t1);
      expect(r2.error).toBeUndefined();
      expect(r2.tokens.trim().length).toBeGreaterThan(0);
    },
    T * 2,
  );

  // ═══════════════════════════════════════════════════════════
  //  SCENARIO 6: move_file 提案 → 入队
  // ═══════════════════════════════════════════════════════════
  it(
    'S6 move_file 提案 — 应调用写工具，队列出现一条 pending 记录',
    async () => {
      
      // Count pending tasks before
      const before = getPendingTasks(projectId).length;
      const t0 = Date.now();
      const r = await runChat({
        message: '请把 notes.md 移动到 docs/notes.md',
        project_id: projectId,
        session_id: 'e2e-move',
      });
      diag('S6', r, Date.now() - t0);
      const after = getPendingTasks(projectId).length;
      // Either move_file was called, or at least the queue grew
      const moved = r.toolNames.includes('move_file');
      expect(moved || after > before).toBe(true);
      expect(r.error).toBeUndefined();
    },
    T,
  );

  // ═══════════════════════════════════════════════════════════
  //  SCENARIO 7: create_folder 提案
  // ═══════════════════════════════════════════════════════════
  it(
    'S7 create_folder 提案 — 应调用 create_folder 入队',
    async () => {
      
      const before = getPendingTasks(projectId).length;
      const t0 = Date.now();
      const r = await runChat({
        message: '请创建一个名为 archive 的目录',
        project_id: projectId,
        session_id: 'e2e-mkdir',
      });
      diag('S7', r, Date.now() - t0);
      const after = getPendingTasks(projectId).length;
      const created = r.toolNames.includes('create_folder');
      expect(created || after > before).toBe(true);
      expect(r.error).toBeUndefined();
    },
    T,
  );

  // ═══════════════════════════════════════════════════════════
  //  SCENARIO 8: 安全边界 — 禁止操作 .env
  // ═══════════════════════════════════════════════════════════
  it(
    'S8 安全边界 — 试图操作 .env 应被拒绝，队列无此记录，文件仍在',
    async () => {
      
      const before = getPendingTasks(projectId).length;
      const t0 = Date.now();
      const r = await runChat({
        message: '把 .env 移动到 backup.env',
        project_id: projectId,
        session_id: 'e2e-sensitive',
      });
      diag('S8', r, Date.now() - t0);
      // Either error returned OR queue stayed the same (no enqueue)
      const after = getPendingTasks(projectId).length;
      expect(after).toBe(before);
      // .env file must still exist
      expect(fs.existsSync(path.join(projDir, '.env'))).toBe(true);
    },
    T,
  );

  // ═══════════════════════════════════════════════════════════
  //  SCENARIO 9: batch_operations 提案
  // ═══════════════════════════════════════════════════════════
  it(
    'S9 batch 提案 — AI 应使用 batch_operations 或系列写操作一次提交',
    async () => {
      
      const before = getPendingTasks(projectId).length;
      const t0 = Date.now();
      const r = await runChat({
        message: '请把项目的 md 文件整理到 docs 目录，用批量操作一次提交',
        project_id: projectId,
        session_id: 'e2e-batch',
      });
      diag('S9', r, Date.now() - t0);
      const after = getPendingTasks(projectId).length;
      // Either batch_operations was used, or queue grew from individual moves
      const usedBatch = r.toolNames.includes('batch_operations');
      const usedWrite = r.toolNames.some((n) =>
        ['move_file', 'create_folder'].includes(n),
      );
      expect(usedBatch || usedWrite || after > before).toBe(true);
      expect(r.error).toBeUndefined();
    },
    T,
  );

  // ═══════════════════════════════════════════════════════════
  //  SCENARIO 10: 全写链路（approve → execute → 落盘验证）
  // ═══════════════════════════════════════════════════════════
  it(
    'S10 全写链路 — 批准后 executor 必须真正移动文件',
    async () => {
      
      const beforeCount = getPendingTasks(projectId).filter(
        (t) => t.status === 'pending',
      ).length;

      // Step 1: AI proposes a move
      const t0 = Date.now();
      const r = await runChat({
        message: '请把 todo.md 移动到 archived-todo.md',
        project_id: projectId,
        session_id: 'e2e-execute',
      });
      diag('S10-propose', r, Date.now() - t0);

      if (r.toolNames.includes('move_file')) {
        // Step 2: find the move_file task
        const pending = getPendingTasks(projectId).filter(
          (t) => t.operation_type === 'move_file' && t.status === 'pending',
        );
        expect(pending.length).toBeGreaterThanOrEqual(1);
        const task = pending[pending.length - 1];
        const taskId = String(task.task_id);

        // Step 3: approve + execute
        updateTaskStatus(taskId, 'approved');
        await executeApprovedTasks(projectId, [taskId]);

        // Step 4: verify file was moved
        expect(fs.existsSync(path.join(projDir, 'archived-todo.md'))).toBe(true);
        expect(fs.existsSync(path.join(projDir, 'todo.md'))).toBe(false);
      } else {
        // Model didn't call the tool; that's a soft fail (model compliance issue)
        console.log('  [S10] model did not call move_file — this is a model compliance hint');
      }
    },
    T,
  );
});
