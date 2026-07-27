# v1.2.0 (2026-07-28)

## What's Changed
* **Serial Task Queue / 任务串行排队**: Built-in memory queue to process tasks sequentially, completely preventing UI contention when multiple tasks are dispatched / 内置串行任务队列，不管下发多少并发任务，确保同一时刻只有单个脚本运行以防互相抢占屏幕资源。
* **Emergency Force Kill / 特权强打断**: Added support for `cat = "kill"` command to instantly clear pending queues and kill running applications / 支持下发特权 `kill` 指令，实现瞬间清空后续积压队列，并一键强杀终止当前正在执行的进程。
* **Double-Layer Watchdog / 双层失联防卡死体系**: Fully documented and battle-tested the dual timeout systems: Local Termux timer for script stuck, and PC backend Watchdog for total device disconnection / 完善了防卡死体系：包含移动端倒计时杀进程（应对脚本卡死），以及 PC 端轮询看门狗（应对手机断电断网等全盘失联）。

# v1.1.0 (2026-07-17)

## What's Changed
* **Mobile Daemon Decoupled / 移动端守护解耦**: Decoupled update via `node_daemon.sh` & code 99 / 通过 `node_daemon.sh` 脚本和状态码 `99` 实现进程级解耦自更新。
* **App Update & Check / 宿主应用更新与检查**: Added `check-update-task` & `execute-update-task` (OTA/Store compatibility) / 新增版本比对检查接口，支持 OTA 下载及商店无障碍自动点击更新（兼容 desc 属性）。
* **Controller Decoupling / 控制器解耦**: Split task controller into 9 independent routing files / 将单体类解耦拆分为 9 个独立路由控制器文件。
* **API Output Standard / 统一出参规范**: Enforced `{ ok, message, data: {} }` format, removing nulls / 统一接口响应规范为 `{ ok, message, data: {} }`，剔除 null 属性。
* **Swagger Docs / Swagger 自动文档**: Integrated JSDoc automatic scanning for Swagger UI live routing / 自动扫描控制器 JSDoc 并于启动时输出 Swagger 访问链接。
* **Dashboard & MQTT Web / 实时监控面板**: Added a Vue 3 static dashboard with MQTT WebSocket stream and ws-scrcpy iframe support for real-time monitoring / 新增 Vue 3 静态控制台面板，支持通过 WebSocket 实时查看 MQTT 消息，并集成了 ws-scrcpy 手机投屏画面流。
* **Test Suite / 测试验证脚本**: Added version check, update, and restart scripts in `test/scripts/` / 新增自更新、版本比对、以及执行更新等自动化验证测试脚本。
