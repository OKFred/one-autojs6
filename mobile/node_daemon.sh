#!/bin/bash
# 移动端客户端守护与更新脚本

# 确保在脚本所在目录执行
cd "$(dirname "$0")"

echo "[SHERIFF] Starting mobile client daemon..."

while true; do
    # 启动 Node.js 客户端
    pnpm start
    EXIT_CODE=$?
    
    # 检查退出状态码是否是 99（代表自更新信号）
    if [ $EXIT_CODE -eq 99 ]; then
        echo "[SHERIFF] Self-update signal detected (exit code 99)."
        echo "[SHERIFF] Executing git reset & pull..."
        
        # 回退到 git 仓库根目录执行更新
        cd ..
        git reset --hard HEAD
        git pull
        
        # 回到 mobile 目录准备重启
        cd mobile
        echo "[SHERIFF] Update complete. Restarting client in 2 seconds..."
        sleep 2
    elif [ $EXIT_CODE -eq 0 ]; then
        # 正常退出，不再重启
        echo "[SHERIFF] Client exited normally with code 0. Stopping daemon."
        break
    else
        # 异常崩溃，自动重启守护
        echo "[SHERIFF] Client crashed with code $EXIT_CODE. Restarting in 5 seconds..."
        sleep 5
    fi
done
