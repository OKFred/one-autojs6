import type { Context } from "hono";

import {
  DEVICE_OPS_MAX_FRAME_BYTES,
  isDeviceOpsId,
  parseDeviceOpsCreateInput,
} from "../device-ops-protocol.js";
import {
  DeviceOpsGatewayError,
  DeviceOpsService,
} from "../service/device-ops.service.js";

const deviceOps = DeviceOpsService.getInstance();

/**
 * Create an asynchronous operation over a temporary device-initiated WSS.
 *
 * @swagger
 * /api/ops/tasks:
 *   post:
 *     tags: [设备运维]
 *     summary: 异步下发一项白名单设备运维操作
 *     description: 创建内存任务并通过 MQTT 发布 OPEN_SESSION；接口只等待 QoS 1 确认，不等待设备执行结果。使用返回的 taskId 轮询终态。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientId, operation]
 *             additionalProperties: false
 *             properties:
 *               clientId:
 *                 type: string
 *               operation:
 *                 type: string
 *                 enum: [device.ops.capabilities, device.audio.get, device.audio.set, device.audio.mute, device.audio.unmute, device.storage.stat, device.files.list, device.foreground.get, device.ui.target-at, device.network.get, device.screen.brightness.get, device.screen.brightness.set, device.telephony.get, device.alert.find, device.screen.capture]
 *               params:
 *                 type: object
 *                 additionalProperties: true
 *                 description: 按 operation 严格校验。ui.target-at 必须传 x、y、screenWidth、screenHeight 四个整数且坐标在屏幕内；brightness.set 至少传 level(1-255) 或 mode(manual/automatic)；alert.find 只允许 durationMs(500-5000)；audio.set 的 level 是先由 audio.get 查询范围后的绝对索引，不是百分比。
 *               timeoutMs:
 *                 type: integer
 *                 minimum: 1000
 *                 maximum: 15000
 *                 default: 10000
 *     responses:
 *       202:
 *         description: OPEN_SESSION 已被 Broker 确认，任务状态为 EXECUTING
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [ok, message, data]
 *               properties:
 *                 ok: { type: boolean, const: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   required: [taskId, sessionId, clientId, operation, status]
 *                   properties:
 *                     taskId: { type: string }
 *                     sessionId: { type: string }
 *                     clientId: { type: string }
 *                     operation: { type: string }
 *                     status: { type: string, const: EXECUTING }
 *       400:
 *         description: 请求不是允许的结构化操作
 *       401:
 *         description: PC Bearer Token 缺失或错误
 *       409:
 *         description: 设备会话正过期或并发已达上限
 *       413:
 *         description: 请求 JSON 超过 64 KiB
 *       502:
 *         description: MQTT OPEN_SESSION 发布失败
 *       503:
 *         description: 网关未启用或临时任务容量已满
 *
 * @param c Hono 路由上下文。
 * @returns 标准 PC JSON 响应信封。
 */
export async function createDeviceOpsTask(c: Context) {
  const contentLength = Number(c.req.header("content-length") || "0");
  if (
    !Number.isFinite(contentLength) ||
    contentLength < 0 ||
    contentLength > DEVICE_OPS_MAX_FRAME_BYTES
  ) {
    return c.json(
      {
        ok: false,
        message: "Request body exceeds the device operations limit",
        data: {},
      },
      413,
    );
  }
  let input;
  try {
    const body: unknown = await c.req.json();
    if (
      Buffer.byteLength(JSON.stringify(body), "utf8") >
      DEVICE_OPS_MAX_FRAME_BYTES
    ) {
      throw new Error("Request body exceeds the device operations limit");
    }
    input = parseDeviceOpsCreateInput(body);
  } catch (error) {
    return c.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        data: {},
      },
      400,
    );
  }
  try {
    const task = await deviceOps.createOperation(input);
    return c.json(
      {
        ok: true,
        message: "Device operation accepted",
        data: task,
      },
      202,
    );
  } catch (error) {
    const status = error instanceof DeviceOpsGatewayError ? error.httpStatus : 500;
    return c.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        data: {},
      },
      status,
    );
  }
}

/**
 * Poll one temporary device operation task and its terminal result.
 *
 * @swagger
 * /api/ops/tasks/{taskId}:
 *   get:
 *     tags: [设备运维]
 *     summary: 查询设备运维任务状态
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: 返回 EXECUTING 或终态结果；截图以受限 base64 字段临时返回
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [ok, message, data]
 *               properties:
 *                 ok: { type: boolean, const: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   required: [taskId, sessionId, clientId, operation, status]
 *                   properties:
 *                     taskId: { type: string }
 *                     sessionId: { type: string }
 *                     clientId: { type: string }
 *                     operation: { type: string }
 *                     status:
 *                       type: string
 *                       enum: [EXECUTING, SUCCESS, FAILURE, TIMEOUT, REJECTED, CANCELLED]
 *                     code: { type: [string, "null"] }
 *                     message: { type: [string, "null"] }
 *                     data: {}
 *                     artifact:
 *                       description: 截图操作终态可包含的临时元数据与 base64 内容，否则为 null
 *       400:
 *         description: taskId 格式错误
 *       401:
 *         description: PC Bearer Token 缺失或错误
 *       404:
 *         description: 任务不存在或已超过内存保留期
 *
 * @param c Hono 路由上下文。
 * @returns 标准 PC JSON 响应信封。
 */
export function getDeviceOpsTask(c: Context) {
  const taskId = c.req.param("taskId") || "";
  if (!isDeviceOpsId(taskId)) {
    return c.json(
      { ok: false, message: "Invalid device operations taskId", data: {} },
      400,
    );
  }
  const task = deviceOps.getTask(taskId);
  if (!task) {
    return c.json(
      { ok: false, message: "Device operations task not found", data: {} },
      404,
    );
  }
  return c.json({
    ok: true,
    message: "Device operation task retrieved",
    data: task,
  });
}
