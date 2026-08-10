/**
 * TunnelManager — manages tunnel process lifecycle (cloudflared / tailscale / ngrok).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

export type TunnelProvider = 'cloudflare' | 'tailscale' | 'ngrok';
export type TunnelStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface TunnelConfig {
  provider: TunnelProvider;
  enabled: boolean;
  cfToken?: string;
  cfDomain?: string;
  quickTunnel: boolean;
  tsFunnel: boolean;
  localPort: number;
  /** 隧道访问策略：'open' | 'readonly' | 'password'（T3 新增） */
  accessPolicy?: 'open' | 'readonly' | 'password';
  /** T12: password 策略下的访问密码 */
  password?: string;
  /** T12: 允许的设备指纹列表（User-Agent + IP hash），空表示不限制 */
  allowedDevices?: string[];
  /** T12: 隧道 session TTL（分钟，默认 30） */
  sessionTtlMinutes?: number;
}

export interface TunnelInfo {
  provider: TunnelProvider;
  url: string | null;
  status: TunnelStatus;
  startedAt: string | null;
  error: string | null;
}

export class TunnelManager {
  private process: ChildProcess | null = null;
  private info: TunnelInfo = {
    provider: 'cloudflare',
    url: null,
    status: 'stopped',
    startedAt: null,
    error: null,
  };
  private restartCount = 0;
  private maxRestarts = 3;

  getStatus(): TunnelInfo {
    return { ...this.info };
  }

  /** @internal 仅用于测试：强制设置隧道状态，避免启动真实 cloudflared 子进程 */
  __setStatusForTest(status: TunnelStatus): void {
    this.info.status = status;
  }

  async start(config: TunnelConfig): Promise<TunnelInfo> {
    if (this.process) {
      await this.stop();
    }

    this.info = {
      provider: config.provider,
      url: null,
      status: 'starting',
      startedAt: new Date().toISOString(),
      error: null,
    };

    try {
      if (config.provider === 'cloudflare') {
        await this.startCloudflare(config);
      } else if (config.provider === 'ngrok') {
        await this.startNgrok(config);
      } else if (config.provider === 'tailscale') {
        await this.startTailscale(config);
      }
    } catch (e: unknown) {
      this.info.status = 'error';
      this.info.error = e instanceof Error ? e.message : 'Failed to start tunnel';
    }

    return this.getStatus();
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      // Force kill after 5s
      const proc = this.process;
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 5000);
      this.process = null;
    }
    this.info.status = 'stopped';
    this.info.url = null;
    this.restartCount = 0;
  }

  private async startCloudflare(config: TunnelConfig): Promise<void> {
    const bin = await this.findBinary('cloudflared');
    if (!bin) {
      throw new Error(
        'cloudflared not found. Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
      );
    }

    let args: string[];
    if (config.quickTunnel || !config.cfToken) {
      // Quick tunnel (temporary trycloudflare.com URL)
      args = ['tunnel', '--url', `http://localhost:${config.localPort}`, '--no-autoupdate'];
    } else {
      // Named tunnel with token
      args = ['tunnel', 'run', '--token', config.cfToken, '--no-autoupdate'];
    }

    this.process = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Parse URL from stderr (cloudflared outputs to stderr)
    const onData = (data: Buffer) => {
      const text = data.toString();
      // Quick tunnel URL pattern: https://xxx-yyy-zzz.trycloudflare.com
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !this.info.url) {
        this.info.url = match[0];
        this.info.status = 'running';
      }
      // Named tunnel: just mark as running
      if (text.includes('Registered tunnel connection') || text.includes('Connection registered')) {
        this.info.status = 'running';
        if (config.cfDomain) this.info.url = `https://${config.cfDomain}`;
      }
    };

    this.process.stderr?.on('data', onData);
    this.process.stdout?.on('data', onData);

    this.process.on('exit', (code) => {
      if (this.info.status === 'running' && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        setTimeout(() => this.startCloudflare(config).catch(() => {}), 3000);
      } else if (code !== 0 && code !== null) {
        this.info.status = 'error';
        this.info.error = `cloudflared exited with code ${code}`;
      }
    });

    // Wait a bit for URL to appear
    await new Promise((r) => setTimeout(r, 3000));
    if (this.info.status === 'starting') {
      this.info.status = 'running'; // Assume running if no error
    }
  }

  private async startNgrok(config: TunnelConfig): Promise<void> {
    const bin = await this.findBinary('ngrok');
    if (!bin) {
      throw new Error('ngrok not found. Install: https://ngrok.com/download');
    }

    this.process = spawn(bin, ['http', String(config.localPort), '--log=stdout'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onData = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/url=https:\/\/[^\s]+/);
      if (match && !this.info.url) {
        this.info.url = match[0].replace('url=', '');
        this.info.status = 'running';
      }
    };

    this.process.stdout?.on('data', onData);
    this.process.stderr?.on('data', onData);
    this.process.on('exit', () => {
      this.info.status = 'stopped';
    });

    await new Promise((r) => setTimeout(r, 3000));
  }

  private async startTailscale(config: TunnelConfig): Promise<void> {
    const bin = await this.findBinary('tailscale');
    if (!bin) {
      throw new Error('tailscale not found. Install: https://tailscale.com/download');
    }

    if (config.tsFunnel) {
      this.process = spawn(bin, ['funnel', '--bg', String(config.localPort)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // Just report the tailscale IP
      this.info.status = 'running';
      this.info.url = '(Use Tailscale IP or MagicDNS hostname)';
      return;
    }

    const onData = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[^\s]+\.ts\.net/);
      if (match) {
        this.info.url = match[0];
        this.info.status = 'running';
      }
    };

    this.process.stdout?.on('data', onData);
    this.process.stderr?.on('data', onData);
    await new Promise((r) => setTimeout(r, 2000));
  }

  private async findBinary(name: string): Promise<string | null> {
    // 1. Check ~/.doc77/bin/
    const localBin = path.join(
      os.homedir(),
      '.doc77',
      'bin',
      name + (process.platform === 'win32' ? '.exe' : ''),
    );
    if (fs.existsSync(localBin)) return localBin;

    // 2. Check PATH
    try {
      const { execFileSync } = await import('node:child_process');
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const result = execFileSync(cmd, [name], { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result) return result.split('\n')[0].trim();
    } catch {}

    return null;
  }
}

/** Singleton */
let _manager: TunnelManager | null = null;
export function getTunnelManager(): TunnelManager {
  if (!_manager) _manager = new TunnelManager();
  return _manager;
}
