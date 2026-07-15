import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initDatabase, closeConnection, runMigrations } from '../src/index.js';
import { saveAiSession, loadAiSession, deleteAiSession } from '../src/db/ai-sessions.js';

describe('AI chat session store (SQLite)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `doc77-aisess-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    await initDatabase(path.join(testDir, 'data.db'));
    runMigrations();
  });

  afterEach(() => {
    try {
      closeConnection();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('saves and loads a conversation, preserving messages and project id', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你好' },
    ];
    saveAiSession('sess-1', 42, messages);
    const loaded = loadAiSession('sess-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.projectId).toBe(42);
    expect(loaded!.messages).toEqual(messages);
  });

  it('upserts on the same session_id (latest wins)', () => {
    saveAiSession('sess-2', 1, [{ role: 'user', content: 'a' }]);
    saveAiSession('sess-2', 1, [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    expect(loadAiSession('sess-2')!.messages).toHaveLength(2);
  });

  it('returns null for an unknown session', () => {
    expect(loadAiSession('nope')).toBeNull();
  });

  it('deletes a session', () => {
    saveAiSession('sess-3', 1, [{ role: 'user', content: 'x' }]);
    deleteAiSession('sess-3');
    expect(loadAiSession('sess-3')).toBeNull();
  });
});
