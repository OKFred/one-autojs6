import type { Context } from "hono";

import { NodeServerService } from "../service/node-server.service.js";

const nodeServer = NodeServerService.getInstance();

/** 校验部署切换模式。 */
function activationMode(value: unknown): "GRACEFUL" | "FORCE" | null {
  if (value === undefined || value === "GRACEFUL") return "GRACEFUL";
  return value === "FORCE" ? "FORCE" : null;
}

/**
 * 创建客户端版本/环境部署。
 *
 * @swagger
 * /api/devices/deployments:
 *   post:
 *     tags: [客户端部署]
 *     summary: 异步切换设备客户端版本和环境
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientId, releaseVersion, environment]
 *             properties:
 *               clientId: { type: string }
 *               releaseVersion: { type: string, example: v2.0.0 }
 *               environment: { type: string, enum: [development, staging, production] }
 *               activationMode: { type: string, enum: [GRACEFUL, FORCE], default: GRACEFUL }
 *               drainTimeoutMs: { type: integer, default: 900000 }
 *               confirmForce: { type: boolean, default: false }
 *     responses:
 *       200: { description: 部署命令已持久化并异步下发 }
 *       400: { description: 请求参数不合法 }
 *
 * @param c Hono 路由上下文。
 * @returns 标准响应信封。
 */
export async function createClientDeployment(c: Context) {
  try {
    const body = await c.req.json<Record<string, unknown>>();
    const mode = activationMode(body.activationMode);
    if (
      typeof body.clientId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,100}$/.test(body.clientId) ||
      typeof body.releaseVersion !== "string" ||
      !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(body.releaseVersion) ||
      (body.environment !== "development" &&
        body.environment !== "staging" &&
        body.environment !== "production") ||
      !mode
    ) {
      return c.json(
        { ok: false, message: "Invalid client deployment request", data: {} },
        400,
      );
    }
    if (mode === "FORCE" && body.confirmForce !== true) {
      return c.json(
        {
          ok: false,
          message: "FORCE deployment requires confirmForce=true",
          data: {},
        },
        400,
      );
    }
    const deployment = await nodeServer.applyClientDeployment({
      clientId: body.clientId,
      releaseVersion: body.releaseVersion,
      environment: body.environment,
      activationMode: mode,
      drainTimeoutMs:
        typeof body.drainTimeoutMs === "number"
          ? body.drainTimeoutMs
          : undefined,
      confirmForce: body.confirmForce === true,
    });
    return c.json({
      ok: true,
      message: "Client deployment dispatched",
      data: deployment,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, message, data: {} }, 502);
  }
}

/**
 * 查询客户端部署。
 *
 * @swagger
 * /api/deployments/{deploymentId}:
 *   get:
 *     tags: [客户端部署]
 *     summary: 查询部署状态
 *     parameters:
 *       - in: path
 *         name: deploymentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 部署详情 }
 *
 * @param c Hono 路由上下文。
 * @returns 标准响应信封。
 */
export async function getClientDeployment(c: Context) {
  try {
    const deploymentId = c.req.param("deploymentId") || "";
    if (!deploymentId) {
      return c.json(
        { ok: false, message: "deploymentId is required", data: {} },
        400,
      );
    }
    const deployment = await nodeServer.getClientDeployment(deploymentId);
    return c.json({ ok: true, message: "Success", data: deployment });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, message, data: {} }, 502);
  }
}

/**
 * 回滚客户端部署。
 *
 * @swagger
 * /api/deployments/{deploymentId}/rollback:
 *   post:
 *     tags: [客户端部署]
 *     summary: 回滚到前一个健康组合
 *     parameters:
 *       - in: path
 *         name: deploymentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 回滚部署已创建 }
 *
 * @param c Hono 路由上下文。
 * @returns 标准响应信封。
 */
export async function rollbackClientDeployment(c: Context) {
  try {
    const body: Record<string, unknown> = await c.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const deploymentId = c.req.param("deploymentId") || "";
    if (!deploymentId) {
      return c.json(
        { ok: false, message: "deploymentId is required", data: {} },
        400,
      );
    }
    const mode = activationMode(body.activationMode);
    if (!mode || (mode === "FORCE" && body.confirmForce !== true)) {
      return c.json(
        { ok: false, message: "Invalid rollback activation mode", data: {} },
        400,
      );
    }
    const deployment = await nodeServer.rollbackClientDeployment({
      deploymentId,
      activationMode: mode,
      confirmForce: body.confirmForce === true,
    });
    return c.json({
      ok: true,
      message: "Rollback deployment dispatched",
      data: deployment,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, message, data: {} }, 502);
  }
}
