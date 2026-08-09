import { Context } from "hono";
import { AutojsService } from "../service/autojs.service.js";

const autojsService = AutojsService.getInstance();

/**
 * 下发移动端自更新与重启任务。
 *
 * @swagger
 * /api/devices/update:
 *   post:
 *     tags: [设备管理]
 *     summary: 下发移动端自更新任务
 *     description: 下发 `cat = update` 的任务，移动端在 Termux 本地执行 `git reset --hard HEAD && git pull`，成功后回传结果并平滑自重启，返回 taskId 供轮询。
 *     parameters:
 *       - in: query
 *         name: timeout
 *         schema:
 *           type: integer
 *           default: 30
 *         description: 任务超时时间(秒)
 *     responses:
 *       200:
 *         description: 下发成功
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
 *         description: 下发失败
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
export async function createUpdate(c: Context) {
  try {
    const timeoutStr = c.req.query("timeout") || "30";
    const timeout = parseInt(timeoutStr, 10);

    const task = await autojsService.dispatchTask(
      "client.self-update",
      {},
      timeout,
    );

    return c.json({
      ok: true,
      message: "Mobile self-update task dispatched successfully",
      data: {
        taskId: task.taskId,
        status: task.status,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[HTTP] Error creating update task:", error);
    return c.json({ ok: false, message, data: {} }, 500);
  }
}
