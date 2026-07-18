import mqtt from 'mqtt';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRootDir = path.resolve(__dirname, '../../');

dotenv.config();

const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL;
if (!MQTT_BROKER_URL) {
  console.error('[ERROR] Environment variable MQTT_BROKER_URL is required. Please check your config.');
  process.exit(1);
}
const AUTOJS_PACKAGE_NAME = process.env.AUTOJS_PACKAGE_NAME || 'org.autojs.autojs6';
const TEMP_SCRIPT_DIR = process.env.TEMP_SCRIPT_DIR || '/sdcard/Download';

interface TaskPayload {
  taskId: string;
  cat: string;
  script: string;
  timeout: number;
  callbackUrl: string;
  useRoot?: boolean;
}

interface StatusPayload {
  taskId: string;
  status: string;
}

interface ActiveTask {
  timeoutTimer: NodeJS.Timeout;
  tempFilePath: string;
}

// 活跃任务缓存：记录定时器与临时文件路径
const activeTasks: Record<string, ActiveTask> = {};

console.log('[CLIENT] Starting Termux MQTT Daemon in TypeScript...');
console.log(`[CLIENT] Configured MQTT Broker: ${MQTT_BROKER_URL}`);
console.log(`[CLIENT] Configured Auto.js Package: ${AUTOJS_PACKAGE_NAME}`);
console.log(`[CLIENT] Temp Script Location: ${TEMP_SCRIPT_DIR}`);

// 连接 MQTT Broker
const client = mqtt.connect(MQTT_BROKER_URL);

client.on('connect', () => {
  console.log('[CLIENT] Connected to MQTT Broker successfully.');
  
  // 订阅下发任务主题
  client.subscribe('autojs6/tasks', (err: any) => {
    if (!err) {
      console.log('[CLIENT] Subscribed to topic: autojs6/tasks');
    } else {
      console.error('[CLIENT] Failed to subscribe autojs6/tasks:', err);
    }
  });

  // 订阅任务完成/清理主题
  client.subscribe('autojs6/status', (err: any) => {
    if (!err) {
      console.log('[CLIENT] Subscribed to topic: autojs6/status');
    } else {
      console.error('[CLIENT] Failed to subscribe autojs6/status:', err);
    }
  });
});

client.on('error', (err) => {
  console.error('[CLIENT] MQTT connection error:', err);
});

client.on('message', async (topic: string, payload: Buffer) => {
  const messageStr = payload.toString();
  
  try {
    const data = JSON.parse(messageStr);

    if (topic === 'autojs6/tasks') {
      const { taskId, cat, script, timeout, callbackUrl, useRoot } = data as TaskPayload;

      if (cat === 'autojs6') {
        console.log(`[CLIENT] Received Auto.js task ${taskId}. Timeout: ${timeout}s`);

        // 2. 包装 Auto.js 脚本以注入异常处理和 HTTP 回调
        // Auto.js 的 http.post 是同步阻塞的。
        const wrappedScript = `
var taskResult = "Script execution succeeded";
var callbackUrl = "${callbackUrl}";
var taskId = "${taskId}";

try {
    console.log("Start executing remote script: " + taskId);
    
    // 自动点亮屏幕，避免黑屏预览
    device.wakeUp();
    
    // 执行用户脚本逻辑
    ${script}
    
    console.log("Script executed successfully. Sending success callback.");
    var res = http.postJson("${callbackUrl}", {
        taskId: "${taskId}",
        status: "SUCCESS",
        message: String(taskResult)
    });
    console.log("Callback sent: " + res.body.string());
} catch (err) {
    console.error("Script execution failed: " + err);
    var res = http.postJson("${callbackUrl}", {
        taskId: "${taskId}",
        status: "FAILURE",
        message: err.toString()
    });
    console.log("Callback sent: " + res.body.string());
}
`;

        // 3. 将脚本先写入 Termux 本地私有目录下的临时文件（防 EPERM 权限报错）
        const tempFileName = `autojs_temp_${taskId}.js`;
        const localTempPath = path.join(__dirname, `local_${tempFileName}`);
        const targetTempPath = path.join(TEMP_SCRIPT_DIR, tempFileName);
        
        try {
          fs.writeFileSync(localTempPath, wrappedScript, 'utf8');
          console.log(`[CLIENT] Local temporary script written to ${localTempPath}`);
        } catch (err: any) {
          console.error(`[CLIENT] Failed to write local temporary script to ${localTempPath}:`, err);
          sendHttpCallback(callbackUrl, taskId, 'FAILURE', `Failed to write local script: ${err.message}`);
          return;
        }

        // 4. 使用 Root 权限将文件搬运至目标路径，并赋予 777 权限以确保 Auto.js 能够跨沙盒读取
        const prepareCommand = `su -c "cp ${localTempPath} ${targetTempPath} && chmod 777 ${targetTempPath} && rm -f ${localTempPath}"`;
        console.log(`[CLIENT] Copying script to target path using root: ${prepareCommand}`);

        exec(prepareCommand, (err: any) => {
          if (err) {
            console.error(`[CLIENT] Root copy failed:`, err.message);
            sendHttpCallback(callbackUrl, taskId, 'FAILURE', `Root copy failed: ${err.message}`);
            try {
              if (fs.existsSync(localTempPath)) fs.unlinkSync(localTempPath);
            } catch {}
            return;
          }

          console.log(`[CLIENT] Script successfully moved to ${targetTempPath} with 777 permissions`);

          // 5. 设置本地超时强杀定时器
          const timeoutTimer = setTimeout(() => {
            console.warn(`[CLIENT] Task ${taskId} timeout (${timeout}s) reached! Initiating force-kill...`);
            
            // 强杀 Auto.js 和 Chrome 浏览器
            const killCmds = [
              `su -c "am force-stop ${AUTOJS_PACKAGE_NAME}"`,
              `su -c "am force-stop com.android.chrome"`
            ];

            killCmds.forEach((cmd) => {
              exec(cmd, (err: any) => {
                if (err) {
                  console.error(`[CLIENT] Error running force-stop command "${cmd}":`, err.message);
                } else {
                  console.log(`[CLIENT] Command executed successfully: ${cmd}`);
                }
              });
            });

            // 强杀后，主动向 PC 报告超时失败
            sendHttpCallback(
              callbackUrl, 
              taskId, 
              'FAILURE', 
              `Timeout: Script execution exceeded ${timeout}s. Termux client killed the application.`
            );

            // 清理本地资源
            cleanupTask(taskId);
          }, timeout * 1000);

          // 缓存任务信息
          activeTasks[taskId] = {
            timeoutTimer,
            tempFilePath: targetTempPath
          };

          // 6. 通过 Root 命令启动 Auto.js 载入脚本
          const runCommand = `su -c "am start -n ${AUTOJS_PACKAGE_NAME}/org.autojs.autojs.external.open.RunIntentActivity -d file://${targetTempPath} -t text/javascript"`;
          console.log(`[CLIENT] Executing shell command to start Auto.js: ${runCommand}`);

          exec(runCommand, (err: any) => {
            if (err) {
              console.error(`[CLIENT] Failed to launch Auto.js:`, err.message);
              sendHttpCallback(callbackUrl, taskId, 'FAILURE', `Failed to launch Auto.js intent: ${err.message}`);
              cleanupTask(taskId);
            } else {
              console.log(`[CLIENT] Task ${taskId} is now running in Auto.js`);
            }
          });
        });

      } else if (cat === 'shell') {
        console.log(`[CLIENT] Received Shell task ${taskId}. Timeout: ${timeout}s, useRoot: ${!!useRoot}`);

        // 1. 设置本地超时定时器
        const timeoutTimer = setTimeout(() => {
          console.warn(`[CLIENT] Shell Task ${taskId} timeout reached! Killing process...`);
          sendHttpCallback(
            callbackUrl,
            taskId,
            'FAILURE',
            `Timeout: Shell execution exceeded ${timeout}s.`
          );
          cleanupTask(taskId);
        }, timeout * 1000);

        // 2. 缓存任务信息
        activeTasks[taskId] = {
          timeoutTimer,
          tempFilePath: ''
        };

        // 3. 执行 Shell 命令
        const execCmd = useRoot ? `su -c "${script}"` : script;
        console.log(`[CLIENT] Executing shell command: ${execCmd}`);
        exec(execCmd, (err: any, stdout: string, stderr: string) => {
          if (!activeTasks[taskId]) return;

          cleanupTask(taskId);

          if (err) {
            console.error(`[CLIENT] Shell execution failed:`, err.message);
            sendHttpCallback(callbackUrl, taskId, 'FAILURE', stderr || err.message);
          } else {
            console.log(`[CLIENT] Shell execution succeeded for task ${taskId}`);
            sendHttpCallback(callbackUrl, taskId, 'SUCCESS', stdout);
          }
        });
      } else if (cat === 'update') {
        console.log(`[CLIENT] Received Self-Update task ${taskId}. Timeout: ${timeout}s`);

        // 1. 设置本地超时定时器
        const timeoutTimer = setTimeout(() => {
          console.warn(`[CLIENT] Self-Update Task ${taskId} timeout reached!`);
          sendHttpCallback(
            callbackUrl,
            taskId,
            'FAILURE',
            `Timeout: Self-Update execution exceeded ${timeout}s.`
          );
          cleanupTask(taskId);
        }, timeout * 1000);

        // 2. 缓存任务信息
        activeTasks[taskId] = {
          timeoutTimer,
          tempFilePath: ''
        };

        // 3. 发送更新回调，随后延时退出以状态码 99 交给外层 Shell 守护脚本更新
        console.log(`[CLIENT] Dispatching success callback prior to exit...`);
        sendHttpCallback(callbackUrl, taskId, 'SUCCESS', 'Update signal triggered. Client is exiting with status code 99.');

        setTimeout(() => {
          cleanupTask(taskId);
          console.log('[CLIENT] Exiting with code 99 for self-update...');
          process.exit(99);
        }, 1500);
      } else {
        console.log(`[CLIENT] Ignored task ${taskId} because unknown cat=${cat}`);
      }


    } else if (topic === 'autojs6/status') {
      // 收到任务状态更新消息
      const { taskId } = data as StatusPayload;
      if (taskId && activeTasks[taskId]) {
        console.log(`[CLIENT] Clearing running task ${taskId} (notified by server status update)`);
        cleanupTask(taskId);
      }
    }
  } catch (err) {
    console.error('[CLIENT] Error handling MQTT message:', err);
  }
});

/**
 * 辅助方法：通过 Fetch API 向 PC 服务端发送 HTTP 回调。
 * 
 * @param callbackUrl - 回调的 HTTP URL 地址
 * @param taskId - 任务 ID
 * @param status - 执行状态，如 SUCCESS 或 FAILURE
 * @param message - 回调的消息负载（成功时为返回值，失败时为错误原因）
 */
function sendHttpCallback(callbackUrl: string, taskId: string, status: string, message: string) {
  fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, status, message })
  })
    .then((res) => {
      if (res.ok) {
        console.log(`[CLIENT] Feedback successfully sent for task ${taskId}: ${status}`);
      } else {
        console.error(`[CLIENT] Server rejected callback with code: ${res.status}`);
      }
    })
    .catch((err: any) => {
      console.error(`[CLIENT] Error sending HTTP callback for task ${taskId}:`, err.message);
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

  // 清除定时器
  if (task.timeoutTimer) {
    clearTimeout(task.timeoutTimer);
  }

  // 删除本地临时脚本
  if (task.tempFilePath) {
    try {
      if (fs.existsSync(task.tempFilePath)) {
        fs.unlinkSync(task.tempFilePath);
        console.log(`[CLIENT] Temp script deleted: ${task.tempFilePath}`);
        delete activeTasks[taskId];
        return;
      }
    } catch (err: any) {
      console.warn(`[CLIENT] Normal unlink failed (might be permissions): ${err.message}. Retrying with root...`);
    }

    // 普通删除失败（或被抛出权限异常），使用 su -c 强制删除
    const cleanCmd = `su -c "rm -f ${task.tempFilePath}"`;
    exec(cleanCmd, (err: any) => {
      if (err) {
        console.error(`[CLIENT] Failed to delete temp script using root: ${err.message}`);
      } else {
        console.log(`[CLIENT] Temp script deleted using root: ${task.tempFilePath}`);
      }
    });
  }

  delete activeTasks[taskId];
}
