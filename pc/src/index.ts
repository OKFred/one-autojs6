import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import dotenv from 'dotenv';
import { MqttService } from './service/mqtt.service.js';
import { TaskController } from './controller/task.controller.js';

dotenv.config();

if (!process.env.PORT) {
  console.error('[ERROR] Environment variable PORT is required. Please check your config.');
  process.exit(1);
}
if (!process.env.MQTT_PORT) {
  console.error('[ERROR] Environment variable MQTT_PORT is required. Please check your config.');
  process.exit(1);
}
if (!process.env.PC_IP) {
  console.error('[ERROR] Environment variable PC_IP is required. Please check your config.');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT, 10);
const MQTT_PORT = parseInt(process.env.MQTT_PORT, 10);

// ==========================================
// 1. 初始化 MQTT Broker 服务
// ==========================================
MqttService.getInstance().init(MQTT_PORT);

// ==========================================
// 2. 初始化 Hono HTTP 服务与绑定路由
// ==========================================
const app = new Hono();

// 下发通用任务
app.post('/api/tasks', TaskController.createTask);

// 接收移动端的回调
app.post('/api/callback', TaskController.handleCallback);

// 获取所有任务
app.get('/api/tasks', TaskController.getAllTasks);

// 获取单个任务状态
app.get('/api/tasks/:taskId', TaskController.getTaskStatus);

// 下发获取基础应用列表任务 (包名)
app.post('/api/apps/task', TaskController.createAppsTask);

// 下发获取详细应用信息任务 (名称、包名、版本等)
app.post('/api/apps/details-task', TaskController.createAppsDetailsTask);

// 启动 Hono 服务器
serve({
  fetch: app.fetch,
  port: PORT
}, (info) => {
  console.log(`[HTTP] Server is running on http://localhost:${info.port}`);
});
