import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import Aedes from 'aedes';
import net from 'net';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const PC_IP = process.env.PC_IP || '127.0.0.1';

// 任务类型定义
interface Task {
  taskId: string;
  script: string;
  status: 'EXECUTING' | 'SUCCESS' | 'FAILURE' | 'MISSING';
  timeout: number;
  createdAt: number;
  message: string;
}

// 任务内存存储
const tasks: Record<string, Task> = {};

// ==========================================
// 1. 初始化 Aedes MQTT Broker
// ==========================================
const aedes = (Aedes as any)();
const mqttServer = net.createServer(aedes.handle);

mqttServer.listen(MQTT_PORT, () => {
  console.log(`[MQTT] Broker is running on port ${MQTT_PORT}`);
});

aedes.on('client', (client: any) => {
  console.log(`[MQTT] Client Connected: ${client ? client.id : 'unknown'}`);
});

aedes.on('clientDisconnect', (client: any) => {
  console.log(`[MQTT] Client Disconnected: ${client ? client.id : 'unknown'}`);
});

// ==========================================
// 2. 初始化 Hono HTTP 服务
// ==========================================
const app = new Hono();

// 下发任务接口
app.post('/api/tasks', async (c) => {
  try {
    const body = await c.req.json<{ script?: string; timeout?: number | string }>();
    const { script, timeout } = body;

    if (!script) {
      return c.json({ success: false, error: 'script is required' }, 400);
    }

    const taskTimeout = parseInt(String(timeout || '30'), 10);
    const taskId = crypto.randomUUID();
    const createdAt = Date.now();

    // 1. 保存任务到内存
    tasks[taskId] = {
      taskId,
      script,
      status: 'EXECUTING',
      timeout: taskTimeout,
      createdAt,
      message: 'Task dispatched'
    };

    console.log(`[HTTP] Task created: ${taskId}, timeout: ${taskTimeout}s`);

    // 2. 构造推送载荷，注入回调地址
    const payload = {
      taskId,
      cat: 'autojs6',
      script,
      timeout: taskTimeout,
      callbackUrl: `http://${PC_IP}:${PORT}/api/callback`
    };

    // 3. 通过 MQTT Broker 发布到主题 autojs6/tasks
    aedes.publish({
      cmd: 'publish',
      topic: 'autojs6/tasks',
      payload: JSON.stringify(payload),
      qos: 1,
      retain: false,
      dup: false,
      messageId: 0
    }, (err: any) => {
      if (err) {
        console.error(`[MQTT] Publish error for task ${taskId}:`, err);
      } else {
        console.log(`[MQTT] Dispatched task ${taskId} to mobile`);
      }
    });

    return c.json({
      success: true,
      taskId,
      status: 'EXECUTING'
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating task:', err);
    return c.json({ success: false, error: err.message }, 500);
  }
});

// 回调结果接口
app.post('/api/callback', async (c) => {
  try {
    const body = await c.req.json<{ taskId?: string; status?: 'SUCCESS' | 'FAILURE'; message?: string }>();
    const { taskId, status, message } = body;

    if (!taskId || !status) {
      return c.json({ success: false, error: 'taskId and status are required' }, 400);
    }

    const task = tasks[taskId];
    if (!task) {
      console.warn(`[HTTP] Received callback for missing or untracked task: ${taskId}`);
      return c.json({ success: false, error: 'Task not found' }, 404);
    }

    // 更新任务状态 (只允许从 EXECUTING 变更为最终状态)
    if (task.status === 'EXECUTING') {
      task.status = status; // SUCCESS 或 FAILURE
      task.message = message || 'Completed via callback';
      console.log(`[HTTP] Task ${taskId} updated to ${status}. Msg: ${task.message}`);

      // 任务完成时，发布 MQTT 状态更新，通知移动端清理临时文件和定时器
      aedes.publish({
        cmd: 'publish',
        topic: 'autojs6/status',
        payload: JSON.stringify({ taskId, status }),
        qos: 1,
        retain: false,
        dup: false,
        messageId: 0
      }, (err: any) => {
        if (err) console.error(`[MQTT] Failed to send status cleanup message for ${taskId}:`, err);
      });
      
    } else {
      console.log(`[HTTP] Task ${taskId} already in terminal state: ${task.status}. Callback ignored.`);
    }

    return c.json({ success: true });
  } catch (err: any) {
    console.error('[HTTP] Callback handle error:', err);
    return c.json({ success: false, error: err.message }, 500);
  }
});

// 获取所有任务
app.get('/api/tasks', (c) => {
  return c.json({
    success: true,
    tasks: Object.values(tasks)
  });
});

// 获取单个任务状态
app.get('/api/tasks/:taskId', (c) => {
  const taskId = c.req.param('taskId');
  const task = tasks[taskId];

  if (!task) {
    // 监听任务结果：EXECUTING/SUCCESS/FAILURE/MISSING
    // 如果系统里查不到这个任务，返回 MISSING 状态
    return c.json({
      success: true,
      taskId,
      status: 'MISSING',
      message: 'Task not found in system'
    });
  }

  return c.json({
    success: true,
    task
  });
});

// ==========================================
// 3. 轮询超时任务逻辑
// ==========================================
// 如果到了超时时间 + 10s，而移动端没有返回结果，则判断为失败。
setInterval(() => {
  const now = Date.now();
  Object.values(tasks).forEach((task) => {
    if (task.status === 'EXECUTING') {
      const expirationTime = task.createdAt + (task.timeout + 10) * 1000;
      if (now > expirationTime) {
        task.status = 'FAILURE';
        task.message = `Timeout Failure: No response received after timeout (${task.timeout}s) + 10s grace period.`;
        console.warn(`[TIMEOUT RUNNER] Task ${task.taskId} judged as FAILURE due to timeout.`);
        
        // 虽然判定失败，但依然尝试给移动端发送清理消息以防移动端之后又连接上来
        aedes.publish({
          cmd: 'publish',
          topic: 'autojs6/status',
          payload: JSON.stringify({ taskId: task.taskId, status: 'FAILURE' }),
          qos: 1,
          retain: false,
          dup: false,
          messageId: 0
        }, () => {});
      }
    }
  });
}, 2000);

// 启动 Hono 服务器
serve({
  fetch: app.fetch,
  port: PORT
}, (info) => {
  console.log(`[HTTP] Server is running on http://localhost:${info.port}`);
});
