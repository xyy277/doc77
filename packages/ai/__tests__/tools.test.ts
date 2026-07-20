import { describe, it, expect, beforeAll } from 'vitest';
import { initI18n } from '@doc77/core';
import { getReadTools, getWriteTools } from '../src/index.js';

beforeAll(() => {
  initI18n('zh-CN');
});

describe('getWriteTools', () => {
  it('exports the write tools in a stable order', () => {
    const tools = getWriteTools();
    const names = tools.map((t) => t.function.name);
    expect(names).toEqual(['write_file', 'move_file', 'create_folder', 'delete_file', 'batch_operations']);
  });

  it('each tool is a valid OpenAI function-calling schema', () => {
    for (const t of getWriteTools()) {
      expect(t.type).toBe('function');
      expect(typeof t.function.name).toBe('string');
      expect(typeof t.function.description).toBe('string');
      expect(t.function.parameters).toHaveProperty('properties');
      expect(t.function.parameters).toHaveProperty('required');
    }
  });

  it('descriptions state that approval is required', () => {
    for (const t of getWriteTools()) {
      expect(t.function.description).toMatch(/审批/);
    }
  });

  it('does not collide with read tool names', () => {
    const readNames = new Set(getReadTools().map((t) => t.function.name));
    for (const t of getWriteTools()) {
      expect(readNames.has(t.function.name)).toBe(false);
    }
  });
});
