#!/bin/bash
# 移动端稳定 supervisor 入口。

# 确保在脚本所在目录执行
cd "$(dirname "$0")"

# 补全 Termux 环境变量
export PATH="/data/data/com.termux/files/usr/bin:$PATH"
export TMPDIR="/data/data/com.termux/files/usr/tmp"
unset LD_PRELOAD

# ============================================================
# 日志系统初始化：所有 [SHERIFF] 输出同时写入 logs/YYYY-MM-DD.log
# ============================================================
LOGS_DIR="$(pwd)/../logs"
mkdir -p "$LOGS_DIR"

log() {
    local MSG="[$(date '+%Y-%m-%d %H:%M:%S')] [SHERIFF] $1"
    echo "$MSG"
    echo "$MSG" >> "$LOGS_DIR/$(date '+%Y-%m-%d').log"
}

DEPLOYMENT_ROOT="${AUTOJS6_DEPLOYMENT_ROOT:-$HOME/.local/share/one-autojs6}"
SUPERVISOR="$DEPLOYMENT_ROOT/bootstrap/supervisor.mjs"

if [ ! -f "$SUPERVISOR" ]; then
    log "Supervisor is not installed at $SUPERVISOR. Refusing legacy git-based self-update."
    exit 1
fi

log "Starting immutable mobile deployment supervisor..."
exec node "$SUPERVISOR"
