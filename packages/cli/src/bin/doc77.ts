#!/usr/bin/env node
/**
 * Doc77 CLI — 命令行入口
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as readline from 'node:readline';
import {
  initDatabase,
  closeConnection,
  getConnection,
  runMigrations,
  getConfig,
  setConfig,
  listConfig,
  registerProject,
  resolveProjectPath,
  loadDefaults,
  listProjects,
  removeProject,
  updateProject,
  discoverProjects,
  t,
  initI18n,
} from '@doc77/core';

import { VERSION } from '../version.gen.js';
const DB_PATH = path.join(os.homedir(), '.doc77', 'data.db');

// Phase 1 i18n init: detect system locale before DB is available
initI18n('');

// Module availability — checked at startup, cached for session
let mcpAvailable = false;
let aiAvailable = false;
let translateAvailable = false;
async function detectModules() {
  try {
    await import('@doc77/mcp');
    mcpAvailable = true;
  } catch {}
  try {
    await import('@doc77/ai');
    aiAvailable = true;
  } catch {}
  try {
    const { isEngineAvailable } = await import('@doc77/core');
    translateAvailable = await isEngineAvailable();
  } catch {}
}
async function tryGetMcp(names: string[]): Promise<Record<string, any> | null> {
  if (!mcpAvailable) return null;
  try {
    const mcp = await import('@doc77/mcp');
    const result: Record<string, any> = {};
    for (const name of names) result[name] = (mcp as any)[name];
    return result;
  } catch {
    return null;
  }
}

async function init() {
  await initDatabase(DB_PATH);
  runMigrations();
  loadDefaults();
  // Phase 2 i18n init: use DB-persisted locale config
  initI18n(getConfig('locale.language') || '');
}

/** Read a password from stdin without echoing. */
function askPassword(prompt: string = t('cli.password.prompt')): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Use stdin raw mode to hide echo (not perfect but works)
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    let password = '';
    process.stdout.write(prompt + ': ');
    stdin.on('data', (chunk: Buffer) => {
      const char = chunk.toString();
      if (char === '\r' || char === '\n') {
        stdin.setRawMode(false);
        process.stdout.write('\n');
        rl.close();
        stdin.removeAllListeners('data');
        resolve(password);
        return;
      }
      if (char === '') {
        // Ctrl+C
        process.exit(1);
      }
      if (char === '') {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      password += char;
      process.stdout.write('*');
    });
  });
}

/** Set password via CLI command. */
async function setPasswordInteractive(): Promise<void> {
  const pwd = await askPassword(t('cli.password.promptNew'));
  if (pwd.length < 6) {
    console.error(t('cli.password.tooShort'));
    process.exit(1);
  }
  const confirm = await askPassword(t('cli.password.promptConfirm'));
  if (pwd !== confirm) {
    console.error(t('cli.password.mismatch'));
    process.exit(1);
  }
  const { setupPasswordWithDEK } = await import('@doc77/core');
  const codes = setupPasswordWithDEK(pwd);
  if (!codes) {
    console.error(t('cli.password.alreadySet'));
    process.exit(1);
  }
  console.log(t('cli.password.setOk'));
  console.log('');
  console.log(t('cli.recovery.codesHeader'));
  codes.formatted.forEach((c: string) => console.log(`   ${c}`));
  console.log(t('cli.recovery.codesWarning'));
}

function printBanner() {
  const padEnd = (s: string, w: number) => {
    let d = 0;
    for (const c of s) d += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(c) ? 2 : 1;
    return s + ' '.repeat(Math.max(0, w - d));
  };
  // Inner width = 36 display columns
  console.log(
    '\n  ╔' +
      '═'.repeat(36) +
      '╗' +
      '\n  ║  ' +
      padEnd('Doc77', 34) +
      '║' +
      '\n  ║  ' +
      padEnd(t('cli.banner.tagline'), 34) +
      '║' +
      '\n  ║  ' +
      padEnd(t('cli.banner.subtitle'), 34) +
      '║' +
      '\n  ║  ' +
      padEnd('v' + VERSION, 34) +
      '║' +
      '\n  ╚' +
      '═'.repeat(36) +
      '╝',
  );
}

function printHelp() {
  console.log(t('cli.help.content', { version: VERSION }));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`doc77 v${VERSION}`);
    return;
  }

  await init();
  await detectModules();
  const command = args[0];

  switch (command) {
    case 'start': {
      printBanner();
      // Async version check — never blocks startup
      setTimeout(async () => {
        try {
          const { checkForUpdate } = await import('@doc77/core');
          const info = await checkForUpdate();
          if (info?.hasUpdate) {
            console.log(
              `\x1b[33m⚠  Doc77 v${info.latest} is available (current: v${info.current})\x1b[0m`,
            );
            console.log(`\x1b[33m   ${info.htmlUrl}\x1b[0m`);
          }
        } catch {
          /* silent */
        }
      }, 2000);
      const portIdx = args.indexOf('--port');
      const port = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 27777;
      const bindIdx = args.indexOf('--bind');
      const cliBind = bindIdx !== -1 ? args[bindIdx + 1] : undefined;

      const { createApp } = await import('@doc77/core');
      const { spawn } = await import('node:child_process');
      const http = await import('node:http');

      // Startup maintenance (MCP optional — skip if not installed)
      let maint: ReturnType<typeof setInterval> | undefined;
      // Prune stale persisted AI chat sessions (core — always available).
      try {
        const { pruneAiSessions } = await import('@doc77/core');
        pruneAiSessions(24);
      } catch {
        /* non-fatal */
      }
      try {
        const mcpMaint = await import('@doc77/mcp');
        const { runShadowGC, rejectExpiredTasks, cleanupExpiredSessions } = mcpMaint;
        const firstProject = listProjects()[0];
        if (firstProject) runShadowGC(firstProject.path);
        rejectExpiredTasks();
        cleanupExpiredSessions();
        // Periodic maintenance every 30 min
        maint = setInterval(
          () => {
            const proj = listProjects()[0];
            if (proj) runShadowGC(proj.path);
            rejectExpiredTasks();
          },
          30 * 60 * 1000,
        );
      } catch {
        /* MCP not installed, skip maintenance */
      }

      // Bind address priority: CLI --bind > DB config > default 127.0.0.1
      const isLocalAddr = (a: string) => a === '127.0.0.1' || a === 'localhost' || a === '::1';
      const bindAddr = cliBind || getConfig('security.bind_address') || '127.0.0.1';

      // Restart callback: spawn new process, respecting DB-persisted config
      // CLI --bind/--port are one-time overrides; on restart, DB config wins.
      const restartServer = () => {
        const argv = process.argv.slice(1); // skip node binary
        // Strip --bind and --port so DB-persisted values take effect on restart
        const filtered: string[] = [];
        for (let i = 0; i < argv.length; i++) {
          if (argv[i] === '--bind' || argv[i] === '--port') {
            i++; // skip value too
            continue;
          }
          filtered.push(argv[i]);
        }
        // Re-apply DB-persisted values. Always pass --bind and --port so the
        // child process gets explicit values; treat empty string the same as
        // missing (both are falsy) → fall back to safe defaults.
        const dbBind = getConfig('security.bind_address') || '127.0.0.1';
        filtered.push('--bind', dbBind);
        const dbPort = getConfig('server.port') || String(port);
        filtered.push('--port', dbPort);

        // Persist in-memory DB to disk before spawning replacement process
        closeConnection();

        let spawnFailed = false;
        const child = spawn(process.execPath, filtered, { detached: true, stdio: 'inherit' });
        child.on('error', (err) => {
          spawnFailed = true;
          console.error('[doc77] Failed to restart server:', err.message);
        });
        child.unref();
        // Defer exit to next event-loop turn so that the async 'error'
        // event (if any) has a chance to fire before we decide to exit.
        setImmediate(() => {
          if (!spawnFailed) process.exit(0);
        });
      };
      // Try to load EventBus before creating the app so CRUD endpoints can emit events
      let eventBus: { on(event: string, listener: (p: unknown) => void): void; off(event: string, listener: (p: unknown) => void): void; emit(event: string, payload: unknown): void } | undefined;
      try {
        const mcpEvents = await import('@doc77/mcp');
        eventBus = mcpEvents.getEventBus();
      } catch {
        /* MCP not installed — file-tree:changed events won't be emitted */
      }
      const app = createApp(restartServer, bindAddr, port, eventBus);

      // Register MCP-dependent routes (optional)
      try {
        const { executeApprovedTasks } = await import('@doc77/mcp');
        const { createQueueApproveHandler, createEventsHandler } = await import('@doc77/core');
        app.post('/api/queue/approve', createQueueApproveHandler(executeApprovedTasks));
        // Push write-task lifecycle events (executed/failed) to the browser.
        if (eventBus) app.get('/api/events', createEventsHandler(eventBus));
      } catch {
        /* MCP not installed */
      }

      // Register AI-dependent routes (optional)
      try {
        const { AiProvider, DocAgent, getReadTools, getWriteTools } = await import('@doc77/ai');
        const { createAIChatHandler } = await import('@doc77/core');
        const aiDeps: Record<string, unknown> = { AiProvider, DocAgent, getReadTools };
        // When MCP is installed, let the AI propose writes through the approval
        // queue by injecting its write functions + tool schemas.
        if (mcpAvailable) {
          const { createFolder, moveFile, deleteFile, batchOperations } =
            await import('@doc77/mcp');
          aiDeps.getWriteTools = getWriteTools;
          aiDeps.writeFns = { createFolder, moveFile, deleteFile, batchOperations };
        }
        app.post('/api/ai/chat', createAIChatHandler(aiDeps as any));
      } catch {
        /* AI not installed */
      }

      // Inject capabilities into app
      try {
        const { setCapabilities } = await import('@doc77/core');
        setCapabilities({ ai: aiAvailable, mcp: mcpAvailable, translate: translateAvailable });
      } catch {}

      const server = http.createServer(app);

      // Handle server errors gracefully
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(t('cli.start.portInUse', { port, suggestedPort: port + 1 }));
        } else {
          console.error(t('cli.start.failed', { message: err.message }));
        }
        closeConnection();
        process.exit(1);
      });

      // Security: non-localhost binding requires password authentication
      if (!isLocalAddr(bindAddr)) {
        const authRow = getConnection()
          .prepare('SELECT password_hash FROM user_auth WHERE id = 1')
          .get() as { password_hash: string } | undefined;
        if (!authRow?.password_hash) {
          console.log(t('cli.start.noPasswordBind', { addr: bindAddr }));
          // Try interactive password setup
          if (process.stdin.isTTY) {
            const pwd = await askPassword();
            if (pwd) {
              const { hashPassword, generateSalt } = await import('@doc77/core');
              const hash = hashPassword(pwd);
              const encSalt = generateSalt();
              const pbkdf2Salt = generateSalt();
              getConnection()
                .prepare(
                  'INSERT OR REPLACE INTO user_auth (id, password_hash, pbkdf2_salt, encryption_salt) VALUES (1, ?, ?, ?)',
                )
                .run(hash, pbkdf2Salt, encSalt);
              console.log(t('cli.start.passwordSetOk'));
            } else {
              console.error(t('cli.start.passwordSetFailed'));
              process.exit(1);
            }
          } else {
            console.error(t('cli.start.noTty'));
            process.exit(1);
          }
        }
        console.log(t('cli.start.passwordEnabled', { addr: bindAddr }));
      }
      if (!isLocalAddr(bindAddr)) {
        console.log(t('cli.start.bindWarning', { addr: bindAddr }));
      }
      server.listen(port, bindAddr, () => {
        const displayAddr =
          bindAddr === '127.0.0.1' || bindAddr === '::1' || bindAddr === 'localhost'
            ? 'localhost'
            : bindAddr;
        console.log(t('cli.start.dashboardUrl', { addr: displayAddr, port }));
        console.log(t('cli.start.desktopLink'));
      });

      // Graceful shutdown
      const shutdown = async () => {
        console.log('\nShutting down...');
        server.close();
        if (maint) clearInterval(maint as any);
        closeConnection();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }

    case 'register': {
      const dirPath = args[1];
      const nameIdx = args.indexOf('--name');
      const name = nameIdx !== -1 ? args[nameIdx + 1] : path.basename(dirPath);

      if (!dirPath) {
        console.error('Usage: doc77 register <path> [--name <n>]');
        process.exit(1);
      }

      const resolved = resolveProjectPath(dirPath);
      const proj = registerProject(name, resolved);
      console.log(`Registered: [${proj.id}] ${proj.name} (${proj.path})`);
      closeConnection();
      break;
    }

    case 'list': {
      const projects = listProjects();
      const asJson = args.includes('--json');
      if (asJson) {
        console.log(JSON.stringify(projects, null, 2));
      } else {
        if (projects.length === 0) {
          console.log('No projects registered.');
        } else {
          for (const p of projects) {
            console.log(`[${p.id}] ${p.name} — ${p.path}`);
          }
        }
      }
      closeConnection();
      break;
    }

    case 'remove': {
      const id = parseInt(args[1]);
      if (isNaN(id)) {
        console.error('Usage: doc77 remove <id>');
        process.exit(1);
      }
      removeProject(id);
      console.log(`Project ${id} removed.`);
      closeConnection();
      break;
    }

    case 'update': {
      const id = parseInt(args[1]);
      const nameIdx = args.indexOf('--name');
      const pathIdx = args.indexOf('--path');
      const updates: { name?: string; path?: string } = {};
      if (nameIdx !== -1) updates.name = args[nameIdx + 1];
      if (pathIdx !== -1) updates.path = resolveProjectPath(args[pathIdx + 1]);

      if (isNaN(id) || Object.keys(updates).length === 0) {
        console.error('Usage: doc77 update <id> [--name <n>] [--path <p>]');
        process.exit(1);
      }
      updateProject(id, updates);
      console.log(`Project ${id} updated.`);
      closeConnection();
      break;
    }

    case 'config': {
      const sub = args[1];
      if (sub === 'set') {
        setConfig(args[2], args[3]);
        console.log(`${args[2]} = ${args[3]}`);
      } else if (sub === 'get') {
        const val = getConfig(args[2]) || '(not set)';
        console.log(val);
      } else if (sub === 'list') {
        const all = listConfig();
        for (const [k, v] of Object.entries(all)) {
          console.log(`${k}=${v}`);
        }
      } else if (sub === 'set-password') {
        await setPasswordInteractive();
      } else if (sub === 'change-password') {
        const oldPw = await askPassword(t('cli.password.promptCurrent'));
        const newPw = await askPassword(t('cli.password.promptNew'));
        if (newPw.length < 6) {
          console.error(t('cli.password.tooShort'));
          process.exit(1);
        }
        const confirm = await askPassword(t('cli.password.promptConfirmNew'));
        if (newPw !== confirm) {
          console.error(t('cli.password.mismatch'));
          process.exit(1);
        }
        const { changePassword } = await import('@doc77/core');
        const result = changePassword(oldPw, newPw);
        if (result.ok) {
          console.log(t('cli.config.changePwd.ok'));
        } else {
          console.error(`❌ ${result.error}`);
          process.exit(1);
        }
      } else if (sub === 'reset-password') {
        const force = process.argv.includes('--force');
        if (force) {
          const readline = await import('node:readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question(t('cli.config.resetPwd.forceConfirm'), async (answer: string) => {
            rl.close();
            if (answer.trim() !== 'yes-i-know') {
              console.error(t('cli.config.resetPwd.cancelled'));
              process.exit(1);
            }
            const { forceResetPassword } = await import('@doc77/core');
            forceResetPassword();
            console.log(t('cli.config.resetPwd.ok'));
            process.exit(0);
          });
          return;
        }
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(t('cli.recovery.prompt'), async (rc: string) => {
          rl.close();
          const { verifyRecoveryCode, resetPasswordWithToken } = await import('@doc77/core');
          const result = verifyRecoveryCode(rc.trim());
          if (!result.ok) {
            console.error(`❌ ${result.error}`);
            process.exit(1);
          }
          console.log(t('cli.recovery.verified'));
          const newPw = await askPassword(t('cli.password.promptNew'));
          if (newPw.length < 6) {
            console.error(t('cli.password.tooShort'));
            process.exit(1);
          }
          const confirm = await askPassword(t('cli.password.promptConfirmNew'));
          if (newPw !== confirm) {
            console.error(t('cli.password.mismatch'));
            process.exit(1);
          }
          const resetResult = resetPasswordWithToken(result.resetToken!, newPw);
          if (resetResult.ok) {
            console.log(t('cli.config.resetPwd.okWithRemaining', { remaining: result.remaining }));
          } else {
            console.error(`❌ ${resetResult.error}`);
            process.exit(1);
          }
        });
      } else if (sub === 'recovery-codes') {
        const password = await askPassword(t('cli.password.promptCurrent'));
        const { regenerateRecoveryCodes } = await import('@doc77/core');
        const rcResult = regenerateRecoveryCodes(password);
        if (rcResult.ok && rcResult.codes) {
          console.log(t('cli.recovery.newCodesHeader'));
          rcResult.codes.formatted.forEach((c: string) => console.log(`   ${c}`));
          console.log(t('cli.recovery.oldCodesInvalidated'));
          console.log(t('cli.recovery.codesWarning'));
        } else {
          console.error(`❌ ${rcResult.error}`);
          process.exit(1);
        }
      } else {
        console.error(t('cli.config.usage'));
        process.exit(1);
      }
      break;
    }

    case 'approve': {
      const mcp = await tryGetMcp([
        'getPendingTasks',
        'getTaskById',
        'updateTaskStatus',
        'executeApprovedTasks',
      ]);
      if (!mcp) {
        console.error(t('cli.mcp.notInstalled'));
        break;
      }
      if (args.includes('--list')) {
        const projects = listProjects();
        for (const p of projects) {
          const tasks = mcp.getPendingTasks(p.id);
          if (tasks.length > 0) {
            console.log(`\nProject [${p.id}] ${p.name}:`);
            for (const t of tasks) {
              console.log(
                `  ${t.task_id}: ${t.operation_type} — ${JSON.stringify(t.operation_data)}`,
              );
            }
          }
        }
      } else if (args.includes('--accept')) {
        const taskId = args[args.indexOf('--accept') + 1];
        if (!taskId || taskId.startsWith('-')) {
          console.error('Usage: doc77 approve --accept <task_id>');
          process.exit(1);
        }
        const task = mcp.getTaskById(taskId);
        if (!task) {
          console.error('Task not found:', taskId);
          process.exit(1);
        }
        mcp.updateTaskStatus(taskId, 'approved');
        if (args.includes('--exec')) {
          const result = await mcp.executeApprovedTasks(task.project_id, [taskId]);
          console.log(
            result.success
              ? 'Task executed successfully.'
              : 'Execution failed: ' + result.errors.join(', '),
          );
        } else {
          console.log(`Task ${taskId} approved. Run with --exec to execute immediately.`);
        }
      } else if (args.includes('--reject')) {
        const taskId = args[args.indexOf('--reject') + 1];
        if (!taskId || taskId.startsWith('-')) {
          console.error('Usage: doc77 approve --reject <task_id>');
          process.exit(1);
        }
        mcp.updateTaskStatus(taskId, 'rejected');
        console.log(`Task ${taskId} rejected.`);
      } else if (args.includes('--all')) {
        const projects = listProjects();
        const allTasks = projects.flatMap((p: any) => mcp.getPendingTasks(p.id));
        const isReject = args.includes('--reject');
        const newStatus = isReject ? 'rejected' : 'approved';
        for (const t of allTasks) mcp.updateTaskStatus(t.task_id, newStatus);
        console.log(`${allTasks.length} tasks ${newStatus}.`);
      } else {
        console.error('Usage: doc77 approve --list|--accept <id>|--reject <id>');
        process.exit(1);
      }
      break;
    }

    case 'lock': {
      const mcp = await tryGetMcp(['getActiveLock', 'releaseProjectLock']);
      if (!mcp) {
        console.error(t('cli.mcp.notInstalled'));
        break;
      }
      if (args[1] === 'status') {
        const projects = listProjects();
        for (const p of projects) {
          const lock = mcp.getActiveLock(p.id);
          if (lock) console.log(`Project ${p.id} locked by ${lock.locked_by} at ${lock.locked_at}`);
        }
      } else if (args[1] === 'release') {
        const pid = parseInt(args[2]);
        mcp.releaseProjectLock(pid);
        console.log(`Lock released for project ${pid}.`);
      } else {
        console.error('Usage: doc77 lock status|release <project_id>');
        process.exit(1);
      }
      break;
    }

    case 'vendor-install': {
      if (args.includes('--translate')) {
        const pairIdx = args.indexOf('--translate');
        const pairArg =
          pairIdx + 1 < args.length && !args[pairIdx + 1].startsWith('--')
            ? args[pairIdx + 1]
            : 'all';
        const pairs =
          pairArg === 'all'
            ? ['en-zh', 'zh-en']
            : pairArg.split(',').filter((p: string) => p === 'en-zh' || p === 'zh-en');
        if (!pairs.length) {
          console.error(t('cli.translate.usage'));
          break;
        }
        const { isEngineAvailable, translate, MODEL_PAIRS } = await import('@doc77/core');
        if (!(await isEngineAvailable())) {
          console.error(t('cli.translate.engineNotAvailable'));
          break;
        }
        if (args.includes('--mirror')) {
          setConfig('translate.mirror', 'true');
          console.log(t('cli.translate.mirrorEnabled'));
        }
        for (const pair of pairs) {
          const mi = MODEL_PAIRS[pair];
          console.log(
            t('cli.translate.downloading', { displayName: mi.displayName, size: mi.size }),
          );
          try {
            await translate('Hello', mi.sourceLang, mi.targetLang);
            console.log(t('cli.translate.modelReady', { displayName: mi.displayName }));
          } catch (e: unknown) {
            console.error(
              t('cli.translate.downloadFailed', {
                displayName: mi.displayName,
                error: e instanceof Error ? e.message : 'Unknown',
              }),
            );
          }
        }
        console.log(t('cli.translate.downloadComplete'));
        break;
      }
      const vendorDir = path.join(os.homedir(), '.doc77', 'vendor');
      const skipPyodide = args.includes('--no-pyodide');
      const { fetchVendorAssets, VENDOR_ASSETS } = await import('@doc77/core');
      const assets = skipPyodide
        ? VENDOR_ASSETS.filter((a) => !a.name.includes('pyodide'))
        : VENDOR_ASSETS;
      console.log(t('cli.vendor.downloadingAssets', { count: assets.length, dir: vendorDir }));
      await fetchVendorAssets(vendorDir, assets);
      console.log(t('cli.vendor.complete'));
      break;
    }

    case 'status':
      console.log(`Doc77 v${VERSION}`);
      console.log(`DB: ${DB_PATH}`);
      console.log(`Projects: ${listProjects().length} registered`);
      closeConnection();
      break;

    case 'i': {
      let modules = args
        .slice(1)
        .filter((m: string) => ['ai', 'mcp', 'translate', 'all'].includes(m));
      if (modules.includes('all')) modules = ['ai', 'mcp', 'translate'];
      if (!modules.length) {
        console.log(t('cli.install.usage'));
        break;
      }
      const { execSync } = await import('node:child_process');
      for (const m of modules) {
        if (m === 'translate') {
          console.log(t('cli.install.installingTransformers'));
          execSync('npm install -g @huggingface/transformers@latest --legacy-peer-deps', {
            stdio: 'inherit',
          });
          console.log(t('cli.install.transformersOk'));
        } else {
          console.log(t('cli.install.installingModule', { mod: m }));
          execSync(`npm install -g @doc77/${m}@latest --legacy-peer-deps`, { stdio: 'inherit' });
          console.log(t('cli.install.moduleOk', { mod: m }));
        }
      }
      console.log(t('cli.install.restart'));
      break;
    }
    case 'rm': {
      const modules = args.slice(1).filter((m: string) => ['ai', 'mcp'].includes(m));
      if (!modules.length) {
        console.log(t('cli.install.rmUsage'));
        break;
      }
      const { execSync } = await import('node:child_process');
      for (const m of modules) {
        console.log(t('cli.install.uninstalling', { mod: m }));
        execSync(`npm uninstall -g @doc77/${m}`, { stdio: 'inherit' });
        console.log(t('cli.install.uninstalled', { mod: m }));
      }
      console.log(t('cli.install.restart'));
      break;
    }

    case 'mcp': {
      if (args[1] === 'serve') {
        const mcp = await tryGetMcp(['createMcpServer', 'connectStdio']);
        if (!mcp) {
          console.error(t('cli.mcp.notInstalled'));
          break;
        }
        const server = mcp.createMcpServer();
        await mcp.connectStdio(server);
        console.error('Doc77 MCP server running (stdio transport)');
        process.on('SIGINT', async () => {
          await server.close();
          closeConnection();
          process.exit(0);
        });
      } else if (args[1] === 'status') {
        console.log('MCP server status: ready (doc77 mcp serve)');
      } else {
        console.error('Usage: doc77 mcp serve|status');
        process.exit(1);
      }
      break;
    }

    case 'ai':
      console.log('AI features available via Web Dashboard at /api/ai/chat');
      break;

    case 'discover': {
      let discoverPath = '~';
      let depth = 2;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--path' && args[i + 1]) {
          discoverPath = args[i + 1];
          i++;
          continue;
        }
        if (args[i] === '--depth' && args[i + 1]) {
          depth = parseInt(args[i + 1], 10);
          i++;
          continue;
        }
        if (!args[i].startsWith('--') && i === 1) {
          discoverPath = args[i];
        }
      }

      console.log(t('cli.discover.scanning', { path: discoverPath, depth }));
      const results = discoverProjects(discoverPath, depth, new Set());

      if (results.length === 0) {
        console.log(t('cli.discover.noCandidates'));
      } else {
        console.log(t('cli.discover.foundCandidates', { count: results.length }));
        for (const r of results) {
          console.log(`  📂 ${r.name}`);
          console.log(t('cli.discover.pathLabel', { path: r.path }));
          console.log(
            t('cli.discover.markdownLabel', { count: r.mdCount }) +
              (r.hasReadme ? t('cli.discover.hasReadme') : ''),
          );
          console.log('');
        }
        console.log(t('cli.discover.registerUsage'));
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run doc77 --help for usage.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  closeConnection();
  process.exit(1);
});
