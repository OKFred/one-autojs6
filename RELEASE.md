# v1.1.0 (2026-07-17)

## What's Changed
* **Mobile Daemon Decoupled / 移动端守护解耦**: Decoupled update via `node_daemon.sh` & code 99 / 通过 `node_daemon.sh` 脚本和状态码 `99` 实现进程级解耦自更新。
* **App Update & Check / 宿主应用更新与检查**: Added `check-update-task` & `execute-update-task` (OTA/Store compatibility) / 新增版本比对检查接口，支持 OTA 下载及商店无障碍自动点击更新（兼容 desc 属性）。
* **Controller Decoupling / 控制器解耦**: Split task controller into 9 independent routing files / 将单体类解耦拆分为 9 个独立路由控制器文件。
* **API Output Standard / 统一出参规范**: Enforced `{ ok, message, data: {} }` format, removing nulls / 统一接口响应规范为 `{ ok, message, data: {} }`，剔除 null 属性。
* **Swagger Docs / Swagger 自动文档**: Integrated JSDoc automatic scanning for Swagger UI live routing / 自动扫描控制器 JSDoc 并于启动时输出 Swagger 访问链接。
* **Test Suite / 测试验证脚本**: Added version check, update, and restart scripts in `test/scripts/` / 新增自更新、版本比对、以及执行更新等自动化验证测试脚本。
