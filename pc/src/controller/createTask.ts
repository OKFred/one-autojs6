import type { Context } from "hono";
import { AutojsService } from "../service/autojs.service.js";
import type { TrustedScriptId } from "../service/node-server.service.js";
import type { TaskPriority } from "../service/node-server.service.js";

const autojsService = AutojsService.getInstance();

const trustedScriptIds: TrustedScriptId[] = [
  "device.apps.list",
  "app.install",
  "app.version.check",
  "app.update.store",
  "app.update.zip",
  "file.download",
  "tiktok.post",
  "device.network.switch",
];

/** 判断字符串是否为 PC 允许代理的可信脚本标识。 */
function isTrustedScriptId(value: string): value is TrustedScriptId {
  return trustedScriptIds.includes(value as TrustedScriptId);
}

/**
 * 下发手机端可信脚本任务。
 * 原始 JavaScript、Shell、kill 与动态监听配置不再受支持。
 *
 * @swagger
 * /api/tasks:
 *   post:
 *     tags: [任务]
 *     summary: 下发已注册的手机可信脚本
 *     description: preemptRunning 会强制停止同级或更低优先级任务。TikTok、安装、下载、更新和网络切换可能已经产生不可回滚副作用。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [scriptId]
 *             properties:
 *               scriptId:
 *                 type: string
 *               params:
 *                 type: object
 *                 additionalProperties: true
 *               timeout:
 *                 type: integer
 *                 description: 任务总超时秒数
 *               clientId:
 *                 type: string
 *               priority:
 *                 type: string
 *                 enum: [LOW, NORMAL, HIGH]
 *                 description: 网络切换默认 HIGH，其余默认 NORMAL
 *               preemptRunning:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: Broker 已确认下发
 *       400:
 *         description: 请求参数错误
 *       401:
 *         description: Bearer Token 缺失或错误
 */
export async function createTask(c: Context) {
  try {
    const body = await c.req.json<{
      scriptId?: string;
      params?: Record<string, unknown>;
      timeout?: number | string;
      clientId?: string;
      priority?: TaskPriority;
      preemptRunning?: boolean;
    }>();
    if (!body.scriptId || !isTrustedScriptId(body.scriptId)) {
      return c.json(
        {
          ok: false,
          message:
            "A registered scriptId is required; remote source and shell tasks are disabled",
          data: {},
        },
        400,
      );
    }
    if (
      body.priority !== undefined &&
      body.priority !== "LOW" &&
      body.priority !== "NORMAL" &&
      body.priority !== "HIGH"
    ) {
      return c.json(
        {
          ok: false,
          message: "priority must be LOW, NORMAL, or HIGH",
          data: {},
        },
        400,
      );
    }
    if (
      body.preemptRunning !== undefined &&
      typeof body.preemptRunning !== "boolean"
    ) {
      return c.json(
        {
          ok: false,
          message: "preemptRunning must be a boolean",
          data: {},
        },
        400,
      );
    }
    const timeout = Number.parseInt(String(body.timeout || "120"), 10);
    const task = await autojsService.dispatchTask(
      body.scriptId,
      body.params || {},
      timeout,
      body.clientId,
      body.priority,
      body.preemptRunning === true,
    );
    return c.json({
      ok: true,
      message: "Trusted task dispatched",
      data: task,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[HTTP] Error creating trusted task:", error);
    return c.json({ ok: false, message, data: {} }, 500);
  }
}
