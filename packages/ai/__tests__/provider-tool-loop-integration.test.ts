/**
 * Integration: AgentLoop × real AiProvider with mocked fetch.
 *
 * Verifies the wire format of the SECOND API call in a tool-call loop —
 * regression guard for the 400 error:
 *   "Messages with role 'tool' must be a response to a preceding message
 *    with 'tool_calls'"
 * seen against DeepSeek when the assistant(tool_calls) message was missing
 * or misplaced.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop } from '../src/agent/loop.js';
import { AiProvider, type ToolDefinition } from '../src/provider/index.js';

function sseResponse(chunks: string[]): Response {
  const body = chunks.map((c) => 'data: ' + c + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files',
      parameters: { type: 'object', properties: { dir_path: { type: 'string' } } },
    },
  },
];

describe('AgentLoop tool loop — wire format of step 2', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('assistant(tool_calls) precedes tool messages and ids match', async () => {
    const fetchMock = vi.fn();
    // Turn 1: DeepSeek-style streaming tool_calls (id on first delta only,
    // arguments fragmented across deltas)
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        JSON.stringify({
          id: '1',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'list_files', arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        JSON.stringify({
          id: '1',
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"dir_path":"/"}' } }] },
              finish_reason: null,
            },
          ],
        }),
        JSON.stringify({ id: '1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ]),
    );
    // Turn 2: final answer
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        JSON.stringify({
          id: '2',
          choices: [{ delta: { content: 'Found 3 files.' }, finish_reason: null }],
        }),
        JSON.stringify({ id: '2', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AiProvider({ apiKey: 'test', baseUrl: 'http://mock', model: 'test' });
    const loop = new AgentLoop({
      provider,
      model: 'test',
      tools,
      executeTool: async () => 'file1.txt\nfile2.txt',
    });

    const events: unknown[] = [];
    for await (const e of loop.run('s1', 'List files')) events.push(e);

    expect(fetchMock.mock.calls.length).toBe(2);
    const body2 = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string) as {
      messages: Array<Record<string, unknown>>;
    };
    const msgs = body2.messages;

    // ── Core regression assertions ──
    const aiIdx = msgs.findIndex(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.tool_calls) &&
        (m.tool_calls as unknown[]).length > 0,
    );
    const toolIdx = msgs.findIndex((m) => m.role === 'tool');
    expect(aiIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThan(aiIdx);

    const assistant = msgs[aiIdx] as { tool_calls: Array<{ id: string }> };
    const toolMsg = msgs[toolIdx] as { tool_call_id: string };
    expect(toolMsg.tool_call_id).toBe(assistant.tool_calls[0].id);
    expect(toolMsg.tool_call_id).toBe('call_abc');
  });

  it('null/empty tool_call id from provider is replaced with stable fallback (SiliconFlow-style)', async () => {
    const fetchMock = vi.fn();
    // Turn 1: tool_calls stream WITHOUT an id on any delta (id: null),
    // arguments fragmented — known DeepSeek/SiliconFlow behaviour.
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        JSON.stringify({
          id: '1',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: null,
                    type: 'function',
                    function: { name: 'list_files', arguments: null },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        JSON.stringify({
          id: '1',
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"dir_path":"/"}' } }] },
              finish_reason: null,
            },
          ],
        }),
        JSON.stringify({ id: '1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ]),
    );
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        JSON.stringify({
          id: '2',
          choices: [{ delta: { content: 'Done.' }, finish_reason: null }],
        }),
        JSON.stringify({ id: '2', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AiProvider({ apiKey: 'test', baseUrl: 'http://mock', model: 'test' });
    const loop = new AgentLoop({
      provider,
      model: 'test',
      tools,
      executeTool: async () => 'ok',
    });

    const events: unknown[] = [];
    for await (const e of loop.run('s2', 'List files')) events.push(e);

    expect(fetchMock.mock.calls.length).toBe(2);
    const body2 = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string) as {
      messages: Array<Record<string, unknown>>;
    };
    const msgs = body2.messages;
    const aiIdx = msgs.findIndex(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.tool_calls) &&
        (m.tool_calls as unknown[]).length > 0,
    );
    const toolIdx = msgs.findIndex((m) => m.role === 'tool');
    expect(aiIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThan(aiIdx);
    const assistant = msgs[aiIdx] as { tool_calls: Array<{ id: string }> };
    const toolMsg = msgs[toolIdx] as { tool_call_id: string };
    // Fallback id must be stable and non-empty, and both sides must match.
    expect(assistant.tool_calls[0].id).toMatch(/^call_\d+$/);
    expect(toolMsg.tool_call_id).toBe(assistant.tool_calls[0].id);
  });
});
