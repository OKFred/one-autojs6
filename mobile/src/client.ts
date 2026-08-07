import mqtt from "mqtt";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { getEmqxBrokerUrl } from "./utils/mqtt.js";
import { buildObserverScript } from "./scripts/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 日志系统初始化：将所有 console 输出同时写入日期日志文件
// ============================================================

/** 获取项目根目录（mobile 的上一级） */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const LOGS_DIR = path.join(PROJECT_ROOT, "logs");

/** 确保 logs 目录存在 */
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/** 获取本地时区的 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss.SSS 格式字符串 */
function formatLocalDate(date: Date, withTime = false): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  if (!withTime) return `${y}-${mo}-${d}`;
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = pad(date.getMilliseconds(), 3);
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms}`;
}

/** 获取当前日志文件路径（按本地时区日期划分） */
function getLogFilePath(): string {
  return path.join(LOGS_DIR, `${formatLocalDate(new Date())}.log`);
}

/** 格式化日志前缀时间戳（本地时区） */
function getTimestamp(): string {
  return formatLocalDate(new Date(), true);
}

/** 追加写入日志文件 */
function writeToLog(level: string, args: unknown[]): void {
  const line = `[${getTimestamp()}] [${level}] ${args.map(String).join(" ")}\n`;
  try {
    fs.appendFileSync(getLogFilePath(), line, "utf8");
  } catch {
    // 静默处理，避免死循环
  }
}

/** 重写 console 方法，同时写入文件和原始输出 */
const _log = console.log.bind(console);
const _error = console.error.bind(console);
const _warn = console.warn.bind(console);

console.log = (...args: unknown[]) => {
  _log(...args);
  writeToLog("INFO", args);
};
console.error = (...args: unknown[]) => {
  _error(...args);
  writeToLog("ERROR", args);
};
console.warn = (...args: unknown[]) => {
  _warn(...args);
  writeToLog("WARN", args);
};

dotenv.config();

const MQTT_USERNAME = process.env.EMQX_USERNAME;
const MQTT_HOST = process.env.EMQX_HOST;

if (!MQTT_USERNAME || !MQTT_HOST) {
  console.error(
    "[ERROR] EMQX_USERNAME and EMQX_HOST are required in .env. Please check your config.",
  );
  process.exit(1);
}

const MQTT_BROKER_URL = getEmqxBrokerUrl();

const AUTOJS_PACKAGE_NAME = "org.autojs.autojs6";
const TEMP_SCRIPT_DIR = process.env.TEMP_SCRIPT_DIR || "/sdcard/Download";

interface TaskPayload {
  taskId: string;
  cat: string;
  script: string;
  timeout: number;
  useRoot?: boolean;
  observe?: string[];
  callbackUrl?: string;
}

interface StatusPayload {
  taskId: string;
  status: string;
}

interface ActiveTask {
  timeoutTimer?: NodeJS.Timeout;
  pollInterval?: NodeJS.Timeout;
  tempFilePath: string;
  resultFilePath?: string;
  callbackUrl?: string;
}

// 活跃任务缓存：记录定时器与临时文件路径
const activeTasks: Record<string, ActiveTask> = {};
const taskQueue: TaskPayload[] = [];
let activeConfig: string[] = [];
let shellPoller: NodeJS.Timeout | null = null;
let autojsWatcher: NodeJS.Timeout | null = null;
let lastBatteryLevel = -1;
let lastEventsSize = 0;
let isExecuting = false;

console.log("[CLIENT] Starting Termux MQTT Daemon in TypeScript...");
console.log(`[CLIENT] Configured MQTT Broker: ${MQTT_BROKER_URL}`);
console.log(`[CLIENT] Configured Auto.js Package: ${AUTOJS_PACKAGE_NAME}`);
console.log(`[CLIENT] Temp Script Location: ${TEMP_SCRIPT_DIR}`);

const clientId = MQTT_USERNAME;

// 连接 MQTT Broker (开启 24H 离线消息暂存)
const client = mqtt.connect(MQTT_BROKER_URL, {
  clean: false,
  clientId,
  properties: {
    sessionExpiryInterval: 86400, // 设置 EMQX 离线消息暂存 24 小时 (86400秒)
  },
});

client.on("connect", () => {
  console.log(
    `[CLIENT] Connected to MQTT Broker successfully with clientId: ${clientId}`,
  );

  // 订阅公共下发任务主题
  client.subscribe("autojs6/tasks", (err: any) => {
    if (!err) {
      console.log("[CLIENT] Subscribed to topic: autojs6/tasks");
    } else {
      console.error("[CLIENT] Failed to subscribe autojs6/tasks:", err);
    }
  });

  // 订阅设备专属下发任务主题
  const privateTopic = `autojs6/tasks/${clientId}`;
  client.subscribe(privateTopic, (err) => {
    if (!err) {
      console.log(`[CLIENT] Subscribed to private topic: ${privateTopic}`);
    } else {
      console.error(`[CLIENT] Failed to subscribe ${privateTopic}:`, err);
    }
  });

  // 订阅任务完成/清理主题
  client.subscribe("autojs6/status", (err: any) => {
    if (!err) {
      console.log("[CLIENT] Subscribed to topic: autojs6/status");
    } else {
      console.error("[CLIENT] Failed to subscribe autojs6/status:", err);
    }
  });
});

client.on("error", (err) => {
  console.error("[CLIENT] MQTT connection error:", err);
});

client.on("message", async (topic: string, payload: Buffer) => {
  const messageStr = payload.toString();

  try {
    const data = JSON.parse(messageStr);

    if (topic === "autojs6/tasks" || topic === `autojs6/tasks/${clientId}`) {
      const { taskId, cat, observe } = data as TaskPayload;

      if (cat === "config") {
        console.log(`[CLIENT] Received Observer Config:`, observe);
        activeConfig = observe || [];
        applyConfig();
        return;
      }

      if (cat === "kill") {
        console.log(
          `[CLIENT] Received Kill command! Emptying queue and stopping current script...`,
        );
        taskQueue.length = 0; // Empty the queue
        const killCmds = [
          `su -c "am force-stop ${AUTOJS_PACKAGE_NAME}"`,
          `su -c "am force-stop com.android.chrome"`,
        ];
        killCmds.forEach((cmd) => {
          exec(cmd, (err: any) => {
            if (err)
              console.error(
                `[CLIENT] Error running kill command "${cmd}":`,
                err.message,
              );
          });
        });

        const activeTaskIds = Object.keys(activeTasks);
        for (const id of activeTaskIds) {
          sendMqttResult(
            id,
            "FAILURE",
            "Task was forcefully terminated by user kill command.",
          );
          cleanupTask(id);
        }

        isExecuting = false;
        sendMqttResult(
          taskId,
          "SUCCESS",
          "Kill command executed successfully.",
        );
        if (activeConfig.includes("sms")) setTimeout(() => applyConfig(), 2000);
        return;
      }

      taskQueue.push(data as TaskPayload);
      console.log(
        `[CLIENT] Task ${taskId} (cat: ${cat}) added to queue. Queue length: ${taskQueue.length}`,
      );
      processNextTask();
    } else if (topic === "autojs6/status") {
      const { taskId } = data as StatusPayload;
      if (taskId && activeTasks[taskId]) {
        console.log(
          `[CLIENT] Clearing running task ${taskId} (notified by server status update)`,
        );
        cleanupTask(taskId);
      }
    }
  } catch (err) {
    console.error("[CLIENT] Error handling MQTT message:", err);
  }
});

function processNextTask() {
  if (isExecuting) return;
  if (taskQueue.length === 0) return;

  isExecuting = true;
  const taskData = taskQueue.shift();
  if (taskData) executeTask(taskData);
}

function applyConfig() {
  if (shellPoller) clearInterval(shellPoller);
  if (autojsWatcher) clearInterval(autojsWatcher);

  const hasObserverTask =
    activeConfig.includes("battery") ||
    activeConfig.includes("network") ||
    activeConfig.includes("sms");

  if (hasObserverTask) {
    console.log(
      `[CLIENT] Starting Auto.js Observer for configs: ${activeConfig.join(", ")}...`
    );
    const observerPath = path.join(TEMP_SCRIPT_DIR, "autojs_observer.js");
    const eventResPath = path.join(TEMP_SCRIPT_DIR, "autojs_events.txt");

    const observerScript = buildObserverScript(eventResPath, activeConfig);

    const localObserverPath = path.join(__dirname, "local_observer.js");
    fs.writeFileSync(localObserverPath, observerScript, "utf8");
    exec(
      `su -c "cp ${localObserverPath} ${observerPath} && chmod 777 ${observerPath} && rm -f ${localObserverPath} && am start -n ${AUTOJS_PACKAGE_NAME}/org.autojs.autojs.external.open.RunIntentActivity -d file://${observerPath} -t text/javascript"`,
      (err) => {
        if (err)
          console.error("[CLIENT] Failed to start autojs observer:", err);
      }
    );

    autojsWatcher = setInterval(() => {
      const eventsFile = path.join(TEMP_SCRIPT_DIR, "autojs_events.txt");
      if (fs.existsSync(eventsFile)) {
        try {
          const stats = fs.statSync(eventsFile);
          if (stats.size > lastEventsSize) {
            const fd = fs.openSync(eventsFile, "r");
            const buffer = Buffer.alloc(stats.size - lastEventsSize);
            fs.readSync(fd, buffer, 0, buffer.length, lastEventsSize);
            fs.closeSync(fd);
            lastEventsSize = stats.size;

            const lines = buffer.toString().split("\n").filter(Boolean);
            lines.forEach((line) => {
              console.log("[CLIENT] Detected new Auto.js Event:", line);
              try {
                const parsed = JSON.parse(line);
                const fullPayload = JSON.stringify({
                  clientId,
                  ...parsed,
                });
                client.publish(`autojs6/events/${clientId}`, fullPayload, {
                  qos: 1,
                });
                client.publish("autojs6/events", fullPayload, { qos: 1 });
              } catch {
                client.publish("autojs6/events", line, { qos: 1 });
              }
            });
          } else if (stats.size < lastEventsSize) {
            lastEventsSize = 0;
          }
        } catch (e) {
          console.error("[CLIENT] Error reading autojs_events.txt:", e);
        }
      }
    }, 2000);
  }
}

function executeTask(data: TaskPayload) {
  const { taskId, cat, script, timeout, useRoot, callbackUrl } = data;

  if (cat === "autojs6") {
    console.log(
      `[CLIENT] Received Auto.js task ${taskId}. Timeout: ${timeout}s`,
    );

    const resultPath = path.join(TEMP_SCRIPT_DIR, `autojs_res_${taskId}.json`);

    // 包装 Auto.js 脚本：执行结果自动写入本地 JSON 结果文件，全脱离局域网 HTTP
    const wrappedScript = `
var taskResult = "Script execution succeeded";
var taskId = "${taskId}";
var resPath = "${resultPath}";

try {
    console.log("Start executing remote script: " + taskId);
    device.wakeUp();
    ${script}
    console.log("Script executed successfully.");
    files.write(resPath, JSON.stringify({
        status: "SUCCESS",
        message: String(taskResult)
    }));
} catch (err) {
    console.error("Script execution failed: " + err);
    files.write(resPath, JSON.stringify({
        status: "FAILURE",
        message: String(err)
    }));
}
`;

    const tempFileName = `autojs_temp_${taskId}.js`;
    const localTempPath = path.join(__dirname, `local_${tempFileName}`);
    const targetTempPath = path.join(TEMP_SCRIPT_DIR, tempFileName);

    try {
      fs.writeFileSync(localTempPath, wrappedScript, "utf8");
      console.log(
        `[CLIENT] Local temporary script written to ${localTempPath}`,
      );
    } catch (err: any) {
      console.error(
        `[CLIENT] Failed to write local temporary script to ${localTempPath}:`,
        err,
      );
      sendMqttResult(
        taskId,
        "FAILURE",
        `Failed to write local script: ${err.message}`,
      );
      return;
    }

    // 使用 Root 搬运文件并赋权 777
    const prepareCommand = `su -c "cp ${localTempPath} ${targetTempPath} && chmod 777 ${targetTempPath} && rm -f ${localTempPath}"`;
    console.log(
      `[CLIENT] Copying script to target path using root: ${prepareCommand}`,
    );

    exec(prepareCommand, (err: any) => {
      if (err) {
        console.error(`[CLIENT] Root copy failed:`, err.message);
        sendMqttResult(taskId, "FAILURE", `Root copy failed: ${err.message}`);
        try {
          if (fs.existsSync(localTempPath)) fs.unlinkSync(localTempPath);
        } catch {}
        return;
      }

      console.log(
        `[CLIENT] Script successfully moved to ${targetTempPath} with 777 permissions`,
      );

      // 5. 设置本地超时强杀定时器
      const timeoutTimer = setTimeout(() => {
        console.warn(
          `[CLIENT] Task ${taskId} timeout (${timeout}s) reached! Initiating force-kill...`,
        );

        const killCmds = [
          `su -c "am force-stop ${AUTOJS_PACKAGE_NAME}"`,
          `su -c "am force-stop com.android.chrome"`,
        ];

        killCmds.forEach((cmd) => {
          exec(cmd, (err: any) => {
            if (err) {
              console.error(
                `[CLIENT] Error running force-stop command "${cmd}":`,
                err.message,
              );
            } else {
              console.log(`[CLIENT] Command executed successfully: ${cmd}`);
            }
          });
        });

        // 向 MQTT 回传超时状态
        sendMqttResult(
          taskId,
          "FAILURE",
          `Timeout: Script execution exceeded ${timeout}s. Termux client killed the application.`,
        );

        cleanupTask(taskId);
      }, timeout * 1000);

      // 6. 轮询侦听结果文件的生成，全 MQTT 回传
      const pollInterval = setInterval(() => {
        if (fs.existsSync(resultPath)) {
          try {
            const content = fs.readFileSync(resultPath, "utf8");
            const res = JSON.parse(content);
            sendMqttResult(taskId, res.status, res.message);
          } catch (e) {
            sendMqttResult(
              taskId,
              "FAILURE",
              "Failed to parse result file: " + (e as Error).message,
            );
          }
          cleanupTask(taskId);
        }
      }, 500);

      // 缓存任务信息
      activeTasks[taskId] = {
        timeoutTimer,
        pollInterval,
        tempFilePath: targetTempPath,
        resultFilePath: resultPath,
        callbackUrl,
      };

      // 7. 通过 Root 命令启动 Auto.js 载入脚本
      const runCommand = `su -c "am start -n ${AUTOJS_PACKAGE_NAME}/org.autojs.autojs.external.open.RunIntentActivity -d file://${targetTempPath} -t text/javascript"`;
      console.log(
        `[CLIENT] Executing shell command to start Auto.js: ${runCommand}`,
      );

      exec(runCommand, (err) => {
        if (err) {
          sendMqttResult(
            taskId,
            "FAILURE",
            `Failed to launch Auto.js intent: ${(err as Error).message}`,
          );
          cleanupTask(taskId);
        } else {
          console.log(`[CLIENT] Task ${taskId} is now running in Auto.js`);
        }
      });
    });
  } else if (cat === "shell") {
    console.log(
      `[CLIENT] Received Shell task ${taskId}. Timeout: ${timeout}s, useRoot: ${!!useRoot}`,
    );

    const timeoutTimer = setTimeout(() => {
      console.warn(
        `[CLIENT] Shell Task ${taskId} timeout reached! Killing process...`,
      );
      sendMqttResult(
        taskId,
        "FAILURE",
        `Timeout: Shell execution exceeded ${timeout}s.`,
      );
      cleanupTask(taskId);
    }, timeout * 1000);

    activeTasks[taskId] = {
      timeoutTimer,
      tempFilePath: "",
      callbackUrl,
    };

    const execCmd = useRoot ? `su -c "${script}"` : script;
    console.log(
      `[CLIENT] Running Shell command for task ${taskId}: ${execCmd}`,
    );

    exec(execCmd, (err: any, stdout: string, stderr: string) => {
      if (err) {
        console.error(`[CLIENT] Shell execution failed:`, err.message);
        sendMqttResult(taskId, "FAILURE", stderr || err.message);
      } else {
        console.log(`[CLIENT] Shell execution succeeded for task ${taskId}`);
        sendMqttResult(taskId, "SUCCESS", stdout);
      }
      cleanupTask(taskId);
    });
  } else if (cat === "update") {
    console.log(
      `[CLIENT] Received Self-Update task ${taskId}. Timeout: ${timeout}s`,
    );

    const timeoutTimer = setTimeout(() => {
      sendMqttResult(
        taskId,
        "FAILURE",
        `Timeout: Self-Update execution exceeded ${timeout}s.`,
      );
      cleanupTask(taskId);
    }, timeout * 1000);

    activeTasks[taskId] = {
      timeoutTimer,
      tempFilePath: "",
      callbackUrl,
    };

    sendMqttResult(
      taskId,
      "SUCCESS",
      "Update signal triggered. Client is exiting with status code 99.",
    );

    setTimeout(() => {
      cleanupTask(taskId);
      console.log("[CLIENT] Exiting with code 99 for self-update...");
      process.exit(99);
    }, 1500);
  } else {
    console.log(`[CLIENT] Ignored task ${taskId} because unknown cat=${cat}`);
  }
}

/**
 * 辅助方法：通过 MQTT 向 EMQX 云端 publish 任务回传结果。
 * 主题：autojs6/results
 */
function sendMqttResult(taskId: string, status: string, message: string) {
  const payloadStr = JSON.stringify({
    taskId,
    status,
    message,
    timestamp: Date.now(),
  });

  const task = activeTasks[taskId];
  if (task && task.callbackUrl) {
    console.log(
      `[CLIENT] Sending HTTP Callback to ${task.callbackUrl} for task ${taskId}`,
    );
    fetch(task.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payloadStr,
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        console.log(
          `[CLIENT] HTTP Callback succeeded for task ${taskId}: ${status}`,
        );
      })
      .catch((err) => {
        console.error(
          `[CLIENT] HTTP Callback failed for task ${taskId}:`,
          err.message,
          "- Falling back to MQTT",
        );
        publishToMqtt();
      });
  } else {
    publishToMqtt();
  }

  function publishToMqtt() {
    client.publish("autojs6/results", payloadStr, { qos: 1 }, (err) => {
      if (err) {
        console.error(
          `[CLIENT] Failed to send MQTT result for task ${taskId}:`,
          err.message,
        );
      } else {
        console.log(
          `[CLIENT] Feedback successfully published to MQTT autojs6/results for task ${taskId}: ${status}`,
        );
      }
    });
  }
}

/**
 * 辅助方法：清理指定任务的定时器和临时文件。
 *
 * @param taskId - 需要清理的任务 ID
 */
function cleanupTask(taskId: string) {
  const task = activeTasks[taskId];
  if (!task) return;

  if (task.timeoutTimer) {
    clearTimeout(task.timeoutTimer);
  }

  if (task.pollInterval) {
    clearInterval(task.pollInterval);
  }

  if (task.tempFilePath) {
    try {
      if (fs.existsSync(task.tempFilePath)) {
        fs.unlinkSync(task.tempFilePath);
        console.log(`[CLIENT] Temp script deleted: ${task.tempFilePath}`);
      }
    } catch (err: any) {
      exec(`su -c "rm -f ${task.tempFilePath}"`);
    }
  }

  if (task.resultFilePath) {
    try {
      if (fs.existsSync(task.resultFilePath)) {
        fs.unlinkSync(task.resultFilePath);
      }
    } catch (err: any) {
      exec(`su -c "rm -f ${task.resultFilePath}"`);
    }
  }

  delete activeTasks[taskId];

  isExecuting = false;
  setTimeout(processNextTask, 100);
}
