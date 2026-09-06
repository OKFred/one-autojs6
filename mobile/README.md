# AutoJS6 手机设备客户端

手机端现在只执行本地注册过的可信脚本。Node Server 通过 MQTT 下发 `scriptId + params`，不会再下发 JavaScript 或 Shell 源码。

## 开发运行

1. 将 `autojs6-config.example.json` 复制为 `autojs6-config.json`。
2. 配置 `.env` 中的 MQTT 连接信息，并为每台设备设置唯一 `deviceId`。
3. 确认 `task-scripts/` 随 mobile 目录一起部署到 Termux。
4. 仅开发时运行 `npm start`。客户端订阅业务任务和独立部署管理主题。

可通过 `AUTOJS6_CONFIG_PATH` 指向其他配置路径。修改配置后重启守护进程生效。

## 安全默认值

- `allowedScriptIds` 仅包含本地注册表中的脚本

v2 客户端没有远程 JavaScript/Shell 执行实现，也不订阅旧公共任务 Topic；这不是可动态打开的配置项。

即使有人能向 Broker 发布消息，未注册的脚本标识、错误设备标识、过期任务、非法任务 ID、版本不匹配和过大参数都会被拒绝。

## 本地脚本

| scriptId                | 文件                                    | 用途                                             |
| ----------------------- | --------------------------------------- | ------------------------------------------------ |
| `device.apps.list`      | `task-scripts/device_apps_list.js`      | 获取已安装应用列表                               |
| `app.install`           | `task-scripts/app_install.js`           | 下载并安装已登记的 HTTPS APK                     |
| `app.version.check`     | `task-scripts/app_version_check.js`     | 检查本机应用版本                                 |
| `app.update.store`      | `task-scripts/app_update_store.js`      | 通过应用商店更新                                 |
| `app.update.zip`        | `task-scripts/app_update_zip.js`        | 安全解压并安装 HTTPS ZIP 更新包                  |
| `file.download`         | `task-scripts/file_download.js`         | 下载文件到 `/sdcard/`                            |
| `tiktok.post`           | `task-scripts/tiktok_post_v2.js`        | 图片/视频发布、素材轮换、标题/详情选择和链接回传 |
| `device.network.switch` | `task-scripts/device_network_switch.js` | Wi-Fi、以太网和蜂窝网络切换与失败恢复            |

新增脚本时需要同时修改 `src/task-registry.ts` 与 Node Server 的可信脚本目录，并随手机客户端部署对应文件。不要让服务端传文件路径。

## 正式发布与隔离部署

- 正式客户端只由 `vX.Y.Z` Tag 构建，Tag 必须与 `mobile/package.json` 一致。
- 构建机需要 Go 1.24+；发布脚本先测试 `rtc-sidecar`，再以
  `GOOS=android GOARCH=arm64 CGO_ENABLED=0` 生成 Pion helper。生成的 ELF 只进入发布归档，
  不写入源码目录。
- CI 生成含逐文件 SHA-256 的不可变归档并通过 Node Server 预签名地址直传 R2/S3。
- 手机一次性运行 `bootstrap/install-supervisor.sh` 安装独立 supervisor；普通版本不能覆盖它。
- `releases/` 保存只读版本，`state/<environment>` 与 `logs/<environment>` 按环境隔离，`management.env` 固定管理通道。
- supervisor 在每次启动目标组合前创建权限为 `0700` 的环境 state、log 和部署运行目录，空环境也不会复用其他环境的状态目录。
- `node_daemon.sh` 只启动已安装 supervisor，不再执行 `git pull/reset`；`client.self-update` 已禁用。
- 默认 `GRACEFUL` 排空，`FORCE` 需二次确认。新组合 90 秒内未就绪会自动切回上一健康组合。

完整目录和迁移说明见 `bootstrap/install-supervisor.sh`。原手机仓库目录在金丝雀稳定观察期内保留，用作人工恢复入口。
旧 Magisk 启动脚本若备份在 `/data/adb/service.d/`，必须移出该目录或移除可执行位；仅修改文件后缀不能阻止 Magisk 启动它，否则会形成新旧客户端双实例。

## 优先级与显式抢占

- 队列按 `HIGH > NORMAL > LOW` 执行，同级保持接收顺序。
- 网络切换默认 HIGH，其他脚本默认 NORMAL；旧请求可省略优先级和抢占字段。
- `preemptRunning=true` 只在新任务优先级不低于运行中任务时生效。原任务返回 `CANCELLED/PREEMPTED_BY_TASK`，不会自动重跑。
- 所有脚本均允许显式抢占，但 TikTok、安装、下载、更新和网络切换可能已经产生不可回滚副作用，调用方必须明确承担风险。
- 网络检测最长 120 秒，任务最长 150 秒。PC/Node 默认多预留 20 秒，手机最终执行端要求至少保留 15 秒用于失败恢复和结果回传。

## TikTok 参数示例

```json
{
  "clientId": "phone-001",
  "scriptId": "tiktok.post",
  "params": {
    "materialDir": "/sdcard/Download/tiktok-materials",
    "imagePaths": [],
    "videoPaths": [],
    "titles": ["今天的小记录", "分享一个瞬间"],
    "detailsPool": ["喜欢就收藏起来吧", "你更喜欢图片还是视频？"],
    "minIntervalSeconds": 1800,
    "maxPostsPerDay": 3,
    "linkMaxAttempts": 8,
    "linkRetrySeconds": 15
  },
  "timeoutMs": 420000
}
```

上述 JSON 作为 Node Server `POST /admin/mobile/async-task/dispatch` 的请求体。最终作品链接位于任务详情的 `resultDataJson.postUrl`（字段本身为 JSON 字符串）。

图片详情或视频文案需要确定性输入时，可在手机本机配置中启用受信任的
`com.github.uiautomator/.AdbKeyboard`。仓库默认关闭；启用前必须把已安装
APK 的 SHA-256 写入 `tiktok.adbKeyboard.apkSha256`。客户端仅在
`tiktok.post/publish` 执行期间临时启用并切换输入法，结束、超时、抢占或
进程重启后都会恢复原输入法并重新禁用该包。任务参数不能覆盖这些本机设置，
也不会启动该包的 UIAutomator、HTTP、屏幕或模拟定位服务。

可在本机配置中启用 `tiktok.networkPolicy`，作为所有会打开 TikTok 的动作的
发布前网络门禁。初始只允许 `GB`：两个独立 IPv4 地区探针必须一致，IPv6
必须同样命中允许地区或完全不可用；任一地区条件失败都会在打开 TikTok 前
拒绝任务。`ip111.cn` 作为辅助连通性诊断，不参与放行判定，因为部分代理节点
会单独阻断该站。探针结果只记录国家代码、时间和耗时，不记录完整公网 IP。
任务参数不能关闭门禁或覆盖探针地址。

```json
{
  "tiktok": {
    "networkPolicy": {
      "enabled": true,
      "allowedCountries": ["GB"],
      "requireWifi": true,
      "probeTimeoutMs": 12000
    }
  }
}
```

路由节点或设备 ACL 变更后，可在手机 Termux 中运行 `pnpm network:check`。
它会在至少两分钟内连续采样五次，且不会输出公网 IP。PassWall 页面上的
“点我检测”只代表节点/主线路基础连通性，不能代替这项手机实际出口检查。

任务超时或显式抢占时，客户端先用 AutoJS6 `engines.all()` 精确匹配并停止
当前任务脚本；不会停止事件监听。只有定向停止失败时才使用整包
`am force-stop`，随后恢复固定的 AutoJS6 无障碍组件，恢复前不会调度下一项。

## 事件监听

`autojs6-config.json` 可分别启用：

- `battery`
- `network`
- `sms`
- `notification`

通知监听支持 `packageAllowList` 和 `packageDenyList`。电量、网络只在状态变化时产生事件；短信和通知每次产生事件。事件包含唯一 `eventId`，统一发布到 `autojs6/v2/devices/{deviceId}/events`。Observer 日志不会记录号码或正文；共享存储中的事件交换文件采用原子轮转，读取后立即删除，避免敏感正文长期残留。

## 设备主动上报

- Presence 每 60 秒上报一次，只包含状态和时间；MQTT retained + Will 支持 Node 立即判定异常离线。
- Device Info 在每个进程中只采集一次。重连会重发内存缓存，不会重复读取 IMEI、序列号等敏感标识。
- IMEI 会尝试读取最多四个卡槽并去重；读取失败标记为 `unavailable`，不会阻止客户端运行。
- Node 模式使用 MQTT。Worker 模式在配置中将 `report.transport` 设为 `http`，并通过环境变量提供 `AUTOJS6_REPORT_TOKEN`；`both` 可用于迁移期双上报，事件依靠相同 `eventId` 幂等。

HTTPS 地址应指向设备业务根路径，例如：

```text
AUTOJS6_REPORT_URL=https://example.com/api/v1/admin/mobile/device
```

令牌由管理端“设备状态”抽屉生成或重置，明文只显示一次，不应写入 `autojs6-config.json` 或日志。

## 短期设备运维 WSS

日常前台任务仍通过 MQTT v2 可信脚本队列执行。启用 `ops.enabled` 后，客户端额外订阅
`autojs6/ops/v1/devices/{deviceId}/commands`；只有收到短期会话命令时才主动连接配置白名单内的
WSS Origin，会话默认由服务端限制为 10 分钟且最长 30 分钟。

运维通道只接受固定的结构化操作：音量读取/设置/静音恢复、屏幕亮度读取/设置、存储统计、
白名单目录分页、前台应用/Activity/窗口、网络与信号信息、脱敏的 SIM/订阅信息、找机提醒、
屏幕截图和能力查询。它不支持任意 JavaScript、Shell、PTY、ttyd 或文件内容下载。文件根目录
通过 `ops.fileRoots` 配置；客户端日志和部署运行目录由进程自动加入，密钥和业务状态目录默认
不开放。启用运维前必须设置 `AUTOJS6_REPORT_TOKEN`，该设备凭据只用于 WSS 请求头，不会出现
在 MQTT 命令或 URL 中。

- `device.screen.brightness.get/set` 使用 `1..255` 的整数亮度和 `manual`/`automatic` 模式；最小值
  不允许设为 0，避免远程把屏幕调成近似全黑。设置失败时客户端会尽力恢复之前的亮度和模式。
- `device.network.get` 保留兼容字段，并新增结构化网卡地址、Wi-Fi RSSI/速率/频率及可用的 LTE/NR
  信号字段。`device.telephony.get` 只返回结构化的卡槽、运营商、注册状态和手机号可用性；手机号
  最多保留末四位掩码，不返回 IMSI、ICCID、IMEI 或任何原始系统诊断文本。
- `device.alert.find` 只接受 `500..5000` 毫秒的单次提醒：发布可见通知并请求振动，使用系统的
  force 选项绕过当前 DND 对振动的抑制，但不修改 DND 设置。当前 Termux Node 运行时没有可靠的
  固定音频播放后端，因此能力会明确返回 `audible: false`；需要声音时应另行提供受控的 AutoJS6
  或 helper APK 铃声操作，不能把通知/振动成功表述为已经响铃。

`device.screen.capture` 由 Termux Node 进程以低优先级执行固定的 `screencap -p`，不会启动 AutoJS、
进入业务任务队列或抢占前台任务。PNG 最大 16 MiB，以单个 WSS 二进制帧临时转发；同一设备同一
时间最多一个截图请求，发送完成后立即释放内存，不写入日志、状态目录或对象存储。Android
`FLAG_SECURE` 页面按系统规则可能显示为黑色，不尝试绕过。

`device.ui.target-at` 是录制后生成可维护代码所用的只读点选查询。请求只接受录制坐标和录制画布
尺寸；客户端为每次请求创建唯一的 `/data/local/tmp` XML 路径，执行固定的 `uiautomator dump`，
在手机端完成 1 MiB、10,000 节点、256 层深度限制下的解析，并在 `finally` 中删除临时文件。
返回值只包含命中的单个控件、前台组件、显示尺寸和采集时间；控件 ID、文本、类型与边界必须来自
同一个节点。文本只有命中内置严格通用控件文案白名单时才是 literal，编辑框使用参数键，联系人名、
消息摘要以及其他未复核短文本一律只返回脱敏元数据。完整层级、候选列表、手机号、验证码和输入内容不会通过 WSS 返回。录制方向与当前
屏幕方向不一致时返回空目标，调用方需要先恢复到相同页面和方向。

## 主动出站屏幕远控 relay

启用 `remoteControl.enabled` 后，手机订阅
`autojs6/remote/v1/devices/{deviceId}/commands`。MQTT 的 `OPEN_REMOTE_SESSION` 只负责可信邀请；
它不承载视频，也不能指定本地地址。手机校验设备 ID、30 秒新鲜度、30 秒至 30 分钟租约、一次性
ticket 和 `allowedRelayOrigins` 后，主动连接 `/api/remote/ws`。设备长期令牌只放在 WSS
`Authorization: Device ...` 请求头，一次性 ticket 只放在首个 `relay.hello` JSON 帧，二者都不放
入 URL 或生命周期事件。

手机同时提供 `autojs6-remote-v2` 和旧 `autojs6-remote-v1` 子协议。v1 行为保持透明 WSS relay；
v2 在两端 hello 后先由服务端选择传输，最终 `relay.ready` 到达之前不会连接
`ws://127.0.0.1:8886/`。控制端已先收到 ready 而产生的少量在途输入只会按来源进入有界缓冲，
等手机确认同一传输且本地 scrcpy 就绪后才按序执行，因此不会把同一条 scrcpy 数据跨两种传输重复发送。

`p2p-preferred` 使用随发布包携带的纯 Go/Pion arm64 sidecar。Node 仍独占 MQTT、WSS ticket 和
审计职责，只把服务端提供的 STUN 地址、SDP、ICE candidate 与二进制 scrcpy 数据通过 stdin/stdout
四字节大端长度帧传给 sidecar。sidecar 不监听端口，也拿不到长期令牌和一次性 ticket。Node 每次
启动 helper 前都按 `release-manifest.json` 重新计算 SHA-256，匹配后幂等设置 `0500`，并以
`shell: false` 启动。源码开发模式没有 manifest 覆盖的 helper 时，P2P 协商会明确失败并由服务端
选择原有 WSS relay。

DataChannel 固定为可靠有序的 `scrcpy-binary-v1`，协议名为
`one-autojs6.scrcpy-binary.v1`。每个 WebSocket 消息使用 20 字节 `A6DC` 大端头，有效载荷取
`min(12 KiB, negotiatedMaxMessageSize - 20)`，重组后才交给 ws-scrcpy；浏览器控制消息最多
64 KiB，设备媒体消息最多 4 MiB。
同一角色的 SDP、ICE 和 ready/failed 状态共用从 0 开始的严格单调序号；状态发出后不再发送该
attempt 的后续 candidate。
重组超过 5 秒、DataChannel 缓冲超过 8 MiB、非法文本/越序帧都会触发受控降级。

P2P 运行中断开先保留 3 秒瞬时恢复窗口；继续失败时手机冻结数据面并关闭旧本地 scrcpy，服务端
广播 `relay.transport recovering` 后手机重建本地连接，发送 `relay.transport.state ready`，只有
收到服务端 `phase=ready` 后才把已缓存的初始化帧按序写入 WSS。这一恢复会产生短暂画面中断，
不会重放触控输入或旧 ticket。`CONNECTING/CONNECTED/CLOSED/REJECTED` 事件仍只包含固定诊断，
不记录 SDP、candidate 地址或凭据。

这条链路没有在手机开放公网或局域网监听端口，AP 隔离不会阻断手机主动发起的 MQTT + WSS。
本地 ADB 演示与未来公网环境只切换 relay 地址和 Origin 白名单：

1. 本地 relay 在电脑 `127.0.0.1:<port>` 监听，并执行
   `adb reverse tcp:<port> tcp:<port>`；手机配置 `ws://127.0.0.1:<port>` Origin，MQTT 邀请使用
   `ws://127.0.0.1:<port>/api/remote/ws`。
2. 公网环境配置明确的 `wss://<host>` Origin，服务端邀请使用同源
   `wss://<host>/api/remote/ws`，不再需要 ADB reverse。

第一版只配置 STUN，不部署 TURN；对称 NAT 等无法直连的网络会在 10 秒协商期限内回到 WSS。
语音、ICE restart 和无缝热切换不在当前实现内。mobile peer 也不会安装 ws-scrcpy Android server：
仍须用固定版本和摘要的 jar，通过受控 shell/root 生命周期管理器确保它只监听手机
`127.0.0.1:8886`。旧 ws-scrcpy server 自身没有 TLS 或鉴权，因此禁止改成 `0.0.0.0` 或把 8886
暴露到 LAN。

本地临时部署只通过 ADB 把同一不可变发布归档传给 supervisor。不要单独复制 helper 绕过
manifest；调试 helper 时可将构建产物临时放到 `/data/local/tmp` 做启动冒烟测试，
正式 canary 必须让 `bin/rtc-datachannel-android-arm64` 与其 SHA-256 一起进入发布 manifest。

## Node 与 Worker 结果回传

任务包含 `callbackUrl` 时，手机会同时发送 MQTT 结果和 HTTP 结果。Node Server 通过 taskId、deviceId、scriptId、traceId 幂等落库：Node 运行时可依赖 MQTT Listener，Worker 运行时通过 HTTP callback 收取结果。
