[中文说明 (README_zh_CN.md)](README_zh_CN.md)

# Task Scheduling and Control System based on MQTT + HonoJS + Auto.js v6

This project implements a lightweight system for automatic script dispatching, execution, timeout control, and result callback for mobile devices (Termux), built on **MQTT message broker** and **HonoJS Web Service**.

---

## Architecture Overview

- **PC Server (pc/)**:
  - Runs HTTP service based on **HonoJS**.
  - Built-in **Aedes MQTT Broker** as the message transmission hub.
  - Provides a static Web Dashboard (implemented via Vue 3 + MQTT WebSocket + ws-scrcpy) for real-time log tracking and device screen monitoring.
  - Provides task creation and callback API, maintaining the active state of tasks in memory.
  - Active timeout polling: Automatically marks tasks as `FAILURE` (`TIMEOUT_MISSING`) if they exceed `timeout + 10s` without callback.
- **Mobile Client (mobile/)**:
  - Runs as a Node.js TypeScript daemon inside **Termux**.
  - Subscribes to MQTT task queue, injects try-catch and HTTP callback logic into dispatched scripts, and writes to temporary files.
  - Uses Root privilege Android `am` command to launch **Auto.js v6** to run the script.
  - Supports dual force-stop and cleanup mechanisms: Kills Auto.js and Chrome upon timeout; automatically cleans up temporary files and timers on success.
- **Demo Script (demo_chrome.js)**:
  - An example script that opens Chrome browser and navigates to `baidu.com`.

---

## Prerequisites

### 1. PC Server

- **Node.js** (v20+ recommended) and **pnpm** (v10+ recommended).
- Device connected to PC via USB ADB.

### 2. Mobile Device (Android Phone)

- **Auto.js v6** with **Accessibility Service** and **Root Privileges** enabled.
- **Termux** installed, along with `nodejs` and `pnpm`:
  ```bash
  pkg install nodejs
  npm install -g pnpm
  ```
- Mobile device and PC server must be in the same local network (able to ping each other).

---

## Quick Start

### 1. Install Dependencies

Run the following command at the repository root to automatically install all dependencies for both PC and mobile projects:

```bash
pnpm install
```

### 2. Environment Configurations

#### PC Server Configuration: `pc/.env`

Create a `.env` file under the `pc/`, see [.env.example](.env.example)

#### Mobile Client Configuration: `mobile/.env`

Create a `.env` file under the `mobile/`, see [.env.example](.env.example)

### 3. Run Services

#### Start PC Server

Run the following command at the root:

```bash
pnpm --filter one-autojs6-pc dev
```

Upon startup, the console will print:

```text
[MQTT] Broker is running on port 1883
[HTTP] Server is running on http://localhost:3000
```

#### Start Mobile Client (Termux)

Copy the `mobile/` folder into your phone's Termux workspace.

To support **remote self-update and self-restart** of the mobile client, directly start it with our provided daemon shell script under `mobile/`:

```bash
bash node_daemon.sh
```

This script automatically pulls and starts the Node client. When you dispatch a self-update task via PC Server, the daemon script captures the exit code `99` from Node.js, automatically switches to the root project directory to execute `git pull`, and smoothly restarts the client. It also handles automatic delayed restarts in case the process crashes unexpectedly.

Upon startup, the console will display:

```text
[CLIENT] Connected to MQTT Broker successfully.
[CLIENT] Subscribed to topic: autojs6/tasks
[CLIENT] Subscribed to topic: autojs6/status
```

### 4. Web Dashboard

The project includes an intuitive Web Dashboard for real-time MQTT message monitoring and mobile screen mirroring (powered by ws-scrcpy).

1. Download and install `ws-scrcpy` screen mirroring dependencies:
   ```bash
   pnpm run scrcpy:install
   ```
2. Start all services (Backend + Mirroring):
   ```bash
   pnpm run dev:all
   ```
3. Access the dashboard: Open your browser and navigate to [http://localhost:3000/dashboard/](http://localhost:3000/dashboard/).


---

## API Documentation

PC Server provides the following HTTP endpoints:

### 1. Create a General Task

- **URL**: `POST /api/tasks`
- **Content-Type**: `application/json`
- **Request Body**:
  - `cat` (string, optional, default: `autojs6`): Task category. Can be set to `autojs6` (runs in Auto.JS6 UI) or `shell` (runs directly in Termux shell).
  - `script` (string, required): The script content or Shell commands to execute.
  - `timeout` (number, optional, default: 30): Timeout duration in seconds, after which mobile client kills the task.
  - `useRoot` (boolean, optional, default: false): Only effective when `cat === 'shell'`. Whether to run the command with Root privilege (`su -c`).
- **Testing Scripts**:
  You can run `test/scripts/test_browser.js` to dispatch a task that opens Chrome, searches on Baidu, scrapes DOM text contents, and returns the result:

  ```bash
  # Run directly
  node test/scripts/test_browser.js

  # Run with pc/.env config (Node 20.6+)
  node --env-file=pc/.env test/scripts/test_browser.js
  ```

  Or run `test/scripts/test_sms.js` to fetch all SMS records from the mobile database and print them as a neat console table:

  ```bash
  # Run directly
  node test/scripts/test_sms.js

  # Run with configuration
  node --env-file=pc/.env test/scripts/test_sms.js
  ```

- **Response**:
  ```json
  {
    "ok": true,
    "message": "Task dispatched successfully",
    "data": {
      "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "status": "EXECUTING"
    }
  }
  ```

### 2. Dispatch Task to Fetch App Package List

- **URL**: `POST /api/apps/task`
- **Content-Type**: `application/json`
- **Query Parameters**:
  - `type` (string, optional, default: `all`): Filter app type. Options: `all` (all packages), `third` (third-party apps only), `system` (system apps only).
  - `timeout` (number, optional, default: 15): Timeout duration in seconds.
- **Description**: Asynchronously dispatches the shell command `pm list packages` to retrieve application packages, which runs extremely fast. Upon success, the package list (separated by newlines) will be stored in the task's `message` field.
- **Response**:
  ```json
  {
    "ok": true,
    "message": "Apps package task dispatched successfully",
    "data": {
      "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "status": "EXECUTING"
    }
  }
  ```

### 3. Dispatch Task to Fetch App Details List

- **URL**: `POST /api/apps/details-task`
- **Content-Type**: `application/json`
- **Query Parameters**:
  - `timeout` (number, optional, default: 30): Timeout duration in seconds.
- **Description**: Asynchronously dispatches an Auto.js script that queries the Android `PackageManager` via reflection to fetch detailed information (including localized label name, package name, version, and system flag) as a JSON string. Upon success, the JSON data will be stored in the task's `message` field.
- **Response**:
  ```json
  {
    "ok": true,
    "message": "Apps details task dispatched successfully",
    "data": {
      "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "status": "EXECUTING"
    }
  }
  ```

### 4. Dispatch Task to Update Mobile Client

- **URL**: `POST /api/devices/update-task`
- **Content-Type**: `application/json`
- **Query Parameters**:
  - `timeout` (number, optional, default: 30): Timeout duration in seconds.
- **Description**: Asynchronously dispatches the self-update task (`cat = update`). The mobile Node client sends a SUCCESS callback and exits with status code `99` after 1.5s. The outer daemon script (`node_daemon.sh`) intercepts the exit code, pulls repository updates under the root folder for safety, and automatically restarts the client.
- **Response**:
  ```json
  {
    "ok": true,
    "message": "Mobile self-update task dispatched successfully",
    "data": {
      "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "status": "EXECUTING"
    }
  }
  ```

### 5. Dispatch Task to Check App Update Status

- **URL**: `POST /api/apps/check-update-task`
- **Content-Type**: `application/json`
- **Query Parameters**:
  - `packageName` (string, optional, default: `org.autojs.autojs6`): App package name to inspect.
  - `latestVersion` (string, optional): Latest version name (e.g., `6.4.0`).
  - `latestVersionCode` (integer, optional): Latest version code (e.g., `60400`).
  - `timeout` (number, optional, default: 15): Timeout in seconds.
- **Description**: Asynchronously dispatches an Auto.js script that queries the Android PackageInfo via reflection and compares local version details with the specified latest version. Upon success, the comparison results (in JSON string format) will be sent back and stored in the task's `message` field.
- **Response**:
  ```json
  {
    "ok": true,
    "message": "App check update task dispatched successfully",
    "data": {
      "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "status": "EXECUTING"
    }
  }
  ```

### 6. Dispatch Task to Execute App Remote Update

- **URL**: `POST /api/apps/execute-update-task`
- **Content-Type**: `application/json`
- **Query Parameters**:
  - `packageName` (string, optional, default: `org.autojs.autojs6`): Package name to update.
  - `mode` (string, required, `download` or `store`): Update strategy. `download` will download APK and trigger package installation; `store` will launch app store page and automatically click update button.
  - `downloadUrl` (string, required when `mode=download`): APK download address.
  - `storePackage` (string, optional): Specific app store package name (e.g. `com.android.vending`).
  - `timeout` (number, optional, default: 120): Timeout in seconds.
- **Description**: Asynchronously dispatches the update automated execution script. In download mode, to ensure connection robustness, the success callback is sent back **immediately after downloading is complete**, right before invoking the system package installer.
- **Response**:
  ```json
  {
    "ok": true,
    "message": "App execute update task dispatched successfully",
    "data": {
      "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "status": "EXECUTING"
    }
  }
  ```

### 7. Query Task Status

- **URL**: `GET /api/tasks/:taskId`
- **Response**:
  - If task exists:
    ```json
    {
      "ok": true,
      "message": "Retrieve task status successfully",
      "data": {
        "task": {
          "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
          "cat": "shell",
          "script": "pm list packages -3",
          "status": "SUCCESS", // Options: EXECUTING, SUCCESS, FAILURE, MISSING
          "timeout": 15,
          "createdAt": 1720601234567,
          "message": "package:com.tencent.mm\npackage:com.eg.android.Alipay"
        }
      }
    }
    ```
  - If task is missing:
    ```json
    {
      "ok": true,
      "message": "Task not found in system",
      "data": {
        "taskId": "invalid-id",
        "status": "MISSING"
      }
    }
    ```

### 8. Get All Tasks

- **URL**: `GET /api/tasks`

---

## Timeout & Force-Kill Details

1. **Mobile Force-Kill**:
   Upon receiving a task, the mobile client starts a `setTimeout` timer. If the execution exceeds `timeout` seconds, the client executes Root Shell commands to force-stop the apps:
   - `su -c "am force-stop org.autojs.autojs6"` (Kill Auto.js)
   - `su -c "am force-stop com.android.chrome"` (Kill Chrome)
     It then posts a `FAILURE` callback to PC server.
2. **PC Polling Fallback**:
   If the mobile device goes offline or fails to callback within `timeout + 10s`, the PC server's background thread will scan the task and automatically mark it as `FAILURE` with reason: `Timeout Failure: No response received after timeout + 10s grace period`.
