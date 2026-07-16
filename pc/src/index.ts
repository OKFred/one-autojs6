import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import dotenv from 'dotenv';
import { MqttService } from './service/mqtt.service.js';
import { registerSwagger } from './swagger.js';
import {
  createTask,
  handleCallback,
  getAllTasks,
  getTaskStatus,
  createAppsTask,
  createAppsDetailsTask,
  createUpdateTask
} from './controller/index.js';

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

// 注册 Swagger 接口文档
registerSwagger(app);

// 下发通用任务
app.post('/api/tasks', createTask);

// 接收移动端的回调
app.post('/api/callback', handleCallback);

// 获取所有任务
app.get('/api/tasks', getAllTasks);

// 获取单个任务状态
app.get('/api/tasks/:taskId', getTaskStatus);

// 下发获取基础应用列表任务 (包名)
app.post('/api/apps/task', createAppsTask);

// 下发获取详细应用信息任务 (名称、包名、版本等)
app.post('/api/apps/details-task', createAppsDetailsTask);

// 下发设备自更新任务
app.post('/api/devices/update-task', createUpdateTask);

// 启动 Hono 服务器
serve({
  fetch: app.fetch,
  port: PORT
}, (info) => {
  console.log(`[HTTP] Server is running on http://localhost:${info.port}`);
  console.log(`[HTTP] Swagger UI is available on http://localhost:${info.port}/swagger`);
});
