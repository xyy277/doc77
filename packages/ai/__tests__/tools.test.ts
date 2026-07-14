import { describe, it, expect } from 'vitest';
import { READ_TOOLS, WRITE_TOOLS } from '../src/index.js';

describe('WRITE_TOOLS', () => {
  it('exports the four write tools in a stable order', () => {
    const names = WRITE_TOOLS.map((t) => t.function.name);
    expect(names).toEqual(['move_file', 'create_folder', 'delete_file', 'batch_operations']);
  });

  it('each tool is a valid OpenAI function-calling schema', () => {
    for (const t of WRITE_TOOLS) {
      expect(t.type).toBe('function');
      expect(typeof t.function.name).toBe('string');
      expect(typeof t.function.description).toBe('string');
      expect(t.function.parameters).toHaveProperty('properties');
      expect(t.function.parameters).toHaveProperty('required');
    }
  });

  it('descriptions state that approval is required', () => {
    for (const t of WRITE_TOOLS) {
      expect(t.function.description).toMatch(/审批/);
    }
  });

  it('does not collide with READ_TOOLS names', () => {
    const readNames = new Set(READ_TOOLS.map((t) => t.function.name));
    for (const t of WRITE_TOOLS) {
      expect(readNames.has(t.function.name)).toBe(false);
    }
  });
});
