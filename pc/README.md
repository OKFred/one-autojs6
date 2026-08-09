# PC 兼容服务

PC 服务保留 Dashboard、SMB 代理、ADB 投屏和旧 HTTP 路由，但设备任务统一转发到 Node Server。PC 不再读取 `src/scripts/`，也不会直接向手机下发 JavaScript 或 Shell。

## 必需配置

```dotenv
NODE_SERVER_BASE_URL=http://192.168.1.10:8787/api/v1
NODE_SERVER_TOKEN=hdr_xxx
AUTOJS6_CLIENT_ID=phone-001
```

`NODE_SERVER_TOKEN` 需要 Node Server 的 `admin.mobile.async_task:dispatch` 和读取任务权限。`NODE_SERVER_BASE_URL` 必须是手机也能访问的地址，因为 Node Server 会从下发请求生成设备结果 callback URL；部署为 Worker 时填写 Worker 正式域名。

## 兼容路由变化

- `POST /api/tasks`：请求体改为 `{ scriptId, params, timeout, clientId? }`，不再接受 `cat/script/useRoot`。
- `GET /api/tasks/:taskId`：代理 Node Server 的任务详情。
- `GET /api/tasks`：代理 Node Server 的任务列表。
- TikTok、应用列表、版本检查、文件下载、应用更新和客户端自更新路由保持原 URL，但内部改为可信 scriptId。

`src/scripts/` 仅保留为迁移对照，不再有控制器读取它们。确认旧调用全部升级后可以删除。
