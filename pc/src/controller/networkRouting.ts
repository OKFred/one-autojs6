import type { Context } from "hono";

import { NodeServerService } from "../service/node-server.service.js";

const nodeServer = NodeServerService.getInstance();
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

async function body(c: Context): Promise<Record<string, unknown>> {
  return c.req.json<Record<string, unknown>>().catch(() => ({}));
}

function clientIdFrom(value: unknown): string | null {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value)
    ? value
    : null;
}

/**
 * @swagger
 * /api/network-routing/get:
 *   post:
 *     tags: [网络分流]
 *     summary: 查询设备持久网络分流配置与状态
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientId]
 *             properties:
 *               clientId: { type: string }
 *     responses:
 *       200: { description: Node Server 网络分流状态 }
 */
export async function getNetworkRouting(c: Context) {
  try {
    const input = await body(c);
    const clientId = clientIdFrom(input.clientId);
    if (!clientId)
      return c.json({ ok: false, message: "Invalid clientId", data: {} }, 400);
    const result = await nodeServer.getNetworkRouting(clientId);
    return c.json({ ok: true, message: "Success", data: result });
  } catch (error) {
    return c.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        data: {},
      },
      502,
    );
  }
}

/**
 * @swagger
 * /api/network-routing/apply:
 *   post:
 *     tags: [网络分流]
 *     summary: 通过 Node Server 异步应用 Android 默认/Wi-Fi/中国电信 Internet 出口
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientId, internetTarget]
 *             properties:
 *               clientId: { type: string }
 *               internetTarget: { type: string, enum: [default, wifi, carrier] }
 *     responses:
 *       200: { description: 返回异步 taskId 与 generation }
 */
export async function applyNetworkRouting(c: Context) {
  try {
    const input = await body(c);
    const clientId = clientIdFrom(input.clientId);
    const internetTarget = input.internetTarget;
    if (
      !clientId ||
      (internetTarget !== "default" &&
        internetTarget !== "wifi" &&
        internetTarget !== "carrier")
    ) {
      return c.json(
        { ok: false, message: "Invalid network routing request", data: {} },
        400,
      );
    }
    const result = await nodeServer.applyNetworkRouting({
      clientId,
      internetTarget,
    });
    return c.json({
      ok: true,
      message: "Network routing task dispatched",
      data: result,
    });
  } catch (error) {
    return c.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        data: {},
      },
      502,
    );
  }
}

/**
 * @swagger
 * /api/network-routing/disable:
 *   post:
 *     tags: [网络分流]
 *     summary: 停用持久分流并恢复 Android 默认路由
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientId]
 *             properties:
 *               clientId: { type: string }
 *     responses:
 *       200: { description: 返回异步 taskId 与 generation }
 */
export async function disableNetworkRouting(c: Context) {
  try {
    const input = await body(c);
    const clientId = clientIdFrom(input.clientId);
    if (!clientId)
      return c.json({ ok: false, message: "Invalid clientId", data: {} }, 400);
    const result = await nodeServer.disableNetworkRouting(clientId);
    return c.json({
      ok: true,
      message: "Network routing disable task dispatched",
      data: result,
    });
  } catch (error) {
    return c.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        data: {},
      },
      502,
    );
  }
}
