import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';
import { DocAgent } from '../src/agent/index.js';
import type {
  AiProvider,
  AiCompletionRequest,
  StreamChunk,
  ToolDefinition,
} from '../src/provider/index.js';

const DUMMY_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: { name: 'list_files', description: 'list', parameters: { type: 'object' } },
  },
];

/** Fake provider that records the tools passed to each chatStream request. */
function makeRecordingProvider() {
  const seenTools: Array<ToolDefinition[] | undefined> = [];
  const provider = {
    async *chatStream(request: AiCompletionRequest): AsyncGenerator<StreamChunk> {
      seenTools.push(request.tools);
      yield { type: 'token', content: 'ok' };
      yield { type: 'done' };
    },
  } as unknown as AiProvider;
  return { provider, seenTools };
}

describe('@doc77/ai', () => {
  it('should export VERSION', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('DocAgent.chatStream tool gating', () => {
  it('passes tools to the provider by default', async () => {
    const { provider, seenTools } = makeRecordingProvider();
    const agent = new DocAgent({ provider, tools: DUMMY_TOOLS });
    for await (const _ of agent.chatStream('hi')) {
      /* drain */
    }
    expect(seenTools[0]).toEqual(DUMMY_TOOLS);
  });

  it('omits tools when called with noTools, disabling the ReAct loop', async () => {
    const { provider, seenTools } = makeRecordingProvider();
    const agent = new DocAgent({ provider, tools: DUMMY_TOOLS });
    for await (const _ of agent.chatStream('summarize this', { noTools: true })) {
      /* drain */
    }
    expect(seenTools[0]).toBeUndefined();
  });
});
