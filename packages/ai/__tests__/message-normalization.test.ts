import { describe, it, expect } from 'vitest';
import { normalizeMessages, type AiMessage } from '../src/provider/index.js';

/** Shortcut — build an AiMessage with role + content only (no tool fields). */
function msg(role: AiMessage['role'], content: string): AiMessage {
  return { role, content };
}

describe('normalizeMessages', () => {
  it('returns the array unchanged when there is a single system message', () => {
    const messages = [
      msg('system', 'You are a helpful assistant.'),
      msg('user', 'Hello'),
    ];
    const result = normalizeMessages(messages);
    // same reference — zero-allocation path
    expect(result).toBe(messages);
    expect(result).toEqual(messages);
  });

  it('merges two consecutive system messages into one', () => {
    const messages = [
      msg('system', 'Prompt A'),
      msg('system', 'Prompt B'),
      msg('user', 'Hello'),
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: 'system',
      content: 'Prompt A\n\nPrompt B',
    });
    expect(result[1]).toEqual(msg('user', 'Hello'));
  });

  it('merges separated system messages and moves the merged one to the front', () => {
    const messages = [
      msg('system', 'Prompt A'),
      msg('user', 'First question'),
      msg('assistant', 'First answer'),
      msg('system', '[Context] Project info'),
      msg('user', 'Second question'),
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      role: 'system',
      content: 'Prompt A\n\n[Context] Project info',
    });
    expect(result[1]).toEqual(msg('user', 'First question'));
    expect(result[2]).toEqual(msg('assistant', 'First answer'));
    expect(result[3]).toEqual(msg('user', 'Second question'));
  });

  it('returns the array unchanged when there are no system messages', () => {
    const messages = [
      msg('user', 'Hello'),
      msg('assistant', 'Hi!'),
    ];
    const result = normalizeMessages(messages);
    expect(result).toBe(messages);
  });

  it('preserves tool messages and their tool_call_id', () => {
    const toolMsg: AiMessage = {
      role: 'tool',
      tool_call_id: 'call_abc123',
      content: 'file contents here',
    };
    const messages: AiMessage[] = [
      msg('system', 'System prompt'),
      msg('user', 'Read a file'),
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_abc123',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"/x"}' },
          },
        ],
      },
      toolMsg,
      msg('system', '[Context] Extra info'),
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      role: 'system',
      content: 'System prompt\n\n[Context] Extra info',
    });
    // tool message preserved with its tool_call_id intact
    expect(result[3]).toEqual(toolMsg);
    expect(result[3].tool_call_id).toBe('call_abc123');
  });
});
