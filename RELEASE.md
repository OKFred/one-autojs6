# Release Notes / 版本更新说明

## Version v1.1.0 (2026-07-17)

This release introduces major architectural refactoring and introduces advanced remote update/inspection capabilities for both the mobile client and target host applications.
本版本引入了重大的系统架构重构，并为移动端守护进程及宿主应用（如 Auto.js v6）提供了先进的远程更新与版本检查能力。

---

## Key Features & Enhancements / 核心功能与优化

### 1. Remote Update & Auto-Restart for Mobile Client / 移动端守护进程自更新与平滑重启
- **Decoupled Architecture**: Disassociated update & git pull logic from the Node process to the host daemon script `node_daemon.sh`, preventing read/write locks on the running JS runtime.
- **Exit Code 99 Signaling**: Client posts callback SUCCESS and exits with exit code `99`. The shell daemon captures it, runs Git reset/pull at the root repository, and automatically respawns the client.
- **Crash Recovery**: The daemon handles crashes by waiting 5 seconds and auto-relaunching, while normal shutdowns (code 0) terminate gracefully.
- **Node-Shell 进程级解耦**：将 Git 拉取与依赖安装从 Node 进程内剥离，交由外部守护脚本 `node_daemon.sh` 执行，彻底根除代码读写冲突与环境被占用导致的异常。
- **状态码 99 机制**：客户端在成功回传回调后以退出码 `99` 退出进程，由守护脚本拦截，自动回退到项目根目录安全执行 Git 升级并无缝重新启动。
- **崩溃自动恢复**：守护脚本同时负责了意外崩溃后延时 5 秒自动重启，以及正常退出码 `0` 的安全关闭。

### 2. Host App Version Check & Remote Update / 宿主 App 版本检查与执行更新
- **App Version Inspection (`POST /api/apps/check-update-task`)**: Dispatches a lightweight reflection script to inspect target app version details (`versionName` & `versionCode`) and performs a comparative update analysis against latest release metadata.
- **OTA Download Installation (`mode: 'download'`)**: Downloads the target APK to the device in the background. Callback is fired **immediately upon download completion** (preempting installation reboot) before triggering package installation.
- **App Store Accessibility Update (`mode: 'store'`)**: Automates store updates by launching Google Play or local App Stores directly to the target package page, and uses accessibility services to search for and click "Update" or "Upgrade" action buttons.
- **应用版本检查**：下发基于 PackageManager 反射机制的 Auto.js 脚本，获取当前包名版本并与 PC 指定的最新的版本对比判断是否可更新。
- **下载覆盖安装 (OTA)**：在手机端后台静默下载最新 APK，并设定在下载完成、拉起安装前**立刻回传 SUCCESS 结果**，保障安装覆盖导致进程终止时 PC 端不会误判为超时失败。
- **商店无障碍自动更新**：支持通过 Intent 拉起对应的应用商店，随后利用 Auto.js 的无障碍服务，自动在商店详情页面寻找包含“更新/升级/Update/Upgrade”关键字的按钮并触发点击。

### 3. Fine-Grained API Controller Decoupling / 控制器独立拆分
- Completely decoupled the monolithic `task.controller.ts` into **9 separate, high-cohesion controller files** under `pc/src/controller/` to facilitate cleaner component isolation, easier path mapping, and optimal JSDoc-based Swagger scanning.
- 彻底废除了臃肿的单体控制器类文件，将其解耦拆分为 `pc/src/controller/` 目录下的 **9 个独立高内聚路由控制器文件**，极大提升了代码的可读性，并为自动化 API 文档扫描铺平了道路。

### 4. Response Output Standardization / 接口出参风格统一
- Strict enforcement of the JSON root payload format: `{ ok: boolean; message: string; data: Record<string, any> }`.
- Completely purged all `data: null` configurations. Empty datasets or errors now strictly return an empty object `{}` to ensure type-safe client consumption.
- 全面推行统一的 `{ ok: boolean; message: string; data: Record<string, any> }` 根层出参结构。
- 根除了所有 `data: null` 表现，无数据返回或异常时一律强制封装为空对象 `{}`，确保客户端解析时的类型安全性。

### 5. Automated Interactive API Docs (Swagger) / Swagger 接口文档系统
- Integrated `swagger-jsdoc` and `@hono/swagger-ui` to scan JSDoc JSDoc-YAML comments automatically at boot time, eliminating static Swagger config files.
- Prints the Swagger UI URL `http://<IP>:<PORT>/swagger` logs directly on server startup.
- 支持自动扫描控制器中的 JSDoc 注释并转换生成 OpenAPI 3.1.0 接口定义文档。
- 服务器启动时控制台直观打印 Swagger UI 访问链接，方便随时测试。

---

## API Endpoints Matrix / 接口变动一览

| Endpoint / 接口路由 | Method | Description / 说明 | Response Data Schema |
| :--- | :---: | :--- | :--- |
| `/api/tasks` | `POST` | Dispatch general Auto.js/Shell task / 下发通用脚本与命令任务 | `{ taskId, status }` |
| `/api/callback` | `POST` | Process mobile task execution callback / 接收移动端状态回调 | `{}` |
| `/api/tasks` | `GET` | Retrieve in-memory task registry / 获取系统所有已追踪任务列表 | `{ tasks: [...] }` |
| `/api/tasks/:taskId` | `GET` | Get status & message of a single task / 查询单个任务状态 | `{ task: {...} }` |
| `/api/apps/task` | `POST` | Asynchronously fetch installed packages / 异步提取基础包名列表 | `{ taskId, status }` |
| `/api/apps/details-task` | `POST` | Asynchronously fetch rich app details / 异步提取全面包详情 | `{ taskId, status }` |
| `/api/devices/update-task` | `POST` | Execute git pull & restart daemon / 移动端守护进程自更新 | `{ taskId, status }` |
| `/api/apps/check-update-task` | `POST` | Inspect app versions via reflection / 检查宿主应用版本与更新状态 | `{ taskId, status }` |
| `/api/apps/execute-update-task` | `POST` | Run APK download/store accessibility update / 执行宿主应用 OTA/商店更新 | `{ taskId, status }` |

---

## Testing & Diagnostics / 测试验证支持

The following diagnostics scripts have been added under `test/scripts/` to verify functional compliance:
在 `test/scripts/` 目录下增加了以下自动化测试与验证脚本：
- **[test_device_update.js](test/scripts/test_device_update.js)**: Verifies the git self-update, delay-exit, and daemon automatic restart sequence of the Termux client.
- **[test_check_update.js](test/scripts/test_check_update.js)**: Verifies the Android app reflection checking flow.
- **[test_execute_update.js](test/scripts/test_execute_update.js)**: Validates APK download/installation flows and App Store view Intent triggering.
