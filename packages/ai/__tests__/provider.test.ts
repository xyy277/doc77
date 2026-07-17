import { describe, it, expect, vi, afterEach } from 'vitest';
import { AiProvider } from '../src/provider/index.js';

/** Build a fake fetch Response whose body streams the given SSE chunks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

describe('AiProvider.chatStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses SSE token deltas and emits tokens then done', async () => {
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const provider = new AiProvider({ apiKey: 'k', baseUrl: 'http://x', model: 'm' });
    let text = '';
    let sawDone = false;
    for await (const chunk of provider.chatStream({ model: 'm', messages: [] })) {
      if (chunk.type === 'token') text += chunk.content;
      if (chunk.type === 'done') sawDone = true;
    }
    expect(text).toBe('Hello world');
    expect(sawDone).toBe(true);
  });

  it('yields an error chunk on non-ok HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      async () => ({ ok: false, status: 500, text: async () => 'boom' }) as unknown as Response,
    );

    const provider = new AiProvider({ apiKey: 'k', baseUrl: 'http://x', model: 'm' });
    const chunks = [];
    for await (const chunk of provider.chatStream({ model: 'm', messages: [] })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('error');
    expect((chunks[0] as { message: string }).message).toContain('500');
  });

  it('emits a tool_call_start (name only) as soon as the tool name is known, before done', async () => {
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"list_files","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"dir_path\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const provider = new AiProvider({ apiKey: 'k', baseUrl: 'http://x', model: 'm' });
    const kinds: string[] = [];
    let startName = '';
    let finalArgs = '';
    for await (const chunk of provider.chatStream({ model: 'm', messages: [] })) {
      kinds.push(chunk.type);
      if (chunk.type === 'tool_call_start') startName = chunk.name;
      if (chunk.type === 'tool_call') finalArgs = chunk.arguments;
    }
    // start appears, and it comes before the final tool_call and before done
    expect(startName).toBe('list_files');
    expect(kinds.indexOf('tool_call_start')).toBeLessThan(kinds.indexOf('tool_call'));
    expect(kinds.indexOf('tool_call_start')).toBeLessThan(kinds.indexOf('done'));
    // the final tool_call still carries the fully accumulated arguments
    expect(finalArgs).toBe('{"dir_path":""}');
    // only one start per tool call
    expect(kinds.filter((k) => k === 'tool_call_start')).toHaveLength(1);
  });
});
