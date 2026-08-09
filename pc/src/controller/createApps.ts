import { Context } from "hono";
import { AutojsService } from "../service/autojs.service.js";

const autojsService = AutojsService.getInstance();

/**
 * 异步下发获取设备应用包名列表的任务。
 *
 * @swagger
 * /api/apps:
 *   post:
 *     tags: [应用管理]
 *     summary: 异步下发获取设备应用包名任务
 *     description: 通过 Node Server 下发手机端已注册的 device.apps.list 脚本，返回 taskId 供轮询。
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [all, third, system]
 *           default: all
 *         description: 过滤应用类型：all(全部)、third(第三方应用)、system(系统应用)
 *       - in: query
 *         name: timeout
 *         schema:
 *           type: integer
 *           default: 15
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
export async function createApps(c: Context) {
  try {
    const type = c.req.query("type") || "all";
    const timeoutStr = c.req.query("timeout") || "15";
    const timeout = parseInt(timeoutStr, 10);

    const task = await autojsService.dispatchTask(
      "device.apps.list",
      { type },
      timeout,
    );

    return c.json({
      ok: true,
      message: "Apps package task dispatched successfully",
      data: {
        taskId: task.taskId,
        status: task.status,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[HTTP] Error creating apps list task:", error);
    return c.json({ ok: false, message, data: {} }, 500);
  }
}
