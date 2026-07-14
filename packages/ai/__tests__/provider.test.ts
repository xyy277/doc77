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
});
