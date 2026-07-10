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
} from '@doc77/core';

const VERSION = '0.1.0';
const DB_PATH = path.join(os.homedir(), '.doc77', 'data.db');

// Module availability — checked at startup, cached for session
let mcpAvailable = false;
let aiAvailable = false;
async function detectModules() {
  try {
    await import('@doc77/mcp');
    mcpAvailable = true;
  } catch {}
  try {
    await import('@doc77/ai');
    aiAvailable = true;
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
}

/** Read a password from stdin without echoing. */
function askPassword(prompt: string = '请输入密码（至少6位）'): Promise<string> {
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
  const pwd = await askPassword('请输入新密码（至少6位）');
  if (pwd.length < 6) {
    console.error('❌ 密码至少6位');
    process.exit(1);
  }
  const confirm = await askPassword('请再次输入密码');
  if (pwd !== confirm) {
    console.error('❌ 两次密码不一致');
    process.exit(1);
  }
  const { hashPassword, generateSalt } = await import('@doc77/core');
  const hash = hashPassword(pwd);
  const encSalt = generateSalt();
  const pbkdf2Salt = generateSalt();
  getConnection()
    .prepare(
      'INSERT OR REPLACE INTO user_auth (id, password_hash, pbkdf2_salt, encryption_salt) VALUES (1, ?, ?, ?)',
    )
    .run(hash, pbkdf2Salt, encSalt);
  console.log('✅ 密码已设置');
}

function printBanner() {
  const padEnd = (s: string, w: number) => {
    let d = 0;
    for (const c of s) d += /[一-鿿　-〿＀-￯]/.test(c) ? 2 : 1;
    return s + ' '.repeat(w - d);
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
      padEnd('默认安全 · 对话驱动', 34) +
      '║' +
      '\n  ║  ' +
      padEnd('智能本地文档管理 Agent', 34) +
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
  console.log(`
Doc77 v${VERSION} — 默认安全、对话驱动的智能本地文档管理 Agent

用法:
  doc77 <command> [options]

核心命令:
  start [--port <n>] [--bind <addr>] [--no-browser]  启动 Web Dashboard
  discover [path]                     扫描发现候选项目
  discover --path ~/work              指定扫描目录
  discover --depth 3                  指定扫描深度（默认2）
  register <path> [--name <n>]        注册项目
  list [--json]                       列出所有项目
  remove <id>                         按 ID 移除项目
  update <id> [--name <n>] [--path <p>] 更新项目
  status                              查看服务状态
  --version                           显示版本号
  --help                              显示帮助

模块管理:
  i <ai|mcp|all>                      安装可选模块
  rm <ai|mcp>                         卸载模块

配置管理:
  config set <key> <value>            设置配置项
  config get <key>                    获取配置项
  config list                         列出所有配置

MCP 服务:
  mcp serve [--http] [--port <n>]    启动 MCP 服务

任务审批:
  approve --list                      列出待审批任务
  approve --accept <task_id>          批准指定任务
  approve --reject <task_id>          拒绝指定任务
  approve --accept --all              批量批准
  approve --reject --all              批量拒绝

锁管理:
  lock status                         查看活跃锁
  lock release <project_id>           手动释放锁

AI 能力:
  ai summarize <file>                 总结文档
  ai classify <dir>                   分析项目结构
  ai summary <dir>                    生成项目摘要
  ai chat                             进入对话模式
`);
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
      const portIdx = args.indexOf('--port');
      const port = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 3099;
      const bindIdx = args.indexOf('--bind');
      const cliBind = bindIdx !== -1 ? args[bindIdx + 1] : undefined;

      const { createApp } = await import('@doc77/core');
      const { spawn } = await import('node:child_process');
      const http = await import('node:http');

      // Startup maintenance (MCP optional — skip if not installed)
      let maint: ReturnType<typeof setInterval> | undefined;
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

      // Restart callback: spawn new process with same args, then exit
      const restartServer = () => {
        const argv = process.argv.slice(1); // skip node binary
        let spawnFailed = false;
        const child = spawn(process.execPath, argv, { detached: true, stdio: 'inherit' });
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
      const app = createApp(restartServer, bindAddr);

      // Register MCP-dependent routes (optional)
      try {
        const { executeApprovedTasks } = await import('@doc77/mcp');
        const { createQueueApproveHandler } = await import('@doc77/core');
        app.post('/api/queue/approve', createQueueApproveHandler(executeApprovedTasks));
      } catch {
        /* MCP not installed */
      }

      // Register AI-dependent routes (optional)
      try {
        const { AiProvider, DocAgent, READ_TOOLS } = await import('@doc77/ai');
        const { createAIChatHandler } = await import('@doc77/core');
        app.post('/api/ai/chat', createAIChatHandler({ AiProvider, DocAgent, READ_TOOLS }));
      } catch {
        /* AI not installed */
      }

      // Inject capabilities into app
      try {
        const { setCapabilities } = await import('@doc77/core');
        setCapabilities({ ai: aiAvailable, mcp: mcpAvailable });
      } catch {}

      const server = http.createServer(app);

      // Security: non-localhost binding requires password authentication
      if (!isLocalAddr(bindAddr)) {
        const authRow = getConnection()
          .prepare('SELECT password_hash FROM user_auth WHERE id = 1')
          .get() as { password_hash: string } | undefined;
        if (!authRow?.password_hash) {
          console.log(`\n⚠️  绑定 ${bindAddr} 会将 Doc77 暴露到网络，需要设置访问密码。`);
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
              console.log('✅ 密码已设置\n');
            } else {
              console.error('❌ 密码设置失败，启动取消。\n');
              process.exit(1);
            }
          } else {
            console.error('❌ 无法交互设置密码（非终端环境）。请先运行:');
            console.error('   doc77 config set-password');
            console.error('   或: doc77 start (绑定 127.0.0.1)，通过 Web 设置密码\n');
            process.exit(1);
          }
        }
        console.log(`🔒 密码保护已启用 — 绑定 ${bindAddr}`);
      }
      if (!isLocalAddr(bindAddr)) {
        console.log(`⚠️  绑定 ${bindAddr} — 确保防火墙已配置。`);
      }
      server.listen(port, bindAddr, () => {
        console.log(
          `Doc77 Dashboard: http://${bindAddr === '127.0.0.1' || bindAddr === '::1' || bindAddr === 'localhost' ? 'localhost' : bindAddr}:${port}`,
        );
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
      } else {
        console.error('Usage: doc77 config set|get|list|set-password [key] [value]');
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
        console.error('MCP 模块未安装。安装: doc77 i mcp');
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
        console.error('MCP 模块未安装。安装: doc77 i mcp');
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
      const vendorDir = path.join(os.homedir(), '.doc77', 'vendor');
      const skipPyodide = args.includes('--no-pyodide');
      const { fetchVendorAssets, VENDOR_ASSETS } = await import('@doc77/core');
      const assets = skipPyodide
        ? VENDOR_ASSETS.filter((a) => !a.name.includes('pyodide'))
        : VENDOR_ASSETS;
      console.log(`下载 ${assets.length} 个资源到 ${vendorDir}...`);
      await fetchVendorAssets(vendorDir, assets);
      console.log('✅ Vendor 资源下载完成！离线模式已就绪。');
      break;
    }

    case 'status':
      console.log(`Doc77 v${VERSION}`);
      console.log(`DB: ${DB_PATH}`);
      console.log(`Projects: ${listProjects().length} registered`);
      closeConnection();
      break;

    case 'i': {
      let modules = args.slice(1).filter((m: string) => ['ai', 'mcp', 'all'].includes(m));
      if (modules.includes('all')) modules = ['ai', 'mcp'];
      if (!modules.length) {
        console.log('用法: doc77 i <ai|mcp|all>');
        break;
      }
      const { execSync } = await import('node:child_process');
      for (const m of modules) {
        console.log(`安装 @doc77/${m}...`);
        execSync(`npm install @doc77/${m}@latest`, { stdio: 'inherit' });
        console.log(`✅ @doc77/${m} 安装完成`);
      }
      console.log('重启 Doc77 服务生效');
      break;
    }
    case 'rm': {
      const modules = args.slice(1).filter((m: string) => ['ai', 'mcp'].includes(m));
      if (!modules.length) {
        console.log('用法: doc77 rm <ai|mcp>');
        break;
      }
      const { execSync } = await import('node:child_process');
      for (const m of modules) {
        console.log(`卸载 @doc77/${m}...`);
        execSync(`npm uninstall @doc77/${m}`, { stdio: 'inherit' });
        console.log(`✅ @doc77/${m} 已卸载`);
      }
      console.log('重启 Doc77 服务生效');
      break;
    }

    case 'mcp': {
      if (args[1] === 'serve') {
        const mcp = await tryGetMcp(['createMcpServer']);
        if (!mcp) {
          console.error('MCP 模块未安装。安装: doc77 i mcp');
          break;
        }
        const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
        const server = mcp.createMcpServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
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
        if (args[i] === '--path' && args[i + 1]) { discoverPath = args[i + 1]; i++; continue; }
        if (args[i] === '--depth' && args[i + 1]) { depth = parseInt(args[i + 1], 10); i++; continue; }
        if (!args[i].startsWith('--') && i === 1) { discoverPath = args[i]; }
      }

      console.log(`🔍 扫描目录: ${discoverPath} (深度: ${depth})`);
      const results = discoverProjects(discoverPath, depth, new Set());

      if (results.length === 0) {
        console.log('未发现候选项目（需要 .git + 至少 1 个 .md 文件）');
      } else {
        console.log(`\n发现 ${results.length} 个候选项目:\n`);
        for (const r of results) {
          console.log(`  📂 ${r.name}`);
          console.log(`     路径: ${r.path}`);
          console.log(`     Markdown: ${r.mdCount} 个${r.hasReadme ? ' (含 README)' : ''}`);
          console.log('');
        }
        console.log('使用 doc77 register <路径> --name "<名称>" 注册项目');
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
