#!/usr/bin/env node
/**
 * Doc77 CLI — 命令行入口
 */
import * as path from 'node:path';
import * as os from 'node:os';
import {
  initDatabase,
  closeConnection,
  runMigrations,
  getConfig,
  setConfig,
  listConfig,
  registerProject,
  resolveProjectPath,
  listProjects,
  removeProject,
  updateProject,
} from '@doc77/core';
import { getPendingTasks, getActiveLock, releaseProjectLock, updateTaskStatus } from '@doc77/mcp';

const VERSION = '0.1.0';
const DB_PATH = path.join(os.homedir(), '.doc77', 'data.db');

async function init() {
  await initDatabase(DB_PATH);
  runMigrations();
  loadDefaults();
}

function printHelp() {
  console.log(`
Doc77 v${VERSION} — 默认安全、对话驱动的智能本地文档管理 Agent

用法:
  doc77 <command> [options]

核心命令:
  start [--port <n>] [--no-browser]   启动 Web Dashboard
  register <path> [--name <n>]        注册项目
  list [--json]                       列出所有项目
  remove <id>                         按 ID 移除项目
  update <id> [--name <n>] [--path <p>] 更新项目
  status                              查看服务状态
  --version                           显示版本号
  --help                              显示帮助

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
  const command = args[0];

  switch (command) {
      case 'start': {
        const portIdx = args.indexOf('--port');
        const port = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 3099;

        const { createApp } = await import('@doc77/core');
        const http = await import('node:http');

        // Startup maintenance
        const { runShadowGC, rejectExpiredTasks, cleanupExpiredSessions } = await import('@doc77/mcp');
        const firstProject = listProjects()[0];
        if (firstProject) runShadowGC(firstProject.path);
        rejectExpiredTasks();
        cleanupExpiredSessions();

        // Periodic maintenance every 30 min
        const maint = setInterval(() => {
          const proj = listProjects()[0];
          if (proj) runShadowGC(proj.path);
          rejectExpiredTasks();
        }, 30 * 60 * 1000);

        const app = createApp();
        const server = http.createServer(app);
        server.listen(port, () => {
          console.log(`Doc77 Dashboard: http://localhost:${port}`);
        });

        // Graceful shutdown
        const shutdown = async () => {
          console.log('\nShutting down...');
          server.close();
          clearInterval(maint);
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
        } else {
          console.error('Usage: doc77 config set|get|list [key] [value]');
          process.exit(1);
        }
        break;
      }

      case 'approve': {
        if (args.includes('--list')) {
          // List all pending tasks across all projects
          const projects = listProjects();
          for (const p of projects) {
            const tasks = getPendingTasks(p.id);
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
          const { getTaskById } = await import('@doc77/mcp');
          const task = getTaskById(taskId);
          if (!task) { console.error('Task not found:', taskId); process.exit(1); }
          updateTaskStatus(taskId, 'approved');
          // Execute immediately if --exec flag is given
          if (args.includes('--exec')) {
            const { executeApprovedTasks } = await import('@doc77/mcp');
            const result = await executeApprovedTasks(task.project_id, [taskId]);
            console.log(result.success ? 'Task executed successfully.' : 'Execution failed: ' + result.errors.join(', '));
          } else {
            console.log(`Task ${taskId} approved. Run with --exec to execute immediately.`);
          }
        } else if (args.includes('--reject')) {
          const taskId = args[args.indexOf('--reject') + 1];
          if (!taskId || taskId.startsWith('-')) {
            console.error('Usage: doc77 approve --reject <task_id>');
            process.exit(1);
          }
          updateTaskStatus(taskId, 'rejected');
          console.log(`Task ${taskId} rejected.`);
        } else if (args.includes('--all')) {
          const projects = listProjects();
          const allTasks = projects.flatMap(p => getPendingTasks(p.id));
          const isReject = args.includes('--reject');
          const newStatus = isReject ? 'rejected' : 'approved';
          for (const t of allTasks) updateTaskStatus(t.task_id, newStatus);
          console.log(`${allTasks.length} tasks ${newStatus}.`);
        } else {
          console.error('Usage: doc77 approve --list|--accept <id>|--reject <id>');
          process.exit(1);
        }
        break;
      }

      case 'lock': {
        if (args[1] === 'status') {
          const projects = listProjects();
          for (const p of projects) {
            const lock = getActiveLock(p.id);
            if (lock) {
              console.log(`Project ${p.id} locked by ${lock.locked_by} at ${lock.locked_at}`);
            }
          }
        } else if (args[1] === 'release') {
          const pid = parseInt(args[2]);
          releaseProjectLock(pid);
          console.log(`Lock released for project ${pid}.`);
        } else {
          console.error('Usage: doc77 lock status|release <project_id>');
          process.exit(1);
        }
        break;
      }

      case 'status':
        console.log(`Doc77 v${VERSION}`);
        console.log(`DB: ${DB_PATH}`);
        console.log(`Projects: ${listProjects().length} registered`);
        closeConnection();
        break;

      case 'mcp': {
        if (args[1] === 'serve') {
          const { createMcpServer } = await import('@doc77/mcp');
          const { StdioServerTransport } = await import(
            '@modelcontextprotocol/sdk/server/stdio.js'
          );
          const server = createMcpServer();
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
