import type { Context } from "hono";

import { isDeviceOpsId, isDeviceOpsRecord } from "../device-ops-protocol.js";
import {
  REMOTE_CONTROL_MAX_JSON_BYTES,
  parseRemoteControlCreateInput,
} from "../remote-control-protocol.js";
import {
  RemoteControlGatewayError,
  RemoteControlService,
} from "../service/remote-control.service.js";
import {
  RemoteControlRouteProbeError,
  RemoteControlRouteProbeService,
  normalizeRemoteControlRouteAddress,
} from "../service/remote-control-route-probe.service.js";

const remoteControl = RemoteControlService.getInstance();
const routeProbes = RemoteControlRouteProbeService.getInstance();

/**
 * Parse the single exact target field accepted by route diagnostics.
 *
 * @param value Untrusted JSON request body.
 * @returns Canonical literal IP address.
 */
function parseRemoteControlRouteProbeInput(value: unknown): string {
  if (
    !isDeviceOpsRecord(value) ||
    Object.keys(value).length !== 1 ||
    !("targetAddress" in value)
  ) {
    throw new Error("Route probe body must contain only targetAddress");
  }
  const address = normalizeRemoteControlRouteAddress(value.targetAddress);
  if (!address) throw new Error("targetAddress must be a literal IP address");
  return address;
}

/**
 * Create one short-lived server-relayed remote-control lease.
 *
 * @swagger
 * /api/remote/sessions:
 *   post:
 *     tags: [远程控制]
 *     summary: 创建异步远控会合与中继租约
 *     description: 在内存中锁定单个设备、生成两端一次性票据，并通过 MQTT 发布 OPEN_REMOTE_SESSION。接口只等待 QoS 1 确认，不等待设备或浏览器连接。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientId]
 *             additionalProperties: false
 *             properties:
 *               clientId: { type: string }
 *               ttlMs:
 *                 type: integer
 *                 minimum: 30000
 *                 maximum: 1800000
 *                 default: 600000
 *               transportPreference:
 *                 type: string
 *                 enum: [relay, p2p-preferred]
 *                 default: relay
 *     responses:
 *       202:
 *         description: MQTT 已确认；返回 EXECUTING 租约和只显示一次的 browserTicket
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
 *                   required: [taskId, status, sessionId, sessionState, relayWsUrl, browserTicket, expiresAtUtc]
 *                   properties:
 *                     taskId: { type: string }
 *                     status: { type: string, const: EXECUTING }
 *                     sessionId: { type: string }
   *                     sessionState: { type: string, enum: [WAITING_PEERS, WAITING_DEVICE, WAITING_CONTROLLER, SELECTING_TRANSPORT, RECOVERING_TRANSPORT, ACTIVE] }
   *                     selectedTransport: { type: string, enum: [relay, p2p], nullable: true }
   *                     p2pStatus: { type: string, enum: [DISABLED, AVAILABLE, NEGOTIATING, ACTIVE, FALLBACK] }
   *                     p2pNegotiationDurationMs: { type: integer, minimum: 0, nullable: true }
   *                     p2pFailureCode: { type: string, nullable: true }
   *                     relayWsUrl: { type: string, format: uri }
 *                     browserTicket: { type: string, writeOnly: true }
 *                     expiresAtUtc: { type: integer }
 *       400: { description: 请求体或租约参数非法 }
 *       401: { description: PC Bearer Token 缺失或错误 }
 *       409: { description: 该设备已有活动控制租约 }
 *       413: { description: 请求 JSON 超过 64 KiB }
 *       502: { description: MQTT 邀请发布失败 }
 *       503: { description: 中继未启用或容量已满 }
 *
 * @param c Hono route context.
 * @returns Standard PC JSON response envelope.
 */
export async function createRemoteControlSession(c: Context) {
  const contentLength = Number(c.req.header("content-length") || "0");
  if (
    !Number.isFinite(contentLength) ||
    contentLength < 0 ||
    contentLength > REMOTE_CONTROL_MAX_JSON_BYTES
  ) {
    return c.json(
      {
        ok: false,
        message: "Request body exceeds the remote-control limit",
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
      REMOTE_CONTROL_MAX_JSON_BYTES
    ) {
      throw new Error("Request body exceeds the remote-control limit");
    }
    input = parseRemoteControlCreateInput(body);
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
    const session = await remoteControl.createSession(input);
    return c.json(
      {
        ok: true,
        message: "Remote-control session accepted",
        data: session,
      },
      202,
    );
  } catch (error) {
    const status =
      error instanceof RemoteControlGatewayError ? error.httpStatus : 500;
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
 * Poll one ticket-free remote-control lease state.
 *
 * @swagger
 * /api/remote/sessions/{sessionId}:
 *   get:
 *     tags: [远程控制]
 *     summary: 查询远控租约与配对状态
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: 返回配对、连接、传输与终态统计；不返回任何票据
 *       400: { description: sessionId 格式非法 }
 *       401: { description: PC Bearer Token 缺失或错误 }
 *       404: { description: 租约不存在或已超过保留期 }
 *
 * @param c Hono route context.
 * @returns Standard PC JSON response envelope.
 */
export function getRemoteControlSession(c: Context) {
  const sessionId = c.req.param("sessionId") || "";
  if (!isDeviceOpsId(sessionId)) {
    return c.json(
      { ok: false, message: "Invalid remote-control sessionId", data: {} },
      400,
    );
  }
  const session = remoteControl.getSession(sessionId);
  if (!session) {
    return c.json(
      { ok: false, message: "Remote-control session not found", data: {} },
      404,
    );
  }
  return c.json({
    ok: true,
    message: "Remote-control session retrieved",
    data: session,
  });
}

/**
 * Idempotently close one remote-control lease and both relay peers.
 *
 * @swagger
 * /api/remote/sessions/{sessionId}/close:
 *   post:
 *     tags: [远程控制]
 *     summary: 关闭远控租约
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 租约已关闭或此前已进入终态 }
 *       400: { description: sessionId 格式非法 }
 *       401: { description: PC Bearer Token 缺失或错误 }
 *       404: { description: 租约不存在或已超过保留期 }
 *
 * @param c Hono route context.
 * @returns Standard PC JSON response envelope.
 */
export function closeRemoteControlSession(c: Context) {
  const sessionId = c.req.param("sessionId") || "";
  if (!isDeviceOpsId(sessionId)) {
    return c.json(
      { ok: false, message: "Invalid remote-control sessionId", data: {} },
      400,
    );
  }
  const session = remoteControl.closeSession(sessionId);
  if (!session) {
    return c.json(
      { ok: false, message: "Remote-control session not found", data: {} },
      404,
    );
  }
  return c.json({
    ok: true,
    message: "Remote-control session closed",
    data: session,
  });
}

/**
 * Start one PC-local route trace for an address signaled by the active phone.
 *
 * @swagger
 * /api/remote/sessions/{sessionId}/route-probes:
 *   post:
 *     tags: [远程控制]
 *     summary: 异步探测当前手机候选线路的网络节点
 *     description: 仅允许探测当前活动租约中由手机通过 ICE 信令上报过的 IP。使用 PC 本机 traceroute、反向 DNS 与单次 Ping，结果仅在内存短暂保留。
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetAddress]
 *             additionalProperties: false
 *             properties:
 *               targetAddress: { type: string, description: 浏览器 RTCStats 中的手机候选 IP }
 *     responses:
 *       202: { description: 已立即创建 EXECUTING 探测任务 }
 *       400: { description: sessionId 或请求体非法 }
 *       401: { description: PC Bearer Token 缺失或错误 }
 *       404: { description: 远控租约不存在 }
 *       409: { description: 地址不属于本次手机候选或已有其他探测运行中 }
 *       503: { description: 临时探测容量已满 }
 *
 * @param c Hono route context.
 * @returns Standard PC JSON response envelope.
 */
export async function createRemoteControlRouteProbe(c: Context) {
  const sessionId = c.req.param("sessionId") || "";
  if (!isDeviceOpsId(sessionId)) {
    return c.json(
      { ok: false, message: "Invalid remote-control sessionId", data: {} },
      400,
    );
  }
  if (!remoteControl.getSession(sessionId)) {
    return c.json(
      { ok: false, message: "Remote-control session not found", data: {} },
      404,
    );
  }
  let requestedAddress: string;
  try {
    const body: unknown = await c.req.json();
    if (
      Buffer.byteLength(JSON.stringify(body), "utf8") >
      REMOTE_CONTROL_MAX_JSON_BYTES
    ) {
      throw new Error("Request body exceeds the remote-control limit");
    }
    requestedAddress = parseRemoteControlRouteProbeInput(body);
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
  const targetAddress = remoteControl.authorizeRouteProbeTarget(
    sessionId,
    requestedAddress,
  );
  if (!targetAddress) {
    return c.json(
      {
        ok: false,
        message: "The route target is unavailable for this active session",
        data: {},
      },
      409,
    );
  }
  try {
    const task = routeProbes.createProbe(sessionId, targetAddress);
    return c.json(
      {
        ok: true,
        message: "Route probe accepted",
        data: task,
      },
      202,
    );
  } catch (error) {
    const status =
      error instanceof RemoteControlRouteProbeError
        ? error.httpStatus
        : 500;
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
 * Poll one short-lived route-probe task scoped to its remote-control session.
 *
 * @swagger
 * /api/remote/sessions/{sessionId}/route-probes/{taskId}:
 *   get:
 *     tags: [远程控制]
 *     summary: 查询手机候选线路节点探测结果
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 返回任务状态、逐跳 IP、可用的反向域名与延时 }
 *       400: { description: sessionId 或 taskId 格式非法 }
 *       401: { description: PC Bearer Token 缺失或错误 }
 *       404: { description: 探测不存在、已过期或不属于该租约 }
 *
 * @param c Hono route context.
 * @returns Standard PC JSON response envelope.
 */
export function getRemoteControlRouteProbe(c: Context) {
  const sessionId = c.req.param("sessionId") || "";
  const taskId = c.req.param("taskId") || "";
  if (!isDeviceOpsId(sessionId) || !isDeviceOpsId(taskId)) {
    return c.json(
      { ok: false, message: "Invalid route-probe identifier", data: {} },
      400,
    );
  }
  const task = routeProbes.getProbe(sessionId, taskId);
  if (!task) {
    return c.json(
      { ok: false, message: "Route probe not found", data: {} },
      404,
    );
  }
  return c.json({
    ok: true,
    message: "Route probe retrieved",
    data: task,
  });
}
