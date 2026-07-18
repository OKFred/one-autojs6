# 未来规划与待办事项 (TODO)

## 1. 升级为真正实时的 ws-scrcpy 手机投屏
目前 Dashboard 中的手机屏幕投屏使用的是极简的“Node 原生截屏轮询流 (1FPS)”，画质和帧率较低且无法交互。
未来有时间解决 C++ 依赖（`node-gyp`、`node-pty`）编译环境问题后，可以重新启用 `ws-scrcpy` 方案。

### 恢复指南
1. 确保系统安装了 Visual Studio C++ 生成工具包以及 Python 环境变量。
2. 运行 `pnpm run scrcpy:install` 尝试安装 `ws-scrcpy`。
3. 若安装成功，在 `package.json` 的 `scripts` 保持如下配置：
   ```json
   "scripts": {
     "scrcpy:install": "git clone https://github.com/NetrisTV/ws-scrcpy.git ws-scrcpy && cd ws-scrcpy && npm install",
     "scrcpy:start": "cd ws-scrcpy && npm start",
     "dev:all": "concurrently \"pnpm run dev\" \"pnpm run scrcpy:start\""
   }
   ```
4. 将 `pc/public/dashboard/index.html` 中右侧显示画面的 `<img>` 标签，替换回 `<iframe>` 标签：
   ```html
   <div class="right-panel">
     <div class="ws-hint">确保已在后台启动 ws-scrcpy (端口: 8000)</div>
     <iframe src="http://localhost:8000" title="Scrcpy 屏幕流"></iframe>
   </div>
   ```
