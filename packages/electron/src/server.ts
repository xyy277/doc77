/**
 * Doc77 Electron — Server lifecycle manager
 * Starts the core Express app in-process so Electron stays a thin desktop shell.
 */
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as http from 'http';

const DB_PATH = path.join(os.homedir(), '.doc77', 'data.db');

interface CoreModule {
  closeConnection: () => void;
  createApp: (
    restartCallback?: () => void,
    bindAddr?: string,
    port?: number,
  ) => http.RequestListener;
  initDatabase: (filePath: string) => Promise<unknown>;
  loadDefaults: () => void;
  runMigrations: () => void;
}

async function loadCore(): Promise<CoreModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<CoreModule>;
  return dynamicImport('@doc77/core');
}

/** Find an available port starting from `start`, up to `start + 99`. */
export function findAvailablePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    function tryPort(port: number) {
      if (port >= start + 100) return reject(new Error('No available port in range'));
      const server = net.createServer();
      server.listen(port, '127.0.0.1');
      server.on('listening', () => {
        server.close();
        resolve(port);
      });
      server.on('error', () => tryPort(port + 1));
    }
    tryPort(start);
  });
}

export interface ServerProcess {
  server: http.Server;
  port: number;
  kill: () => void;
}

export async function startServer(port: number): Promise<ServerProcess> {
  process.env.DOC77_ELECTRON = '1';

  const { closeConnection, createApp, initDatabase, loadDefaults, runMigrations } =
    await loadCore();

  await initDatabase(DB_PATH);
  runMigrations();
  loadDefaults();

  const app = createApp(undefined, '127.0.0.1', port);
  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        server,
        port,
        kill: () => {
          server.close();
          closeConnection();
        },
      });
    });
  });
}
