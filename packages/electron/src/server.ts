/**
 * Doc77 Electron — Server lifecycle manager
 * Finds the CLI entry, spawns Express server as child process, monitors health.
 */
import * as path from 'path';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';

/** Resolve CLI entry path (dev: workspace link, prod: extraResource). */
export function getCliEntryPath(): string {
  try {
    return require.resolve('@doc77/cli/dist/bin/doc77.js');
  } catch {
    return path.join(process.resourcesPath, 'cli', 'dist', 'bin', 'doc77.js');
  }
}

/** Find an available port starting from `start`, up to `start + 99`. */
export function findAvailablePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    function tryPort(port: number) {
      if (port >= start + 100) return reject(new Error('No available port in range'));
      const server = net.createServer();
      server.listen(port, '127.0.0.1');
      server.on('listening', () => { server.close(); resolve(port); });
      server.on('error', () => tryPort(port + 1));
    }
    tryPort(start);
  });
}

export interface ServerProcess {
  child: ChildProcess;
  port: number;
  kill: () => void;
}

/** Spawn Doc77 Express server. Resolves when 'Dashboard:' is printed. */
export function startServer(port: number): Promise<ServerProcess> {
  return new Promise((resolve, reject) => {
    const cliEntry = getCliEntryPath();
    const child = spawn(
      process.execPath,
      [cliEntry, 'start', '--port', String(port)],
      {
        env: { ...process.env, DOC77_ELECTRON: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Server startup timed out (30s)'));
    }, 30000);

    let started = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (!started && chunk.toString().includes('Dashboard:')) {
        started = true;
        clearTimeout(timeout);
        resolve({
          child,
          port,
          kill: () => { try { child.kill(); } catch {} },
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Server process exited early (code ${code})`));
      }
    });
  });
}
