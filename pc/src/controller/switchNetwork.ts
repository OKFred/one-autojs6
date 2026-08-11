import type { Context } from "hono";
import { AutojsService } from "../service/autojs.service.js";
import type { TaskPriority } from "../service/node-server.service.js";

const autojsService = AutojsService.getInstance();

/**
 * 异步下发切换移动端网络 (wifi, ethernet, carrier) 任务。
 *
 * @swagger
 * /api/network/switch:
 *   post:
 *     tags: [网络管理]
 *     summary: 异步下发网络切换任务
 *     description: 下发手机端网络切换任务 (wifi, ethernet, carrier)。若目标网络在 20s 内不可用，自动恢复原网络配置。
 *     parameters:
 *       - in: query
 *         name: target
 *         schema:
 *           type: string
 *           enum: [wifi, ethernet, carrier]
 *           default: wifi
 *         description: 目标网络类型：wifi、ethernet (以太网)、carrier (蜂窝移动数据)
 *       - in: query
 *         name: clientId
 *         schema:
 *           type: string
 *         description: 目标设备 ID (可选；若未传递则从 pc/.env 配置的 AUTOJS6_CLIENT_ID 读取)
 *       - in: query
 *         name: timeout
 *         schema:
 *           type: integer
 *           default: 30
 *         description: 任务整体超时时间(秒)
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               target:
 *                 type: string
 *                 enum: [wifi, ethernet, carrier]
 *                 description: 目标网络类型
 *               clientId:
 *                 type: string
 *                 description: 目标设备 ID
 *               timeoutMs:
 *                 type: integer
 *                 default: 20000
 *                 description: 目标网络检测超时时间(毫秒)，默认 20 秒
 *               priority:
 *                 type: string
 *                 enum: [LOW, NORMAL, HIGH]
 *                 default: HIGH
 *               preemptRunning:
 *                 type: boolean
 *                 default: false
 *                 description: 显式抢占同级或更低优先级任务；网络切换可能已经产生副作用
 *     responses:
 *       200:
 *         description: 任务下发成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     taskId:
 *                       type: string
 *                     status:
 *                       type: string
 *       400:
 *         description: 请求参数错误
 *       500:
 *         description: 下发任务失败
 *
 * @param c - Hono 路由上下文对象
 * @returns Hono JSON 响应
 */
export async function switchNetwork(c: Context) {
  try {
    let bodyTarget: string | undefined;
    let bodyTimeoutMs: number | undefined;
    let bodyClientId: string | undefined;
    let bodyPriority: TaskPriority | undefined;
    let bodyPreemptRunning: boolean | undefined;

    try {
      const body = await c.req.json<{
        target?: string;
        timeoutMs?: number;
        clientId?: string;
        priority?: TaskPriority;
        preemptRunning?: boolean;
      }>();
      if (body) {
        bodyTarget = body.target;
        bodyTimeoutMs = body.timeoutMs;
        bodyClientId = body.clientId;
        bodyPriority = body.priority;
        bodyPreemptRunning = body.preemptRunning;
      }
    } catch (_) {
      // 允许无 JSON body 的请求，退回 query 参数
    }

    const queryTarget = c.req.query("target");
    const queryClientId = c.req.query("clientId");
    const rawTarget = String(bodyTarget || queryTarget || "wifi").toLowerCase();
    const clientId = bodyClientId || queryClientId;
    const priority = bodyPriority || "HIGH";
    if (priority !== "LOW" && priority !== "NORMAL" && priority !== "HIGH") {
      return c.json({ ok: false, message: "Invalid priority", data: {} }, 400);
    }
    if (
      bodyPreemptRunning !== undefined &&
      typeof bodyPreemptRunning !== "boolean"
    ) {
      return c.json(
        { ok: false, message: "preemptRunning must be a boolean", data: {} },
        400,
      );
    }

    let target = rawTarget;
    if (target === "cellular" || target === "mobile" || target === "data") {
      target = "carrier";
    }

    if (target !== "wifi" && target !== "ethernet" && target !== "carrier") {
      return c.json(
        {
          ok: false,
          message: "Invalid target. Must be wifi, ethernet, or carrier",
          data: {},
        },
        400,
      );
    }

    const timeoutStr = c.req.query("timeout") || "30";
    const parsedTimeout = parseInt(timeoutStr, 10);
    const checkTimeoutMs = Math.max(
      1000,
      Math.min(
        120000,
        Number.isFinite(bodyTimeoutMs)
          ? Math.trunc(bodyTimeoutMs as number)
          : 20000,
      ),
    );
    const timeout = Math.min(
      150,
      Math.max(
        Number.isFinite(parsedTimeout) ? parsedTimeout : 30,
        Math.ceil(checkTimeoutMs / 1000) + 20,
      ),
    );

    const task = await autojsService.dispatchTask(
      "device.network.switch",
      { target, timeoutMs: checkTimeoutMs },
      timeout,
      clientId,
      priority,
      bodyPreemptRunning === true,
    );

    return c.json({
      ok: true,
      message: `Network switch task to ${target} dispatched successfully`,
      data: {
        taskId: task.taskId,
        status: task.status,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[HTTP] Error creating network switch task:", error);
    return c.json({ ok: false, message, data: {} }, 500);
  }
}
