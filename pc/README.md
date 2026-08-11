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

`src/scripts/` 中已经删除不再受控制器读取的 TikTok 脚本；手机端注册的 `tiktok.post` 是唯一脚本真源。

## TikTok v2 异步契约

`POST /api/tiktok/post` 继续下发 `tiktok.post`、`scriptVersion=1`，请求参数改用 `contractVersion=2`。接口只返回异步受理结果，不等待手机发布完成；使用返回的 `resultUrl` 轮询终态。

发布一个视频：

```bash
curl -X POST http://localhost:3000/api/tiktok/post \
  -H "Authorization: Bearer $ONE_AUTOJS6_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "contractVersion": 2,
    "action": "publish",
    "expectedHandle": "creator_account",
    "media": {
      "mode": "direct",
      "kind": "video",
      "path": "/sdcard/Download/tiktok-materials/example.mp4"
    },
    "content": {
      "title": "Evening walk",
      "details": "A quiet moment from today."
    },
    "policy": {
      "minIntervalSeconds": 1800,
      "maxPostsPerDay": 3,
      "materialReuseSeconds": 86400,
      "captionReuseSeconds": 86400
    },
    "link": { "maxAttempts": 8, "retrySeconds": 15 },
    "timeout": 420
  }'
```

- `action` 支持 `publish`、`preflight`、`recover`、`status`。
- `publish` 一次只发布一个素材；`media.mode=pool` 可通过 `paths` 或 `directory` 提供候选池，手机按内容指纹选取一个素材。
- `publish` 未传 `publicationId` 时 PC 生成 UUID 并在受理响应中返回。调用方必须保存它；补链和查询必须使用原 ID。
- `expectedHandle` 只是请求侧二次断言，不能覆盖手机 `autojs6-config.json` 中固定的账号。
- 请求策略只能收紧手机端的频率与复用保护，不能放宽本机上限。
- 如果终态为 `PUBLISHED_LINK_PENDING` 或 `PUBLISH_OUTCOME_UNKNOWN`，不要再次执行 `publish`；改用原 `publicationId` 调用 `recover`。

补链示例：

```json
{
  "contractVersion": 2,
  "action": "recover",
  "publicationId": "8fa04e65-0c0c-46ca-bdb2-00bd21e53c28",
  "link": { "maxAttempts": 8, "retrySeconds": 15 }
}
```

旧版 `title/details/imagePath/videoPath/materialDir` 等扁平发布字段仍会归一化为 v2。旧 `linkOnly=true` 只有同时提供原 `publicationId` 才会映射为 `recover`；缺少 ID 时返回 400，不会通过“主页最新作品”猜测链接。
