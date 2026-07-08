#!/usr/bin/env bash
#
# Doc77 一键重启脚本
#
# 用法:
#   ./scripts/restart.sh              # 默认端口 3099
#   ./scripts/restart.sh --port 8080  # 自定义端口
#   ./scripts/restart.sh -p 8080      # 简写
#
set -euo pipefail

# === 参数解析 ===
PORT=3099
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p)
      PORT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--port <n>|-p <n>]"
      exit 1
      ;;
  esac
done

# === 检测 doc77 命令 ===
if ! command -v doc77 &> /dev/null; then
  echo "[ERROR] 'doc77' 命令不可用，请先安装: npm install -g @doc77/cli"
  exit 1
fi

echo "=== Doc77 重启 ==="
echo "目标端口: ${PORT}"

# === 检测端口占用 ===
find_pid_by_port() {
  local port="$1"
  local pid=""

  # 依次尝试 lsof → fuser → ss
  if command -v lsof &> /dev/null; then
    pid=$(lsof -ti ":$port" 2>/dev/null || true)
  elif command -v fuser &> /dev/null; then
    pid=$(fuser "$port/tcp" 2>/dev/null || true)
  elif command -v ss &> /dev/null; then
    pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  else
    echo "[ERROR] 无法检测端口占用（缺少 lsof / fuser / ss），请手动检查"
    exit 1
  fi

  echo "$pid"
}

PID=$(find_pid_by_port "$PORT")

if [[ -n "$PID" ]]; then
  echo "检测到端口 ${PORT} 已被进程 ${PID} 占用，正在关闭..."

  # 优雅关闭 (SIGTERM)
  kill "$PID" 2>/dev/null || true

  # 等待最多 2 秒
  for i in {1..20}; do
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "进程 ${PID} 已退出 (SIGTERM)"
      break
    fi
    sleep 0.1
  done

  # 仍未退出则强制终止 (SIGKILL)
  if kill -0 "$PID" 2>/dev/null; then
    echo "进程 ${PID} 未响应 SIGTERM，执行强制终止..."
    kill -9 "$PID" 2>/dev/null || true
    # 再等最多 5 秒
    for i in {1..50}; do
      if ! kill -0 "$PID" 2>/dev/null; then
        echo "进程 ${PID} 已强制终止"
        break
      fi
      sleep 0.1
    done
  fi

  # 最终确认
  if kill -0 "$PID" 2>/dev/null; then
    echo "[ERROR] 无法终止进程 ${PID}，请手动处理"
    exit 1
  fi

  # 确认端口释放
  sleep 0.5
  REMAIN=$(find_pid_by_port "$PORT")
  if [[ -n "$REMAIN" ]]; then
    echo "[ERROR] 端口 ${PORT} 仍被进程 ${REMAIN} 占用"
    exit 1
  fi
  echo "端口 ${PORT} 已释放"
else
  echo "端口 ${PORT} 未被占用，直接启动"
fi

# === 启动 ===
echo "启动 Doc77..."
doc77 start --port "$PORT"
