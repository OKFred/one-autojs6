# AutoJS6 手机设备客户端

手机端现在只执行本地注册过的可信脚本。Node Server 通过 MQTT 下发 `scriptId + params`，不会再下发 JavaScript 或 Shell 源码。

## 部署

1. 将 `autojs6-config.example.json` 复制为 `autojs6-config.json`。
2. 配置 `.env` 中的 MQTT 连接信息，并为每台设备设置唯一 `deviceId`。
3. 确认 `task-scripts/` 随 mobile 目录一起部署到 Termux。
4. 运行 `npm start`。客户端只订阅 `autojs6/v2/devices/{deviceId}/tasks`。

可通过 `AUTOJS6_CONFIG_PATH` 指向其他配置路径。修改配置后重启守护进程生效。

## 安全默认值

- `allowedScriptIds` 仅包含本地注册表中的脚本

v2 客户端没有远程 JavaScript/Shell 执行实现，也不订阅旧公共任务 Topic；这不是可动态打开的配置项。

即使有人能向 Broker 发布消息，未注册的脚本标识、错误设备标识、过期任务、非法任务 ID、版本不匹配和过大参数都会被拒绝。

## 本地脚本

| scriptId             | 文件                                | 用途                                             |
| -------------------- | ----------------------------------- | ------------------------------------------------ |
| `device.apps.list`   | `task-scripts/device_apps_list.js`  | 获取已安装应用列表                               |
| `app.install`        | `task-scripts/app_install.js`       | 下载并安装已登记的 HTTPS APK                     |
| `app.version.check`  | `task-scripts/app_version_check.js` | 检查本机应用版本                                 |
| `app.update.store`   | `task-scripts/app_update_store.js`  | 通过应用商店更新                                 |
| `app.update.zip`     | `task-scripts/app_update_zip.js`    | 安全解压并安装 HTTPS ZIP 更新包                  |
| `file.download`      | `task-scripts/file_download.js`     | 下载文件到 `/sdcard/`                            |
| `tiktok.post`        | `task-scripts/tiktok_post_v2.js`    | 图片/视频发布、素材轮换、标题/详情选择和链接回传 |
| `client.self-update` | 手机客户端固定动作                  | 退出码 99，交给本地 daemon 更新并重启            |

新增脚本时需要同时修改 `src/task-registry.ts` 与 Node Server 的可信脚本目录，并随手机客户端部署对应文件。不要让服务端传文件路径。

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

## Node 与 Worker 结果回传

任务包含 `callbackUrl` 时，手机会同时发送 MQTT 结果和 HTTP 结果。Node Server 通过 taskId、deviceId、scriptId、traceId 幂等落库：Node 运行时可依赖 MQTT Listener，Worker 运行时通过 HTTP callback 收取结果。
