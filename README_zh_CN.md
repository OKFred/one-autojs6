[English (README.md)](README.md)

# 基于 MQTT + HonoJS + Auto.js v6 的任务调度控制系统

本项目实现了一个基于 **MQTT 消息总线** 和 **HonoJS Web 服务** 的移动端（Termux）脚本自动下发、执行、超时控制与结果回传的轻量级系统。

---

## 架构概览

- **PC 端 (pc/)**:
  - 基于 **HonoJS** 运行 HTTP 服务。
  - 内置 **Aedes MQTT Broker** 作为消息中转站。
  - 提供任务下发和结果回调 API，并维护内存中的任务执行状态表。
  - 拥有主动轮询机制，若任务超时超过 `timeout + 10s`，自动判定为失败 (`TIMEOUT_MISSING`)。
- **移动端 (mobile/)**:
  - 运行在 **Termux** 环境下的 Node.js TypeScript 守护进程。
  - 订阅 MQTT 任务队列，动态为下发的脚本注入异常捕获与 HTTP 回传逻辑，生成临时脚本。
  - 使用 Root 权限的 Android `am` 指令拉起 **Auto.js v6** 运行脚本。
  - 支持双向强杀与清理机制：当执行超时自动强杀 Auto.js 和 Chrome；当任务成功时接收 PC 通知自动清理临时文件及定时器。
- **Demo 应用 (demo_chrome.js)**:
  - 提供的测试脚本，用于打开 Chrome 浏览器并访问百度网。

---

## 环境准备

### 1. PC 端

- 已安装 Node.js (推荐 v20+) 和 **pnpm** (推荐 v10+)。
- 已通过 USB ADB 正常连接到安卓设备。

### 2. 移动端 (安卓手机)

- **Auto.js v6** 已开启**无障碍服务**与 **Root 权限**。
- 安装了 **Termux**，且在 Termux 中安装了 `nodejs` 和 `pnpm`：
  ```bash
  pkg install nodejs
  npm install -g pnpm
  ```
- 移动端与 PC 端处于同一局域网（能够相互 Ping 通）。

---

## 快速开始

### 1. 依赖安装

在项目根目录下执行以下命令，该命令会基于 pnpm workspace 自动安装 PC 端和移动端的所有依赖：

```bash
pnpm install
```

### 2. 环境配置

#### PC 端配置：`pc/.env`

在 `pc/` 目录下创建 `.env` 文件，内容参考[.env.example](.env.example)

#### 移动端配置：`mobile/.env`

在 `mobile/` 目录下创建 `.env` 文件，内容参考[.env.example](.env.example)

### 3. 运行服务

#### 启动 PC 端主服务

在根目录下运行：

```bash
pnpm --filter one-autojs6-pc dev
```

启动成功后，控制台会输出：

```text
[MQTT] Broker is running on port 1883
[HTTP] Server is running on http://localhost:3000
```

#### 启动移动端守护进程

将整个目录或 `mobile/` 文件夹拷贝到手机的 Termux 路径中，在 `mobile/` 目录下执行：

```bash
pnpm start
```

启动成功后，控制台会显示已成功连接 MQTT 并订阅相关主题：

```text
[CLIENT] Connected to MQTT Broker successfully.
[CLIENT] Subscribed to topic: autojs6/tasks
[CLIENT] Subscribed to topic: autojs6/status
```

---

## 接口使用说明

PC 服务端提供了以下 HTTP 接口：

### 1. 下发通用任务

- **URL**: `POST /api/tasks`
- **Content-Type**: `application/json`
- **请求参数**:
  - `cat` (string, 可选, 默认 `autojs6`): 任务分类。可设置为 `autojs6` (在 Auto.JS 中执行) 或 `shell` (在 Termux 中直接执行 Shell 脚本)。
  - `script` (string, 必须): 需要执行的脚本内容（Auto.JS 脚本或 Shell 命令）。
  - `timeout` (number, 可选, 默认 30): 任务执行超时时间（秒）。超过该时间后移动端会强杀任务关联应用/进程。
  - `useRoot` (boolean, 可选, 默认 false): 仅在 `cat === 'shell'` 时生效。是否以 Root 权限 (`su -c`) 运行该命令。
- **测试脚本示例**:
  您可以使用 `test/scripts/test_browser.js` 脚本来快速发起浏览器网页内容抓取测试。该脚本使用 Node.js 原生的 `fetch` 发送任务并自动轮询最终状态。

  运行方法:

  ```bash
  # 直接运行
  node test/scripts/test_browser.js

  # 加载 pc/.env 配置运行 (Node 20.6+)
  node --env-file=pc/.env test/scripts/test_browser.js
  ```

  另外，您也可以使用 `test/scripts/test_sms.js` 脚本来快速测试获取手机上全部短信的记录（通过 Root 级 content query 命令行查询，并以表格美化输出）：

  ```bash
  # 直接运行
  node test/scripts/test_sms.js

  # 加载配置运行
  node --env-file=pc/.env test/scripts/test_sms.js
  ```

- **返回响应**:
  ```json
  {
    "success": true,
    "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "status": "EXECUTING"
  }
  ```

### 2. 下发获取设备应用包名列表任务

- **URL**: `POST /api/apps/task`
- **Content-Type**: `application/json`
- **Query 参数**:
  - `type` (string, 可选, 默认 `all`): 过滤的应用类型。可设为 `all` (全部包名)、`third` (仅第三方应用包名)、`system` (仅系统应用包名)。
  - `timeout` (number, 可选, 默认 15): 任务执行超时时间（秒）。
- **说明**: 该接口异步下发 Shell 命令 `pm list packages`，执行极快。任务成功后，任务结果的 `message` 字段中将包含返回的包名（以换行符分隔）。
- **返回响应**:
  ```json
  {
    "success": true,
    "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "status": "EXECUTING",
    "message": "Apps package task dispatched"
  }
  ```

### 3. 下发获取设备应用详细信息任务

- **URL**: `POST /api/apps/details-task`
- **Content-Type**: `application/json`
- **Query 参数**:
  - `timeout` (number, 可选, 默认 30): 任务执行超时时间（秒）。
- **说明**: 该接口异步下发 Auto.JS 脚本，通过反射 Android 的 `PackageManager` 获取包含中文名称、包名、版本、是否系统应用等全面信息的 JSON 列表。任务成功后，`message` 字段将包含 JSON 字符串。
- **返回响应**:
  ```json
  {
    "success": true,
    "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "status": "EXECUTING",
    "message": "Apps details task dispatched"
  }
  ```

### 4. 查询任务状态

- **URL**: `GET /api/tasks/:taskId`
- **返回响应**:
  - 如果任务存在：
    ```json
    {
      "success": true,
      "task": {
        "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "cat": "shell",
        "script": "pm list packages -3",
        "status": "SUCCESS", // 可选值为: EXECUTING, SUCCESS, FAILURE, MISSING
        "timeout": 15,
        "createdAt": 1720601234567,
        "message": "package:com.tencent.mm\npackage:com.eg.android.Alipay"
      }
    }
    ```
  - 如果任务不存在（MISSING）：
    ```json
    {
      "success": true,
      "taskId": "invalid-id",
      "status": "MISSING",
      "message": "Task not found in system"
    }
    ```

### 5. 获取所有任务列表

- **URL**: `GET /api/tasks`

---

## 强杀与超时说明

1. **移动端本地强杀**:
   在收到任务时，移动端会在本地启动一个 `setTimeout`。如果代码执行时长超过 `timeout`，移动端会通过 Root Shell 执行以下强杀命令：
   - `su -c "am force-stop org.autojs.autojs6"` (强杀 Auto.js 应用)
   - `su -c "am force-stop com.android.chrome"` (强杀 Chrome 浏览器)
     并在完成后，主动向 PC 的 `/api/callback` 回报 `FAILURE`，状态附带原因为本地超时强杀。
2. **PC 端兜底标记失败**:
   若移动端在 `timeout + 10s` 时间内没有通过 HTTP 发送成功或失败的回调（可能由于设备断网、Termux 进程挂掉或脚本卡死导致本地超时器失效），PC 服务端内的轮询线程会自动扫描到并强制将任务状态标记为 `FAILURE`，并将错误信息置为 `Timeout Failure: No response received after timeout + 10s grace period`。
