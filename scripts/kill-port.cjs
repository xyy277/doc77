#!/usr/bin/env node
/**
 * 跨平台端口释放工具
 *
 * 杀死占用指定端口的进程。
 * 替代 Linux 下的 `fuser -k PORT/tcp`，兼容 Windows。
 *
 * 用法: node scripts/kill-port.cjs [port]
 *       默认端口: 27777
 */
// @ts-check

const { execFileSync, execSync } = require('child_process');
const { platform } = process;
const port = process.argv[2] || '27777';

/**
 * 安全地执行命令并返回 stdout，失败时返回空字符串。
 * 用于不需要 shell pipe 的简单命令。
 */
function safeExecFile(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * 执行 shell 命令（需要 pipe 时使用），失败时返回空字符串。
 */
function safeExec(cmd) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function findPidByPort(port) {
  if (platform === 'win32') {
    // Windows: 需要 shell pipe
    const stdout = safeExec(`netstat -ano | findstr ":${port}"`);
    const lines = stdout.split('\n').filter(
      (l) => l.includes('LISTENING') || l.includes('LISTEN'),
    );
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const addr = parts[1] || '';
      if (addr.endsWith(`:${port}`)) {
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') return pid;
      }
    }
  } else {
    // Unix: lsof → fuser → ss
    let pid = safeExecFile('lsof', ['-ti', `:${port}`]);
    if (pid) return pid;

    pid = safeExecFile('fuser', [`${port}/tcp`]);
    if (pid) return pid;

    pid = safeExec(`ss -tlnp "sport = :${port}" 2>/dev/null | grep -oP 'pid=\\K[0-9]+' | head -1`);
    if (pid) return pid;
  }
  return '';
}

function killPid(pid) {
  if (platform === 'win32') {
    execFileSync('taskkill', ['/F', '/PID', pid], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    // SIGTERM
    safeExecFile('kill', [pid]);
    // 检查是否存活
    const alive = safeExecFile('kill', ['-0', pid]);
    if (alive !== '') {
      // 强制杀
      execFileSync('kill', ['-9', pid], { stdio: 'ignore' });
    }
  }
}

try {
  const pids = findPidByPort(port);
  if (pids) {
    const pidList = pids.split('\n').filter(Boolean);
    for (const pid of pidList) {
      killPid(pid);
      console.error(`[kill-port] 进程 ${pid} 已终止`);
    }
  }
} catch {
  // 端口未被占用，静默退出
}
