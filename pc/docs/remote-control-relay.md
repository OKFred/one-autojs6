# Remote Control Relay v1/v2

该控制面用于浏览器和手机处于 AP 隔离、只能分别主动访问服务端的场景。它不依赖 LAN 直连，
也不把票据放入 URL。

## 创建与状态

浏览器先以 PC Bearer Token 调用：

```http
POST /api/remote/sessions
Content-Type: application/json

{
  "clientId": "phone-001",
  "ttlMs": 600000,
  "transportPreference": "relay"
}
```

服务端先占用该设备唯一控制租约，再向认证 MQTT Broker 发布：

```json
{
  "protocolVersion": 1,
  "type": "OPEN_REMOTE_SESSION",
  "sessionId": "...",
  "deviceId": "phone-001",
  "relayWsUrl": "wss://control.example.com/api/remote/ws",
  "deviceTicket": "...",
  "issuedAt": 0,
  "expiresAt": 0
}
```

Topic 为 `autojs6/remote/v1/devices/{deviceId}/commands`。HTTP 只等待 MQTT QoS 1 确认，
随后以标准信封返回 `taskId`、`status=EXECUTING`、`sessionId`、`relayWsUrl` 和只显示一次的
`browserTicket`。轮询响应不包含任何票据。

公网地址必须使用 WSS 且路径固定为 `/api/remote/ws`。只有 ADB reverse 本机演示可以使用
精确的 `ws://127.0.0.1:<port>/api/remote/ws`；`localhost`、LAN 明文 WS、自定义路径、查询参数
和 URL 凭据都会在服务端启动时或手机解析时被拒绝。

设备将非秘密生命周期事件发布到
`autojs6/remote/v1/devices/{deviceId}/events`：

```json
{
  "protocolVersion": 1,
  "type": "REMOTE_SESSION_EVENT",
  "eventId": "...",
  "sessionId": "...",
  "deviceId": "phone-001",
  "state": "CONNECTING",
  "code": "REMOTE_CONNECTING",
  "message": "...",
  "timestamp": 0
}
```

状态只允许 `CONNECTING`、`CONNECTED`、`CLOSED`、`REJECTED`。服务端同时校验 Topic、
设备、租约和时间窗；`CLOSED` 或 `REJECTED` 会立即终止异步任务并释放单设备控制租约。
外部 Broker 的 PC 账号需要该 events Topic 的订阅权限，设备账号需要对应 commands Topic
的订阅权限和 events Topic 的发布权限；中继关闭时 PC 不会额外订阅 events Topic。

## 两端出站 WSS

两端都连接固定路径 `/api/remote/ws` 的 `relayWsUrl`。新客户端同时声明
`autojs6-remote-v2, autojs6-remote-v1`，服务端优先选择 v2；旧客户端只声明 v1。每个客户端
必须按服务端实际选中的子协议发送相同版本的首个 `relay.hello` 文本帧，并在五秒内完成。
其他 pathname 会在 PC 配置启动检查和手机邀请解析时同时被拒绝。MQTT
`OPEN_REMOTE_SESSION` 保持 v1 原形，因此已部署的严格 v1 手机仍能收到邀请并通过 relay
完成会合。

浏览器：

```json
{
  "protocolVersion": 1,
  "type": "relay.hello",
  "role": "controller",
  "sessionId": "...",
  "ticket": "...",
  "timestamp": 0
}
```

设备除使用独立的 `Authorization: Device <token>` 握手头外，还发送：

```json
{
  "protocolVersion": 1,
  "type": "relay.hello",
  "role": "device",
  "sessionId": "...",
  "deviceId": "phone-001",
  "ticket": "...",
  "timestamp": 0
}
```

两个票据分别校验、只用一次，并且服务端只保存 SHA-256。v1 配对后两端收到：

```json
{
  "protocolVersion": 1,
  "type": "relay.ready",
  "sessionId": "...",
  "transport": "relay",
  "expiresAt": 0
}
```

v2 使用同一 hello 字段并把 `protocolVersion` 设为 2。最终选路后收到的
`relay.ready` 也使用版本 2；因旧 peer 或 P2P 协商失败选择 relay 时，可额外包含安全的
`reasonCode`。最终 ready 之前不允许二进制帧。

relay 选定后只允许二进制 scrcpy 帧。服务端保持到达顺序，但不解释或执行内容；浏览器控制方向
单帧上限 64 KiB，设备媒体方向单帧上限 4 MiB。无效文本、超限帧、背压、总量超限、过期或
任一端断开都会终止整个租约。

upgrade 阶段会先校验长期 Device 凭据：只有有效 Device 请求进入 4 MiB WSS；未携带凭据且
Origin 合法的 controller 候选进入 64 KiB WSS，再接受一次性票据校验。错误凭据、非法 URL
或 Origin 会在 upgrade 前拒绝。PC 还按 TCP 直连远端地址限制每十秒最多 12 次 upgrade，
且地址表有固定容量。服务端不会信任可伪造的
`X-Forwarded-For`；公网反向代理必须在 TLS 边界按真实客户端 IP 配置连接速率、并发连接数和
请求体限制。应用内限速看到的是反代地址，不能替代该公网限制。

终止帧固定为：

```json
{
  "protocolVersion": 1,
  "type": "relay.closed",
  "sessionId": "...",
  "code": "REMOTE_SESSION_CLOSED",
  "message": "..."
}
```

## P2P v2 与恢复边界

`relay` 始终可用并且是默认值。启用 P2P 必须同时配置：

```dotenv
REMOTE_CONTROL_ALLOW_P2P_NEGOTIATION=true
REMOTE_CONTROL_STUN_URLS=stun:stun.cloudflare.com:3478
```

STUN 列表最多四项，只允许无凭据的精确 `stun:` 或 `stuns:` URL。第一阶段不接受 TURN URL，
也不在配置、协议或日志中保留 TURN 凭据。P2P 只在双方都协商到 v2 且会话请求
`p2p-preferred` 时启动；否则直接发送最终 `relay.ready transport=relay`。

双方 hello 后会话进入 `SELECTING_TRANSPORT`，服务端向两端发送：

```json
{
  "protocolVersion": 2,
  "type": "relay.p2p.start",
  "sessionId": "...",
  "attemptId": "...",
  "deadlineAt": 0,
  "iceServers": [{ "urls": ["stun:stun.cloudflare.com:3478"] }]
}
```

controller 是唯一 offerer，device 是唯一 answerer。双方各自使用一个由 signal 与 state 共享的
`sequence` 计数器，必须从 0 开始严格递增；所有 signal/state 都必须携带当前 `attemptId`。描述帧使用
`signalType=offer|answer` 与 `{ description: { type, sdp } }`，ICE 帧使用
`signalType=ice-candidate` 与 `{ candidate: { candidate, sdpMid?, sdpMLineIndex? } }`。不转发
空 candidate 或单独的 end-of-candidates 帧。任一角色发出 ready/failed 后停止发送该 attempt 的后续
candidate，避免服务端消费 state 后让对端看到序号空洞。

两端 DataChannel 均可用后分别发送 `relay.p2p.state state=ready`。可选诊断只允许候选类型
`host|srflx|prflx|relay` 和传输 `udp|tcp`，不得包含 IP、端口或 candidate 文本。两端 ready 后
服务端才发送最终 `relay.ready transport=p2p` 并进入 `ACTIVE`；此时 WSS 只承载信令、关闭和
审计控制帧，任何 WSS 二进制帧都会作为协议错误关闭租约。

任一端在初始协商中报告 failed，或十秒内未完成，服务端发送最终
`relay.ready transport=relay`。P2P 已激活后同一 attempt 报告 failed，会使会话进入
`RECOVERING_TRANSPORT` 并向两端发送 `relay.transport phase=recovering`。恢复期间输入与 WSS
二进制均冻结；device 重连本地 scrcpy 后发送：

```json
{
  "protocolVersion": 2,
  "type": "relay.transport.state",
  "sessionId": "...",
  "transport": "relay",
  "state": "ready"
}
```

服务端先按序发送 `relay.transport phase=ready`，再重新放行 relay 二进制。恢复十秒超时会终止
租约。轮询状态只暴露协商耗时、失败码以及候选类型/UDP/TCP；不会保存或返回 SDP、candidate
IP、一次性票据。P2P 协商不会扩大设备能力，也不会产生 Shell 或文件接口。
