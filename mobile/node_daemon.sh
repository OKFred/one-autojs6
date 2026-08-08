#!/bin/bash
# 移动端客户端守护与更新脚本 (TSX 实时编译模式)

# 确保在脚本所在目录执行
cd "$(dirname "$0")"

# 补全 Termux 环境变量
export PATH="/data/data/com.termux/files/usr/bin:$PATH"

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

log "Starting mobile client daemon in TSX zero-cache mode..."

while true; do
    # 清理可能存在的 ESBuild/TSX 磁盘临时转译缓存，确保 100% 读取最新源码
    rm -rf "${TMPDIR:-/tmp}/tsx-"* "$HOME/.cache/tsx"* 2>/dev/null

    # 显式使用 --no-cache 参数强制禁用所有转译缓存
    npx tsx --no-cache src/client.ts

    EXIT_CODE=$?
    
    # 检查退出状态码是否是 99（代表自更新信号）
    if [ $EXIT_CODE -eq 99 ]; then
        log "Self-update signal detected (exit code 99)."
        log "Executing git reset & pull..."
        
        # 回退到 git 仓库根目录执行更新
        cd ..
        git reset --hard HEAD
        git pull
        
        # 回到 mobile 目录
        cd mobile
        log "Update complete. Restarting client via tsx in 2 seconds..."
        sleep 2
    elif [ $EXIT_CODE -eq 0 ]; then
        log "Client exited normally with code 0. Stopping daemon."
        break
    else
        log "Client crashed with code $EXIT_CODE. Restarting in 5 seconds..."
        sleep 5
    fi
done
