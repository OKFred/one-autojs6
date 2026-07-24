import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import dotenv from 'dotenv';
import { MqttService } from './service/mqtt.service.js';
import { registerSwagger } from './swagger.js';
import { WebSocketServer } from 'ws';
import { exec } from 'child_process';
import {
  createTask,
  handleCallback,
  getAllTasks,
  getTaskStatus,
  createApps,
  createAppsDetails,
  createUpdate,
  checkUpdate,
  executeUpdate,
  tiktokPost,
  proxyFile,
  downloadFile
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
app.post('/api/apps', createApps);

// 下发获取详细应用信息任务 (名称、包名、版本等)
app.post('/api/apps/details', createAppsDetails);

// 下发设备自更新任务
app.post('/api/devices/update', createUpdate);

// 检查宿主应用版本与更新状态
app.post('/api/apps/check-update', checkUpdate);

// 执行宿主应用更新自动化
app.post('/api/apps/execute-update', executeUpdate);

// 执行 TikTok 自动发帖
app.post('/api/tiktok/post', tiktokPost);

// 手机通用下载与传文件
app.post('/api/files/download', downloadFile);

// PC 代理拉取 SMB 等资源
app.get('/api/proxy', proxyFile);

// 暴露给前端的配置接口
app.get('/api/config', (c) => {
  return c.json({
    ok: true,
    message: 'Success',
    data: {
      wsPort: MQTT_PORT + 1
    }
  });
});

// 静态网页服务，提供 Dashboard 页面
app.use('/dashboard/*', serveStatic({ root: './public' }));
// 重定向 /dashboard 到 /dashboard/index.html
app.get('/dashboard', (c) => c.redirect('/dashboard/index.html'));

// 启动 Hono 服务器
const server = serve({
  fetch: app.fetch,
  port: PORT
}, (info) => {
  console.log(`[HTTP] Server is running on http://localhost:${info.port}`);
  console.log(`[HTTP] Swagger UI is available on http://localhost:${info.port}/swagger`);
});

// 附加基于 WS 的原生简易截屏服务 (用于 Dashboard 的无依赖投屏)
const wss = new WebSocketServer({ server: server as any, path: '/api/screen' });
wss.on('connection', (ws) => {
  console.log('[SCREEN-WS] Client connected for screen mirroring.');
  // 使用定时器轮询拉取截屏
  const interval = setInterval(() => {
    exec('adb exec-out screencap -p', { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (!err && stdout && stdout.length > 0) {
        if (ws.readyState === ws.OPEN) {
          // 发送二进制图像给前端
          ws.send(stdout);
        }
      }
    });
  }, 1000); // 1秒获取1次，帧率约1FPS

  ws.on('close', () => {
    console.log('[SCREEN-WS] Client disconnected from screen mirroring.');
    clearInterval(interval);
  });
});
