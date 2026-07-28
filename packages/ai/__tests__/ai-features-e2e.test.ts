/**
 * AI Features E2E Integration Tests (Phase 7.3).
 *
 * Tests the full stack integration of Phase 2-6 features using a **mock LLM
 * provider** (no live model required) wired to the **real SessionStore**
 * (SQLite). This validates that the pieces work together end-to-end:
 *
 *   Phase 2 (SessionStore)  — multi-session CRUD + message tree
 *   Phase 3 (AgentLoop)     — five-layer harness with persistence
 *   Phase 4 (SkillEngine)   — SKILL.md scanning + system prompt injection
 *   Phase 6 (ToolRouter)    — permission-gated tool dispatch
 *
 * ==========  SCENARIO MATRIX  ===============
 *  M1  多会话隔离    — 两个 session 独立历史，互不干扰
 *  M2  会话恢复      — 重启后从 SessionStore 加载历史继续对话
 *  B1  重新生成分支  — regenerate 产生兄弟节点，切换分支
 *  B2  编辑重发分支  — edit_from 产生新分支，variants 可枚举
 *  S1  Skill 加载    — 扫描项目级 SKILL.md，系统提示注入
 *  S2  Skill 调用    — invokeSkill 返回完整 body
 *  S3  Skill 禁用    — 禁用后从系统提示消失
 *  C1  上下文压缩    — 长对话触发 auto-compact，发出事件
 *  C2  工具结果截断  — 超长 tool result 被截断
 *  T1  ToolRouter 集成 — 风险级别拒绝写工具
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  AgentLoop,
  createPersistenceAdapter,
  ContextManager,
  SkillEngine,
  type PersistenceAdapter,
} from '../src/index.js';
import type { AiProvider, AiMessage, StreamChunk, ToolDefinition } from '../src/provider/index.js';
import {
  initDatabase,
  closeConnection,
  runMigrations,
  registerProject,
  createSession,
  appendMessage,
  getSession,
  getMessagePath,
  getMessageChildren,
  getBranchVariants,
  switchBranch,
  listSessions,
  getSessionMessages,
  logToolCall,
} from '@doc77/core';

// ── Mock Provider ──────────────────────────────────────────────

/**
 * Mock AiProvider that plays back scripted stream chunks per turn.
 * Each call to `chatStream()` consumes the next scripted turn.
 * This lets us drive the AgentLoop without a real LLM.
 */
class MockProvider {
  private turns: StreamChunk[][] = [];
  private callIndex = 0;

  /** Script the next LLM response (one "turn"). */
  script(chunks: StreamChunk[]): void {
    this.turns.push(chunks);
  }

  /** Script multiple identical turns at once (for ReAct loops). */
  scriptN(n: number, chunks: StreamChunk[]): void {
    for (let i = 0; i < n; i++) this.turns.push(chunks);
  }

  async *chatStream(): AsyncGenerator<StreamChunk> {
    const chunks = this.turns[this.callIndex] || [{ type: 'done' }];
    this.callIndex++;
    for (const chunk of chunks) {
      await new Promise((r) => setTimeout(r, 1));
      yield chunk;
    }
  }

  async chat(): Promise<{ message: AiMessage; usage?: { prompt_tokens: number; completion_tokens: number } }> {
    // Used by ContextManager.autoCompact — return a canned summary
    return {
      message: { role: 'assistant', content: 'Summary: user discussed files and tools.' },
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }

  get callCount(): number {
    return this.callIndex;
  }

  reset(): void {
    this.callIndex = 0;
    this.turns = [];
  }
}

// ── Test Setup ────────────────────────────────────────────────

let testDir: string;
let dbPath: string;
let projectId: number;
let projDir: string;

beforeEach(async () => {
  testDir = path.join(os.tmpdir(), `doc77-feat-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'data.db');
  projDir = path.join(testDir, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  await initDatabase(dbPath);
  runMigrations();
  projectId = registerProject('FeatE2E', projDir).id;
});

afterEach(async () => {
  try {
    closeConnection();
  } catch {
    /* ignore */
  }
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** Build a real persistence adapter backed by SessionStore. */
function makeRealPersistence(): PersistenceAdapter {
  return createPersistenceAdapter({
    appendMessage: (sessionId, msg) => {
      const rec = appendMessage(sessionId, msg as Parameters<typeof appendMessage>[1]);
      return { id: rec.id };
    },
    getCurrentLeafId: (sessionId) => getSession(sessionId)?.currentLeafId ?? null,
    getMessagePath: (sessionId, leafId) => {
      const records = getMessagePath(sessionId, leafId ?? undefined);
      return records.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        parentId: m.parentId ?? undefined,
        toolCalls: m.toolCalls ?? undefined,
        toolCallId: m.toolCallId ?? undefined,
        toolName: m.toolName ?? undefined,
      })) as unknown as AiMessage[];
    },
    addTokenUsage: () => {
      /* SessionStore tracks via appendMessage; no-op here */
    },
    logToolCall: (entry) => {
      return logToolCall(entry as Parameters<typeof logToolCall>[0]);
    },
  });
}

/** Collect all events from an agent loop run into an array. */
async function collectEvents(gen: AsyncGenerator<{ type: string; [key: string]: unknown }>) {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

const mockTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a directory',
      parameters: { type: 'object', properties: { dir_path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════
//  MULTI-SESSION TESTS
// ═══════════════════════════════════════════════════════════════

describe('E2E: Multi-Session (Phase 2 + 3)', () => {
  it('M1 多会话隔离 — 两个 session 拥有独立历史，互不干扰', async () => {
    const provider = new MockProvider();
    const persistence = makeRealPersistence();

    // Create two sessions
    const sessionA = createSession({ projectId, title: 'Session A', model: 'test' });
    const sessionB = createSession({ projectId, title: 'Session B', model: 'test' });

    // Session A: talk about apples
    provider.script([
      { type: 'token', content: 'Apples are red.' },
      { type: 'done', usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ]);
    const loopA = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test',
      tools: [],
      executeTool: async () => 'ok',
      persistence,
      systemPrompt: 'You are a test bot.',
    });
    await collectEvents(loopA.run(sessionA.id, 'Tell me about apples'));

    // Session B: talk about bananas
    provider.script([
      { type: 'token', content: 'Bananas are yellow.' },
      { type: 'done', usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ]);
    const loopB = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test',
      tools: [],
      executeTool: async () => 'ok',
      persistence,
      systemPrompt: 'You are a test bot.',
    });
    await collectEvents(loopB.run(sessionB.id, 'Tell me about bananas'));

    // Verify session A history mentions apples, not bananas
    const pathA = getMessagePath(sessionA.id);
    expect(pathA.length).toBeGreaterThanOrEqual(2); // user + assistant
    const contentsA = pathA.map((m) => m.content).join(' ');
    expect(contentsA).toMatch(/apple/i);
    expect(contentsA).not.toMatch(/banana/i);

    // Verify session B history mentions bananas, not apples
    const pathB = getMessagePath(sessionB.id);
    expect(pathB.length).toBeGreaterThanOrEqual(2);
    const contentsB = pathB.map((m) => m.content).join(' ');
    expect(contentsB).toMatch(/banana/i);
    expect(contentsB).not.toMatch(/apple/i);

    // Verify both sessions appear in the list
    const sessions = listSessions({ projectId });
    expect(sessions.map((s) => s.id)).toContain(sessionA.id);
    expect(sessions.map((s) => s.id)).toContain(sessionB.id);
  });

  it('M2 会话恢复 — AgentLoop 从 SessionStore 加载历史继续对话', async () => {
    const provider = new MockProvider();
    const persistence = makeRealPersistence();
    const session = createSession({ projectId, title: 'Resume Test', model: 'test' });

    // Turn 1: initial conversation
    provider.script([
      { type: 'token', content: 'Hello from turn 1.' },
      { type: 'done', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    const loop1 = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test',
      tools: [],
      executeTool: async () => 'ok',
      persistence,
      systemPrompt: 'You are a test bot.',
    });
    await collectEvents(loop1.run(session.id, 'Hi there'));

    // Turn 2: a NEW AgentLoop instance loads history from the store
    // The provider should see the prior conversation in its messages.
    provider.script([
      { type: 'token', content: 'I remember you said hi.' },
      { type: 'done', usage: { prompt_tokens: 20, completion_tokens: 6 } },
    ]);
    const loop2 = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test',
      tools: [],
      executeTool: async () => 'ok',
      persistence,
      systemPrompt: 'You are a test bot.',
    });
    await collectEvents(loop2.run(session.id, 'Do you remember what I said?'));

    // The message path should now contain: user1, assistant1, user2, assistant2
    const path = getMessagePath(session.id);
    expect(path.length).toBe(4);
    expect(path[0].role).toBe('user');
    expect(path[0].content).toBe('Hi there');
    expect(path[1].role).toBe('assistant');
    expect(path[1].content).toBe('Hello from turn 1.');
    expect(path[2].role).toBe('user');
    expect(path[2].content).toBe('Do you remember what I said?');
    expect(path[3].role).toBe('assistant');
    expect(path[3].content).toBe('I remember you said hi.');
  });
});

// ═══════════════════════════════════════════════════════════════
//  BRANCHING TESTS
// ═══════════════════════════════════════════════════════════════

describe('E2E: Message Branching (Phase 3 + 5)', () => {
  it('B1 重新生成分支 — regenerate 产生兄弟节点，可切换分支', async () => {
    const provider = new MockProvider();
    const persistence = makeRealPersistence();
    const session = createSession({ projectId, title: 'Branch Test', model: 'test' });

    // Original turn: user asks a question, assistant answers "Answer A"
    provider.script([
      { type: 'token', content: 'Answer A' },
      { type: 'done', usage: { prompt_tokens: 10, completion_tokens: 3 } },
    ]);
    const loop1 = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test',
      tools: [],
      executeTool: async () => 'ok',
      persistence,
      systemPrompt: 'You are a test bot.',
    });
    await collectEvents(loop1.run(session.id, 'What is the answer?'));

    // Verify the path has user + assistant "Answer A"
    let path = getMessagePath(session.id);
    expect(path).toHaveLength(2);
    expect(path[1].content).toBe('Answer A');
    const userMsgId = path[0].id;
    const answerAMsgId = path[1].id;

    // Regenerate: switch leaf back to the user message, then run with skipAppendUser
    switchBranch(session.id, userMsgId);
    provider.script([
      { type: 'token', content: 'Answer B' },
      { type: 'done', usage: { prompt_tokens: 10, completion_tokens: 3 } },
    ]);
    const loop2 = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test',
      tools: [],
      executeTool: async () => 'ok',
      persistence,
      systemPrompt: 'You are a test bot.',
    });
    await collectEvents(loop2.run(session.id, '', { skipAppendUser: true }));

    // Now the user message should have TWO children (Answer A + Answer B)
    const variants = getBranchVariants(answerAMsgId);
    expect(variants.length).toBe(2);
    const contents = variants.map((v) => v.content).sort();
    expect(contents).toEqual(['Answer A', 'Answer B']);

    // The current leaf should be Answer B (the newly generated one)
    path = getMessagePath(session.id);
    expect(path[path.length - 1].content).toBe('Answer B');

    // Switch back to Answer A
    switchBranch(session.id, answerAMsgId);
    path = getMessagePath(session.id);
    expect(path[path.length - 1].content).toBe('Answer A');
  });

  it('B2 编辑重发分支 — 编辑用户消息产生新分支', async () => {
    const persistence = makeRealPersistence();
    const session = createSession({ projectId, title: 'Edit Resend', model: 'test' });

    // Original: user asks "Tell me about X", assistant responds
    const userMsg1 = appendMessage(session.id, {
      role: 'user',
      content: 'Tell me about apples',
      parentId: null,
    });
    appendMessage(session.id, {
      role: 'assistant',
      content: 'Apples are fruits.',
      parentId: userMsg1.id,
    });

    // Edit: create a new user message (sibling of userMsg1) with edited content
    // This simulates the "edit & resend" flow
    const userMsg2 = appendMessage(session.id, {
      role: 'user',
      content: 'Tell me about bananas',
      parentId: null, // sibling of userMsg1 (both are roots under the session)
    });

    // The two user messages should be siblings (children of the session root)
    const rootChildren = getMessageChildren(session.id).filter((m) => m.role === 'user');
    // Note: getMessageChildren(sessionId) returns children of the session's root
    // Since both user messages have parentId = null, they're both root-level
    // Actually parentId null means they hang off the session's implicit root.
    // Let's verify via getSessionMessages that both exist.
    const allMsgs = getSessionMessages(session.id);
    const userMsgs = allMsgs.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs.map((m) => m.content).sort()).toEqual([
      'Tell me about apples',
      'Tell me about bananas',
    ]);

    // Now generate a response for the edited message
    const provider = new MockProvider();
    provider.script([
      { type: 'token', content: 'Bananas are yellow.' },
      { type: 'done', usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ]);
    const loop = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test',
      tools: [],
      executeTool: async () => 'ok',
      persistence,
      systemPrompt: 'You are a test bot.',
    });
    // Switch to userMsg2 as the leaf, then regenerate (skipAppendUser)
    switchBranch(session.id, userMsg2.id);
    await collectEvents(loop.run(session.id, '', { skipAppendUser: true }));

    // The current path should end with the banana response
    const path = getMessagePath(session.id);
    const lastMsg = path[path.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.content).toBe('Bananas are yellow.');
  });
});

// ═══════════════════════════════════════════════════════════════
//  SKILL SYSTEM TESTS
// ═══════════════════════════════════════════════════════════════

describe('E2E: Skill System (Phase 4)', () => {
  it('S1 Skill 加载 — 扫描项目级 SKILL.md 并注入系统提示', async () => {
    // Create a project-level skill
    const skillsDir = path.join(projDir, '.doc77', 'skills', 'test-skill');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'SKILL.md'),
      `---
name: test-skill
description: A test skill for E2E validation
always_apply: false
---

# Test Skill

When invoked, follow these instructions:
1. Check the file
2. Report findings
`,
    );

    // Also create an always_apply skill
    const alwaysDir = path.join(projDir, '.doc77', 'skills', 'always-skill');
    fs.mkdirSync(alwaysDir, { recursive: true });
    fs.writeFileSync(
      path.join(alwaysDir, 'SKILL.md'),
      `---
name: always-skill
description: Always-on context
always_apply: true
---

# Always-On Rule

Always respond in Chinese.
`,
    );

    const engine = new SkillEngine();
    await engine.scanSkills(projDir);

    const skills = engine.listSkills();
    expect(skills.length).toBeGreaterThanOrEqual(2);
    expect(skills.map((s) => s.name)).toContain('test-skill');
    expect(skills.map((s) => s.name)).toContain('always-skill');

    // buildSystemPrompt should include:
    // 1. The always_apply skill body
    // 2. The test-skill in the available skills list
    const prompt = engine.buildSystemPrompt('You are a test bot.');
    expect(prompt).toContain('You are a test bot.');
    expect(prompt).toContain('Always respond in Chinese');
    expect(prompt).toContain('test-skill');
    expect(prompt).toContain('A test skill for E2E validation');
  });

  it('S2 Skill 调用 — invokeSkill 返回完整 body', async () => {
    const skillsDir = path.join(projDir, '.doc77', 'skills', 'doc-helper');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'SKILL.md'),
      `---
name: doc-helper
description: Helps with documents
---

# Document Helper

Steps:
1. Read the document
2. Analyze structure
3. Suggest improvements
`,
    );

    const engine = new SkillEngine();
    await engine.scanSkills(projDir);

    const result = await engine.invokeSkill('doc-helper');
    expect(result).toContain('[Skill: doc-helper]');
    expect(result).toContain('Read the document');
    expect(result).toContain('Suggest improvements');
  });

  it('S3 Skill 禁用 — 禁用后从系统提示消失', async () => {
    const skillsDir = path.join(projDir, '.doc77', 'skills', 'toggle-skill');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'SKILL.md'),
      `---
name: toggle-skill
description: Can be toggled
---

# Toggle Me

Do something specific.
`,
    );

    const engine = new SkillEngine();
    await engine.scanSkills(projDir);

    // Initially visible in system prompt
    let prompt = engine.buildSystemPrompt('Base prompt.');
    expect(prompt).toContain('toggle-skill');

    // Disable it
    const disabled = engine.setSkillEnabled('toggle-skill', false);
    expect(disabled).toBe(true);

    // Now it should NOT appear in the available skills list
    prompt = engine.buildSystemPrompt('Base prompt.');
    expect(prompt).not.toContain('toggle-skill');

    // Re-enable
    engine.setSkillEnabled('toggle-skill', true);
    prompt = engine.buildSystemPrompt('Base prompt.');
    expect(prompt).toContain('toggle-skill');
  });

  it('S4 Skill 不存在 — invokeSkill 返回错误信息', async () => {
    const engine = new SkillEngine();
    await engine.scanSkills(projDir);

    const result = await engine.invokeSkill('nonexistent-skill');
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });
});

// ═══════════════════════════════════════════════════════════════
//  CONTEXT COMPRESSION TESTS
// ═══════════════════════════════════════════════════════════════

describe('E2E: Context Compression (Phase 3)', () => {
  it('C1 上下文压缩 — 长对话触发 auto-compact', async () => {
    const provider = new MockProvider();
    const persistence = makeRealPersistence();
    const session = createSession({ projectId, title: 'Compact Test', model: 'test' });

    // Build a conversation with many long messages to exceed the threshold.
    // We use a small contextWindow (500 tokens) so compression triggers easily.
    const contextManager = new ContextManager(provider as unknown as AiProvider, 'test-model');

    // Script a simple response for the actual agent turn
    provider.script([
      { type: 'token', content: 'Done.' },
      { type: 'done', usage: { prompt_tokens: 10, completion_tokens: 1 } },
    ]);

    const loop = new AgentLoop({
      provider: provider as unknown as AiProvider,
      model: 'test',
      tools: [],
      executeTool: async () => 'ok',
      persistence,
      systemPrompt: 'You are a test bot.',
      contextManager,
      contextWindow: 500, // very small to trigger compression
    });

    // Pre-populate the session with a long history (simulating prior turns)
    const longContent = 'A'.repeat(2000); // ~500 tokens per message
    let lastParentId: string | null = null;
    for (let i = 0; i < 5; i++) {
      const userMsg = appendMessage(session.id, {
        role: 'user',
        content: `Question ${i}: ${longContent}`,
        parentId: lastParentId,
      });
      const asstMsg = appendMessage(session.id, {
        role: 'assistant',
        content: `Answer ${i}: ${longContent}`,
        parentId: userMsg.id,
      });
      lastParentId = asstMsg.id;
    }

    // Now run the loop — it should load the long history, detect it exceeds
    // 70% of 500 tokens, and trigger auto-compact.
    const events = await collectEvents(loop.run(session.id, 'Final question'));

    // A context_compacted event should have been emitted
    const compactedEvent = events.find((e) => e.type === 'context_compacted');
    expect(compactedEvent).toBeTruthy();
    if (compactedEvent) {
      expect((compactedEvent as { compactedCount: number }).compactedCount).toBeGreaterThan(0);
    }
  });

  it('C2 工具结果截断 — compact() 将超长 tool result 截断到预算内', async () => {
    // The truncation happens inside ContextManager.compact() when preparing
    // messages for the next API call — the raw tool_result event carries the
    // full output, but the messages sent to the LLM are truncated.
    // Here we verify the integration: a realistic message array with an
    // oversized tool result gets truncated by the compact pipeline.
    const provider = new MockProvider();
    const cm = new ContextManager(provider as unknown as AiProvider, 'test-model');

    // Build a realistic message array: system, user, assistant(tool_call), tool(huge)
    const hugeContent = 'B'.repeat(20000); // ~5000 tokens, well over the 2000 default
    const messages: AiMessage[] = [
      { role: 'system', content: 'You are a test bot.' },
      { role: 'user', content: 'List all files' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'list_files', arguments: '{"dir_path":"/"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'tc1', content: hugeContent },
    ];

    const result = await cm.compact(messages, {
      maxTokens: 8192,
      maxToolResultTokens: 2000, // default budget
    });

    // Find the tool message in the result
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    // The tool content should be shorter than the original 20000 chars
    expect(toolMsg!.content.length).toBeLessThan(hugeContent.length);
    // And should contain the truncation notice
    expect(toolMsg!.content).toMatch(/truncated/i);
    // The original char count should be referenced in the notice
    expect(toolMsg!.content).toContain('20000');
  });
});

// ═══════════════════════════════════════════════════════════════
//  TOOLROUTER INTEGRATION TEST
// ═══════════════════════════════════════════════════════════════

describe('E2E: ToolRouter Integration (Phase 6)', () => {
  it('T1 风险级别拒绝 — low risk 下 write_file 被拒绝，返回错误信息', async () => {
    // Import ToolRouter from @doc77/mcp
    const { ToolRouter, TOOL_ANNOTATIONS } = await import('@doc77/mcp');

    const router = new ToolRouter({
      isSensitiveFile: (name: string) => name === '.env',
      getRiskLevel: () => 'low', // low risk — should block write tools
    });

    // Register a write handler that should NEVER be called
    let handlerCalled = false;
    router.register('write_file', async () => {
      handlerCalled = true;
      return 'should not reach';
    });

    const result = await router.execute(
      'write_file',
      { file_path: 'test.txt', content: 'hi' },
      { projectId: 1, sessionId: 'test' },
    );

    // The call should be denied due to risk level
    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.denialReason).toBe('risk_level');
    expect(handlerCalled).toBe(false);
    expect(result.output).toMatch(/risk/i);

    // Verify annotation metadata is correct
    const annotation = TOOL_ANNOTATIONS['write_file'];
    expect(annotation).toBeDefined();
    expect(annotation.permission).toBe('write');
    expect(annotation.riskLevelRequired).toBe('high');
  });

  it('T2 敏感文件拒绝 — 操作 .env 被拒绝', async () => {
    const { ToolRouter } = await import('@doc77/mcp');

    const router = new ToolRouter({
      isSensitiveFile: (name: string) => name === '.env',
      getRiskLevel: () => 'high', // high risk — would normally allow writes
    });

    let handlerCalled = false;
    router.register('move_file', async () => {
      handlerCalled = true;
      return 'ok';
    });

    const result = await router.execute(
      'move_file',
      { source: '.env', target: 'backup.env' },
      { projectId: 1, sessionId: 'test' },
    );

    // The call should be denied due to sensitive file
    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.denialReason).toBe('sensitive_file');
    expect(handlerCalled).toBe(false);
  });

  it('T3 读工具并发批量执行 — 多个 read 工具并发运行', async () => {
    const { ToolRouter } = await import('@doc77/mcp');

    const router = new ToolRouter({
      isSensitiveFile: () => false,
      getRiskLevel: () => 'low',
    });

    const executionOrder: string[] = [];
    // Register read handlers with artificial delay to verify concurrency
    router.registerAll({
      list_files: async () => {
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push('list_files');
        return 'dir1/';
      },
      read_file: async () => {
        await new Promise((r) => setTimeout(r, 30));
        executionOrder.push('read_file');
        return 'content';
      },
      get_file_info: async () => {
        await new Promise((r) => setTimeout(r, 40));
        executionOrder.push('get_file_info');
        return 'info';
      },
    });

    const calls = [
      { id: '1', name: 'list_files', args: { dir_path: '/' } },
      { id: '2', name: 'read_file', args: { file_path: 'a.txt' } },
      { id: '3', name: 'get_file_info', args: { file_path: 'b.txt' } },
    ];

    const t0 = Date.now();
    const results = await router.executeBatch(calls, { projectId: 1, sessionId: 'test' });
    const elapsed = Date.now() - t0;

    // All should succeed
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);

    // Results should be in the same order as input (order preservation)
    expect(results[0].toolName).toBe('list_files');
    expect(results[1].toolName).toBe('read_file');
    expect(results[2].toolName).toBe('get_file_info');

    // Since read tools run concurrently (max 50ms each), total should be
    // well under the serial sum (50+30+40=120ms). Allow generous margin.
    expect(elapsed).toBeLessThan(120);
  });
});
