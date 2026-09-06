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

本地演示入口为 [`/studio/`](http://127.0.0.1:3000/studio/)，包含 ws-scrcpy 画面入口、
设备运维按钮以及产品/开发/AI 的录制工作流说明。实现边界、验收步骤和多用户演进建议见
[`docs/remote-control-studio.md`](./docs/remote-control-studio.md)。

## 短期设备运维网关

该网关默认关闭，不影响现有 PC 服务启动。启用时必须成对配置：

```dotenv
DEVICE_OPS_REPORT_TOKEN=replace_with_at_least_16_random_characters
DEVICE_OPS_WS_URL=wss://control.example.com/api/ops/ws
```

两个变量都省略时，投屏及其他 PC API 正常可用，运维 POST 返回 503；只配置其中一个、
令牌短于 16 字符、URL 不安全或与 `/api/screen` 重名时，PC 会在启动时明确报错。投屏与
运维 WSS 由同一个 upgrade 路由器按路径分发，避免多个 path WSS 互相拒绝连接。

PC 提供 `POST /api/ops/tasks` 和 `GET /api/ops/tasks/:taskId`。POST 只创建内存任务、向
`autojs6/ops/v1/devices/{deviceId}/commands` 发布 `OPEN_SESSION` 并等待 MQTT QoS 1
确认；它不会等待手机执行结果，成功时固定返回 `taskId` 与 `EXECUTING`。终态通过 GET
轮询。当前 OPEN_SESSION 只经配置了账号与 TLS 的外部 EMQX 发布；旧的无 ACL 本地 Aedes
不会承载该可信运维命令，未配置外部 Broker 时 POST 会返回 502。任务与截图只在 PC 内存中
短期保留，不写入对象存储或本地磁盘。

浏览器 HTTP 继续使用 `Authorization: Bearer <ONE_AUTOJS6_API_TOKEN>`。手机连接
`DEVICE_OPS_WS_URL` 时使用独立的 `Authorization: Device <DEVICE_OPS_REPORT_TOKEN>`；
该值必须与手机上的 `AUTOJS6_REPORT_TOKEN` 相同。非本机 URL 必须使用 `wss://`，且其
Origin 必须同时加入手机 `ops.allowedWsOrigins`。不要在 URL、MQTT 消息或日志中传设备令牌。

下发网络信息读取：

```bash
curl -X POST http://localhost:3000/api/ops/tasks \
  -H "Authorization: Bearer $ONE_AUTOJS6_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "phone-001",
    "operation": "device.network.get",
    "params": {},
    "timeoutMs": 10000
  }'
```

固定操作目录包括能力查询、音量读取/设置/静音恢复、白名单目录存储统计与分页、前台
窗口、网络与电话信息、亮度读取/设置、临时截图和非响铃寻机提示。`device.alert.find`
只接受 500–5000 ms 时长且固定 `audible=false`。`device.audio.set.params.level` 是 Android
音频流的绝对索引而非百分比；应先调用 `device.audio.get` 读取该流的 `minimum/maximum`，
手机仍会对最终范围做权威校验。网关不接受 JavaScript、Shell、PTY、
任意文件路径或文件内容下载。截图最大 16 MiB；校验会话、设备、nonce、requestId、
operation 与 SHA-256 后，以 base64 放在终态任务的 `artifact.contentBase64`，并受 PC
总内存上限和保留期约束。

## AP 隔离远控会合与中继

当浏览器与手机处于 AP 隔离网络、不能直接访问彼此的局域网地址时，可启用服务端中继：

```dotenv
DEVICE_OPS_REPORT_TOKEN=replace_with_device_report_token
REMOTE_CONTROL_RELAY_WS_URL=wss://control.example.com/api/remote/ws
REMOTE_CONTROL_BROWSER_ORIGINS=https://studio.example.com
REMOTE_CONTROL_ALLOW_P2P_NEGOTIATION=false
# 仅在上一项为 true 时启用：
# REMOTE_CONTROL_STUN_URLS=stun:stun.cloudflare.com:3478
```

`POST /api/remote/sessions` 使用浏览器 Bearer Token 创建内存租约，严格限制同一设备只有一个
控制者。服务端通过 `autojs6/remote/v1/devices/{deviceId}/commands` 发布一次性设备票据，
并只在创建响应中显示一次 `browserTicket`。POST 返回 `taskId + EXECUTING`，不等待任何一端
连接；状态通过 `GET /api/remote/sessions/:sessionId` 查询，关闭使用
`POST /api/remote/sessions/:sessionId/close`。

手机和浏览器都主动出站连接同一个 relay WSS，并在首个 `relay.hello` JSON 帧中提交票据；
票据不进入 URL 或 query。设备还必须提供独立的 `Authorization: Device` 长期凭据，浏览器
只允许来自显式 Origin 集合并使用一次性票据。双方收到 `relay.ready` 后，服务端默认只透明
转发有界二进制 scrcpy 帧：浏览器到设备单帧最大 64 KiB，设备到浏览器最大 4 MiB，并限制
背压、会话总流量与 30 分钟最大租期。任一端断开即结束租约，不自动重放控制帧。

握手资源也按凭据隔离：只有有效 `Authorization: Device` 会进入 4 MiB 设备 WSS；无凭据且
Origin 合法的请求进入 64 KiB controller WSS，错误凭据直接拒绝。应用按直连地址限制每十秒
12 次 upgrade。公网部署时
反向代理必须另外按真实客户端 IP 限制 upgrade 速率与并发数，因为应用不会信任
`X-Forwarded-For`，经反代时只能看到代理地址。

服务端没有 Shell、JavaScript、任意文件或命令执行入口；手机端只能把控制方向的数据交给固定
本机 scrcpy 控制协议端点。P2P 不是默认路径：只有显式启用、配置至少一个 `stun:`/`stuns:`
URL，并请求 `p2p-preferred` 时才允许严格的 SDP/ICE 信令。v2 两端先协商传输，最终
`relay.ready` 之前禁止 scrcpy 二进制帧；协商失败或十秒超时会直接选择 relay。运行中的 P2P
失效时服务端进入 `RECOVERING_TRANSPORT`，冻结 WSS 二进制，只有设备重建本地 scrcpy 并确认
`relay.transport.state` 后才重新放行 relay。任一端只支持 `autojs6-remote-v1` 时自动使用原
relay 协议，不会向旧客户端发送 v2 控制帧。

设备通过 `autojs6/remote/v1/devices/{deviceId}/events` 上报 `CONNECTING`、`CONNECTED`、
`CLOSED` 或 `REJECTED`。PC 会严格关联 Topic、设备、租约和时间窗；后两种状态会立即结束
异步租约并释放该设备的单控制锁。完整帧结构见
[`docs/remote-control-relay.md`](./docs/remote-control-relay.md)。

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
