# v1.1.0 (2026-07-17)

## What's Changed
* **Mobile Daemon Decoupled Restart / 移动端守护重启解耦**
  Implemented process-level update decoupling via `node_daemon.sh` and exit code `99`. The client signals exiting, and the daemon handles git reset/pull and restart.
  将自更新从 Node 进程内剥离，客户端成功回调后以退出码 `99` 退出，由 `node_daemon.sh` 脚本在根目录执行 Git 升级与进程自动重启。

* **Host App Inspection & OTA/Store Updates / 宿主 App 远程更新与版本检查**
  Added `POST /api/apps/check-update-task` to compare local app versions via reflection, and `POST /api/apps/execute-update-task` to support OTA APK download and App Store accessibility auto-clicking updates (compatible with `desc` attributes).
  新增版本检查接口（比对 PackageManager 本地版本）以及执行更新接口，支持 OTA 下载覆盖安装与拉起商店并无障碍自动点击“更新/升级/Update”按钮（兼容 Content-Description 属性）。

* **API Controller Decoupling / 控制器解耦拆分**
  Refactored the monolithic controller file into 9 independent Hono-friendly controllers under `pc/src/controller/`.
  将原本臃肿的单个控制器文件，彻底解耦拆分为 `pc/src/controller/` 下的 9 个高内聚独立路由控制器文件。

* **Response Output Standardization / 统一接口出参**
  Enforced `{ ok, message, data: {} }` response format. Purged all `data: null` occurrences with empty objects.
  规范化接口出参格式，剔除了所有的 `data: null` 返回，无数据时统一回传空对象 `{}`。

* **Interactive OpenAPI Docs / Swagger 自动文档系统**
  Integrated `swagger-jsdoc` to parse JSDoc-YAML on the fly and print access URLs on startup.
  集成 `swagger-jsdoc` 自动扫描控制器 JSDoc 并生成 OpenAPI 文档，服务启动时自动打印 Swagger UI 的访问链接。

* **Verification Suite / 自动化测试脚本**
  Added `test_device_update.js`, `test_check_update.js`, and `test_execute_update.js` under `test/scripts/`.
  新增自更新、版本比对、以及执行更新等自动化验证与轮询测试脚本。
