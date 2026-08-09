import { Context } from "hono";
import { AutojsService } from "../service/autojs.service.js";

const autojsService = AutojsService.getInstance();

/**
 * 异步下发获取设备应用详细信息任务。
 *
 * @swagger
 * /api/apps/details:
 *   post:
 *     tags: [应用管理]
 *     summary: 异步下发获取设备应用详细信息任务
 *     description: 通过 Node Server 下发手机端已注册的 device.apps.list 脚本，返回 taskId 供轮询。
 *     parameters:
 *       - in: query
 *         name: timeout
 *         schema:
 *           type: integer
 *           default: 30
 *         description: 任务超时时间(秒)
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
 *       500:
 *         description: 下发任务失败
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
 *
 * @param c - Hono 路由上下文对象
 * @returns Hono JSON 响应
 */
export async function createAppsDetails(c: Context) {
  try {
    const timeoutStr = c.req.query("timeout") || "30";
    const timeout = parseInt(timeoutStr, 10);

    const task = await autojsService.dispatchTask(
      "device.apps.list",
      {},
      timeout,
    );

    return c.json({
      ok: true,
      message: "Apps details task dispatched successfully",
      data: {
        taskId: task.taskId,
        status: task.status,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[HTTP] Error creating apps details task:", error);
    return c.json({ ok: false, message, data: {} }, 500);
  }
}
