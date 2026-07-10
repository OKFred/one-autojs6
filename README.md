[中文说明 (README_zh_CN.md)](README_zh_CN.md)

# Task Scheduling and Control System based on MQTT + HonoJS + Auto.js v6

This project implements a lightweight system for automatic script dispatching, execution, timeout control, and result callback for mobile devices (Termux), built on **MQTT message broker** and **HonoJS Web Service**.

---

## Architecture Overview

- **PC Server (pc/)**:
  - Runs HTTP service based on **HonoJS**.
  - Built-in **Aedes MQTT Broker** as the message transmission hub.
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
Create a `.env` file under the `pc/` directory:
```env
PORT=3000
MQTT_PORT=1883
PC_IP=192.168.12.240   # Replace with your PC's local IP address
```

#### Mobile Client Configuration: `mobile/.env`
Create a `.env` file under the `mobile/` directory:
```env
MQTT_BROKER_URL=mqtt://192.168.12.240:1883  # Replace with PC IP and MQTT Port
AUTOJS_PACKAGE_NAME=org.autojs.autojs6       # Package name of Auto.js v6
TEMP_SCRIPT_DIR=/sdcard/Download             # Shared directory for temp scripts
```

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
Copy the `mobile/` folder into your phone's Termux workspace and run:
```bash
pnpm start
```
Upon startup, the console will display:
```text
[CLIENT] Connected to MQTT Broker successfully.
[CLIENT] Subscribed to topic: autojs6/tasks
[CLIENT] Subscribed to topic: autojs6/status
```

---

## API Documentation

PC Server provides the following HTTP endpoints:

### 1. Create a Task
- **URL**: `POST /api/tasks`
- **Content-Type**: `application/json`
- **Request Body**:
  - `script` (string, required): The JavaScript script to execute in Auto.js.
  - `timeout` (number, optional, default: 30): Timeout duration in seconds, after which mobile client kills the task.
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
    "success": true,
    "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "status": "EXECUTING"
  }
  ```

### 2. Query Task Status
- **URL**: `GET /api/tasks/:taskId`
- **Response**:
  - If task exists:
    ```json
    {
      "success": true,
      "task": {
        "taskId": "a9a3b68f-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "script": "...",
        "status": "SUCCESS", // Options: EXECUTING, SUCCESS, FAILURE, MISSING
        "timeout": 60,
        "createdAt": 1720601234567,
        "message": "Script execution succeeded"
      }
    }
    ```
  - If task is missing:
    ```json
    {
      "success": true,
      "taskId": "invalid-id",
      "status": "MISSING",
      "message": "Task not found in system"
    }
    ```

### 3. Get All Tasks
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
