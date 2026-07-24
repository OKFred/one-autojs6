import mqtt from "mqtt";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL;
if (!MQTT_BROKER_URL) {
  console.error(
    "[ERROR] Environment variable MQTT_BROKER_URL is required. Please check your config.",
  );
  process.exit(1);
}
const AUTOJS_PACKAGE_NAME = "org.autojs.autojs6";
const TEMP_SCRIPT_DIR = process.env.TEMP_SCRIPT_DIR || "/sdcard/Download";

interface TaskPayload {
  taskId: string;
  cat: string;
  script: string;
  timeout: number;
  useRoot?: boolean;
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
}

// 活跃任务缓存：记录定时器与临时文件路径
const activeTasks: Record<string, ActiveTask> = {};

console.log("[CLIENT] Starting Termux MQTT Daemon in TypeScript...");
console.log(`[CLIENT] Configured MQTT Broker: ${MQTT_BROKER_URL}`);
console.log(`[CLIENT] Configured Auto.js Package: ${AUTOJS_PACKAGE_NAME}`);
console.log(`[CLIENT] Temp Script Location: ${TEMP_SCRIPT_DIR}`);

// 连接 MQTT Broker (开启 24H 离线消息暂存)
const client = mqtt.connect(MQTT_BROKER_URL, {
  clean: false,
  clientId: "one_autojs6_mobile_device",
  properties: {
    sessionExpiryInterval: 86400, // 设置 EMQX 离线消息暂存 24 小时 (86400秒)
  },
});

client.on("connect", () => {
  console.log("[CLIENT] Connected to MQTT Broker successfully.");

  // 订阅下发任务主题
  client.subscribe("autojs6/tasks", (err: any) => {
    if (!err) {
      console.log("[CLIENT] Subscribed to topic: autojs6/tasks");
    } else {
      console.error("[CLIENT] Failed to subscribe autojs6/tasks:", err);
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

    if (topic === "autojs6/tasks") {
      const { taskId, cat, script, timeout, useRoot } = data as TaskPayload;

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
            sendMqttResult(
              taskId,
              "FAILURE",
              `Root copy failed: ${err.message}`,
            );
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
              } catch (e: any) {
                sendMqttResult(taskId, "FAILURE", "Failed to parse result file: " + e.message);
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
          };

          // 7. 通过 Root 命令启动 Auto.js 载入脚本
          const runCommand = `su -c "am start -n ${AUTOJS_PACKAGE_NAME}/org.autojs.autojs.ui.shortcut.ShortcutHandleActivity -d file://${targetTempPath} -t text/javascript"`;
          console.log(
            `[CLIENT] Executing shell command to start Auto.js: ${runCommand}`,
          );

          exec(runCommand, (err: any) => {
            if (err) {
              sendMqttResult(
                taskId,
                "FAILURE",
                `Failed to launch Auto.js intent: ${err.message}`,
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
        };

        const execCmd = useRoot ? `su -c "${script}"` : script;
        console.log(`[CLIENT] Running Shell command for task ${taskId}: ${execCmd}`);

        exec(execCmd, (err: any, stdout: string, stderr: string) => {
          if (err) {
            console.error(`[CLIENT] Shell execution failed:`, err.message);
            sendMqttResult(
              taskId,
              "FAILURE",
              stderr || err.message,
            );
          } else {
            console.log(
              `[CLIENT] Shell execution succeeded for task ${taskId}`,
            );
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
        console.log(
          `[CLIENT] Ignored task ${taskId} because unknown cat=${cat}`,
        );
      }
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

/**
 * 辅助方法：通过 MQTT 向 EMQX 云端 publish 任务回传结果。
 * 主题：autojs6/results
 */
function sendMqttResult(
  taskId: string,
  status: string,
  message: string,
) {
  const payload = JSON.stringify({
    taskId,
    status,
    message,
    timestamp: Date.now(),
  });
  client.publish("autojs6/results", payload, { qos: 1 }, (err) => {
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
}
