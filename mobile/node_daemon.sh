#!/bin/bash
# 移动端客户端守护与更新脚本

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

log "Starting mobile client daemon..."

# 移动端本地无感构建：检查若无 dist/client.js 则在本地自动构建
if [ ! -f "dist/client.js" ]; then
    log "dist/client.js not found. Building TypeScript locally on mobile device..."
    npx tsc || npm run build || pnpm build
fi

log "Starting client using native Node.js..."

while true; do
    # 再次兜底判定，确保本地构建编译成功
    if [ ! -f "dist/client.js" ]; then
        log "Re-trying build on mobile..."
        npx tsc || npm run build || pnpm build
    fi

    # 运行移动端本地构建好的代码（stdout/stderr 由 client.ts 自行写入日志）
    node dist/client.js

    EXIT_CODE=$?
    
    # 检查退出状态码是否是 99（代表自更新信号）
    if [ $EXIT_CODE -eq 99 ]; then
        log "Self-update signal detected (exit code 99)."
        log "Executing git reset & pull..."
        
        # 回退到 git 仓库根目录执行更新
        cd ..
        git reset --hard HEAD
        git pull
        
        # 回到 mobile 目录，并在移动端本地重新编译构建
        cd mobile
        log "Rebuilding client TypeScript on mobile..."
        npx tsc || npm run build || pnpm build
        log "Update & build complete. Restarting client in 2 seconds..."
        sleep 2
    elif [ $EXIT_CODE -eq 0 ]; then
        log "Client exited normally with code 0. Stopping daemon."
        break
    else
        log "Client crashed with code $EXIT_CODE. Restarting in 5 seconds..."
        sleep 5
    fi
done
