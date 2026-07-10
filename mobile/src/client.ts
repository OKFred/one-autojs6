import mqtt from 'mqtt';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';
const AUTOJS_PACKAGE_NAME = process.env.AUTOJS_PACKAGE_NAME || 'org.autojs.autojs6';
const TEMP_SCRIPT_DIR = process.env.TEMP_SCRIPT_DIR || '/sdcard/Download';

interface TaskPayload {
  taskId: string;
  cat: string;
  script: string;
  timeout: number;
  callbackUrl: string;
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
      const { taskId, cat, script, timeout, callbackUrl } = data as TaskPayload;

      // 1. 过滤分类
      if (cat !== 'autojs6') {
        console.log(`[CLIENT] Ignored task ${taskId} because cat=${cat} (expected 'autojs6')`);
        return;
      }

      console.log(`[CLIENT] Received task ${taskId}. Timeout: ${timeout}s`);

      // 2. 包装 Auto.js 脚本以注入异常处理和 HTTP 回调
      // Auto.js 的 http.post 是同步阻塞的。
      const wrappedScript = `
try {
    console.log("Start executing remote script: ${taskId}");
    
    // 执行用户脚本逻辑
    ${script}
    
    console.log("Script executed successfully. Sending success callback.");
    var res = http.post("${callbackUrl}", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            taskId: "${taskId}",
            status: "SUCCESS",
            message: "Script execution succeeded"
        })
    });
    console.log("Callback sent: " + res.body.string());
} catch (err) {
    console.error("Script execution failed: " + err);
    var res = http.post("${callbackUrl}", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            taskId: "${taskId}",
            status: "FAILURE",
            message: err.toString()
        })
    });
    console.log("Callback sent: " + res.body.string());
}
`;

      // 3. 将脚本先写入 Termux 本地私有目录下的临时文件（防 EPERM 权限报错）
      const tempFileName = `autojs_temp_${taskId}.js`;
      const localTempPath = path.join(process.cwd(), `local_${tempFileName}`);
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
 * 辅助方法：通过 Fetch API 向 PC 服务端发送 HTTP 回调
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
 * 辅助方法：清理指定任务的定时器 and 临时文件
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
