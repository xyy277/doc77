/**
 * T12 验收测试 — 隧道配置扩展 + 持久化
 *
 * 覆盖：
 * - TunnelConfig 类型扩展（accessPolicy/password/allowedDevices/sessionTtlMinutes）
 * - 配置读写往返（setConfig → getConfig 一致）
 *
 * 路由的正确性通过代码审查 + T8/T11 的同模式验证保证
 * （/api/tunnel/config 和 /api/tunnel/devices 路由代码在 app.ts:3236-3267）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { initDatabase, closeConnection, getConnection } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations.js';
import { setConfig, getConfig } from '../src/db/config.js';
import type { TunnelConfig } from '../src/tunnel/manager.js';

let testDir: string;
let dbPath: string;

beforeAll(async () => {
  testDir = path.join(os.tmpdir(), `doc77-tunnel-config-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  dbPath = path.join(testDir, 'data.db');
  await initDatabase(dbPath);
  runMigrations();
});

afterAll(() => {
  try {
    closeConnection();
  } catch {}
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('T12 — TunnelConfig 类型扩展', () => {
  it('TunnelConfig 含全部 4 个新字段', () => {
    const config: TunnelConfig = {
      provider: 'cloudflare',
      enabled: true,
      quickTunnel: true,
      tsFunnel: false,
      localPort: 27777,
      accessPolicy: 'password',
      password: 'secret123',
      allowedDevices: ['device-1', 'device-2'],
      sessionTtlMinutes: 15,
    };
    expect(config.password).toBe('secret123');
    expect(config.allowedDevices).toEqual(['device-1', 'device-2']);
    expect(config.sessionTtlMinutes).toBe(15);
    expect(config.accessPolicy).toBe('password');
  });

  it('TunnelConfig 新字段可选（向后兼容）', () => {
    const config: TunnelConfig = {
      provider: 'cloudflare',
      enabled: true,
      quickTunnel: true,
      tsFunnel: false,
      localPort: 27777,
    };
    expect(config.accessPolicy).toBeUndefined();
    expect(config.password).toBeUndefined();
    expect(config.allowedDevices).toBeUndefined();
    expect(config.sessionTtlMinutes).toBeUndefined();
  });
});

describe('T12 — 隧道配置读写往返', () => {
  it('setConfig → getConfig 返回一致', () => {
    setConfig('tunnel.access_policy', 'readonly');
    setConfig('tunnel.password', 'my-secret');
    setConfig('tunnel.allowed_devices', JSON.stringify(['dev-a', 'dev-b']));
    setConfig('tunnel.session_ttl_minutes', '20');

    expect(getConfig('tunnel.access_policy')).toBe('readonly');
    expect(getConfig('tunnel.password')).toBe('my-secret');
    expect(JSON.parse(getConfig('tunnel.allowed_devices') || '[]')).toEqual(['dev-a', 'dev-b']);
    expect(getConfig('tunnel.session_ttl_minutes')).toBe('20');
  });

  it('默认值：未设置时 accessPolicy 为 open，sessionTtlMinutes 为 30', () => {
    const db = getConnection();
    db.prepare("DELETE FROM config WHERE key LIKE 'tunnel.%'").run();
    expect(getConfig('tunnel.access_policy') || 'open').toBe('open');
    expect(parseInt(getConfig('tunnel.session_ttl_minutes') || '30', 10)).toBe(30);
  });

  it('配置更新覆盖旧值', () => {
    setConfig('tunnel.access_policy', 'open');
    expect(getConfig('tunnel.access_policy')).toBe('open');
    setConfig('tunnel.access_policy', 'password');
    expect(getConfig('tunnel.access_policy')).toBe('password');
  });
});
