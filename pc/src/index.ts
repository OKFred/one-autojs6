import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import dotenv from "dotenv";
import { startCampaignWorker } from "./tiktok-campaign-runner.js";
import { MqttService } from "./service/mqtt.service.js";
import { registerSwagger } from "./swagger.js";
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import { exec } from "child_process";
import {
  createDeviceOpsWebSocketEndpoint,
  resolveDeviceOpsWebSocketConfig,
  type DeviceOpsWebSocketConfig,
} from "./device-ops-websocket.js";
import { attachWebSocketUpgradeRouter } from "./websocket-upgrade-router.js";
import { DEVICE_OPS_MAX_FRAME_BYTES } from "./device-ops-protocol.js";
import {
  createRemoteControlWebSocketEndpoint,
  resolveRemoteControlWebSocketConfig,
  type RemoteControlWebSocketConfig,
} from "./remote-control-websocket.js";
import { REMOTE_CONTROL_MAX_JSON_BYTES } from "./remote-control-protocol.js";
import {
  createApiAuthMiddleware,
  isValidApiToken,
} from "./middleware/api-auth.js";
import {
  createTask,
  getAllTasks,
  getTaskStatus,
  createApps,
  createAppsDetails,
  createUpdate,
  checkUpdate,
  executeUpdate,
  tiktokPost,
  proxyFile,
  downloadFile,
  switchNetwork,
  applyNetworkRouting,
  disableNetworkRouting,
  getNetworkRouting,
  createClientDeployment,
  getClientDeployment,
  rollbackClientDeployment,
  createDeviceOpsTask,
  getDeviceOpsTask,
  closeRemoteControlSession,
  createRemoteControlRouteProbe,
  createRemoteControlSession,
  getRemoteControlRouteProbe,
  getRemoteControlSession,
} from "./controller/index.js";

dotenv.config();

if (!process.env.PORT) {
  console.error(
    "[ERROR] Environment variable PORT is required. Please check your config.",
  );
  process.exit(1);
}
if (!process.env.MQTT_PORT) {
  console.error(
    "[ERROR] Environment variable MQTT_PORT is required. Please check your config.",
  );
  process.exit(1);
}
if (!process.env.PC_IP) {
  console.error(
    "[ERROR] Environment variable PC_IP is required. Please check your config.",
  );
  process.exit(1);
}
if (!process.env.ONE_AUTOJS6_API_TOKEN) {
  console.error(
    "[ERROR] Environment variable ONE_AUTOJS6_API_TOKEN is required.",
  );
  process.exit(1);
}
let deviceOpsWebSocketConfig: DeviceOpsWebSocketConfig | null = null;
let remoteControlWebSocketConfig: RemoteControlWebSocketConfig | null = null;
try {
  deviceOpsWebSocketConfig = resolveDeviceOpsWebSocketConfig();
  remoteControlWebSocketConfig = resolveRemoteControlWebSocketConfig();
  if (
    deviceOpsWebSocketConfig &&
    remoteControlWebSocketConfig &&
    deviceOpsWebSocketConfig.pathname === remoteControlWebSocketConfig.pathname
  ) {
    throw new Error(
      "DEVICE_OPS_WS_URL and REMOTE_CONTROL_RELAY_WS_URL must use different paths",
    );
  }
} catch (error) {
  console.error(
    `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const PORT = parseInt(process.env.PORT, 10);
const MQTT_PORT = parseInt(process.env.MQTT_PORT, 10);

// ==========================================
// 1. 初始化 MQTT Broker 服务
// ==========================================
MqttService.getInstance().init(MQTT_PORT);
startCampaignWorker();

// ==========================================
// 2. 初始化 Hono HTTP 服务与绑定路由
// ==========================================
const app = new Hono();

// 除只读连接配置外，所有 PC API 都要求 Bearer Token。
app.use("/api/*", createApiAuthMiddleware());

// 注册 Swagger 接口文档
registerSwagger(app);

// 下发通用任务
app.post("/api/tasks", createTask);

// 获取所有任务
app.get("/api/tasks", getAllTasks);

// 获取单个任务状态
app.get("/api/tasks/:taskId", getTaskStatus);

// 短期设备运维任务：HTTP 只异步受理，手机通过独立认证 WSS 回传结果。
app.post(
  "/api/ops/tasks",
  bodyLimit({
    maxSize: DEVICE_OPS_MAX_FRAME_BYTES,
    onError: (c) =>
      c.json(
        {
          ok: false,
          message: "Request body exceeds the device operations limit",
          data: {},
        },
        413,
      ),
  }),
  createDeviceOpsTask,
);
app.get("/api/ops/tasks/:taskId", getDeviceOpsTask);

// AP 隔离场景下的短期服务端会合、单控制租约与有界二进制中继。
app.post(
  "/api/remote/sessions",
  bodyLimit({
    maxSize: REMOTE_CONTROL_MAX_JSON_BYTES,
    onError: (c) =>
      c.json(
        {
          ok: false,
          message: "Request body exceeds the remote-control limit",
          data: {},
        },
        413,
      ),
  }),
  createRemoteControlSession,
);
app.get("/api/remote/sessions/:sessionId", getRemoteControlSession);
app.post(
  "/api/remote/sessions/:sessionId/route-probes",
  bodyLimit({
    maxSize: REMOTE_CONTROL_MAX_JSON_BYTES,
    onError: (c) =>
      c.json(
        {
          ok: false,
          message: "Request body exceeds the remote-control limit",
          data: {},
        },
        413,
      ),
  }),
  createRemoteControlRouteProbe,
);
app.get(
  "/api/remote/sessions/:sessionId/route-probes/:taskId",
  getRemoteControlRouteProbe,
);
app.post(
  "/api/remote/sessions/:sessionId/close",
  closeRemoteControlSession,
);

// 下发获取基础应用列表任务 (包名)
app.post("/api/apps", createApps);

// 下发获取详细应用信息任务 (名称、包名、版本等)
app.post("/api/apps/details", createAppsDetails);

// 下发设备自更新任务
app.post("/api/devices/update", createUpdate);

// 客户端不可变发布部署与回滚
app.post("/api/devices/deployments", createClientDeployment);
app.get("/api/deployments/:deploymentId", getClientDeployment);
app.post("/api/deployments/:deploymentId/rollback", rollbackClientDeployment);

// 检查宿主应用版本与更新状态
app.post("/api/apps/check-update", checkUpdate);

// 执行宿主应用更新自动化
app.post("/api/apps/execute-update", executeUpdate);

// 执行 TikTok 自动发帖
app.post("/api/tiktok/post", tiktokPost);

// 手机通用下载与传文件
app.post("/api/files/download", downloadFile);

// 手机网络切换 (wifi, ethernet, carrier)
app.post("/api/network/switch", switchNetwork);

// 持久网络分流只代理 Node Server，不提供直连 MQTT 回退。
app.post("/api/network-routing/get", getNetworkRouting);
app.post("/api/network-routing/apply", applyNetworkRouting);
app.post("/api/network-routing/disable", disableNetworkRouting);

// PC 代理拉取 SMB 等资源
app.get("/api/proxy", proxyFile);

// 暴露给前端的配置接口
app.get("/api/config", (c) => {
  return c.json({
    ok: true,
    message: "Success",
    data: {
      wsPort: MQTT_PORT + 1,
      defaultClientId: String(process.env.AUTOJS6_CLIENT_ID || ""),
      defaultAdbSerial: String(process.env.AUTOJS6_ADB_SERIAL || ""),
      scrcpyOrigin: String(
        process.env.SCRCPY_ORIGIN || "http://127.0.0.1:8000",
      ),
      deviceOpsEnabled: deviceOpsWebSocketConfig !== null,
      remoteControlEnabled: remoteControlWebSocketConfig !== null,
    },
  });
});

// 静态网页服务，提供 Dashboard 页面
app.use("/dashboard/*", serveStatic({ root: "./public" }));
// 重定向 /dashboard 到 /dashboard/index.html
app.get("/dashboard", (c) => c.redirect("/dashboard/index.html"));

// 本地远控、运维和录制演示工作台。
app.use("/studio/*", serveStatic({ root: "./public" }));
app.get("/studio", (c) => c.redirect("/studio/index.html"));

// 启动 Hono 服务器
const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(`[HTTP] Server is running on http://localhost:${info.port}`);
    console.log(
      `[HTTP] Swagger UI is available on http://localhost:${info.port}/swagger`,
    );
  },
);

// 附加基于 WS 的原生简易截屏服务 (用于 Dashboard 的无依赖投屏)
const wss = new WebSocketServer({
  noServer: true,
  verifyClient: ({ req }: { req: IncomingMessage }) => {
    const protocols = String(req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((value) => value.trim());
    const bearerProtocol = protocols.find((value) =>
      value.startsWith("bearer."),
    );
    if (!bearerProtocol) return false;
    try {
      const token = Buffer.from(bearerProtocol.slice(7), "base64url").toString(
        "utf8",
      );
      return isValidApiToken(token);
    } catch {
      return false;
    }
  },
  handleProtocols: (protocols) =>
    protocols.has("one-autojs6") ? "one-autojs6" : false,
});
wss.on("connection", (ws) => {
  console.log("[SCREEN-WS] Client connected for screen mirroring.");
  // 使用定时器轮询拉取截屏
  const interval = setInterval(() => {
    exec(
      "adb exec-out screencap -p",
      { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (!err && stdout && stdout.length > 0) {
          if (ws.readyState === ws.OPEN) {
            // 发送二进制图像给前端
            ws.send(stdout);
          }
        }
      },
    );
  }, 1000); // 1秒获取1次，帧率约1FPS

  ws.on("close", () => {
    console.log("[SCREEN-WS] Client disconnected from screen mirroring.");
    clearInterval(interval);
  });
});

// 一个 upgrade 路由器同时承载投屏与可选运维通道，避免两个 path WSS 互相拒绝。
const deviceOpsEndpoint = deviceOpsWebSocketConfig
  ? createDeviceOpsWebSocketEndpoint(deviceOpsWebSocketConfig)
  : null;
const remoteControlEndpoint = remoteControlWebSocketConfig
  ? createRemoteControlWebSocketEndpoint(remoteControlWebSocketConfig)
  : null;
attachWebSocketUpgradeRouter(server as any, [
  {
    pathname: "/api/screen",
    webSocketServer: wss,
  },
  ...(deviceOpsEndpoint ? [deviceOpsEndpoint] : []),
  ...(remoteControlEndpoint ? [remoteControlEndpoint] : []),
]);
if (deviceOpsEndpoint) {
  console.log(
    `[OPS-WS] Device operations gateway enabled on ${deviceOpsEndpoint.pathname}`,
  );
} else {
  console.log(
    "[OPS-WS] Device operations gateway disabled; set DEVICE_OPS_REPORT_TOKEN and DEVICE_OPS_WS_URL together to enable it",
  );
}
if (remoteControlEndpoint) {
  console.log(
    `[REMOTE-WS] Server relay enabled on ${remoteControlEndpoint.pathname}`,
  );
} else {
  console.log(
    "[REMOTE-WS] Server relay disabled; set REMOTE_CONTROL_RELAY_WS_URL with DEVICE_OPS_REPORT_TOKEN to enable it",
  );
}
