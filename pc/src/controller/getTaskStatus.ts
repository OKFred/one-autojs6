import { Context } from "hono";
import { NodeServerService } from "../service/node-server.service.js";

const nodeServer = NodeServerService.getInstance();

/**
 * 根据任务 ID 查询单个任务的状态和执行返回值。
 *
 * @swagger
 * /api/tasks/{taskId}:
 *   get:
 *     tags: [任务管理]
 *     summary: 查询单个任务状态
 *     description: 获取指定任务当前的执行状态(EXECUTING/SUCCESS/FAILURE)，若是SUCCESS，则可在 message 中提取出返回负载。
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *         description: 任务 ID
 *     responses:
 *       200:
 *         description: 查询成功
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
 *                     task:
 *                       type: object
 *                     result:
 *                       type: object
 *
 * @param c - Hono 路由上下文对象
 * @returns Hono JSON 响应
 */
export async function getTaskStatus(c: Context) {
  const taskId = c.req.param("taskId") || "";
  try {
    const task = await nodeServer.getTask(taskId);
    let result: unknown = null;
    if (task.resultDataJson) {
      try {
        result = JSON.parse(task.resultDataJson) as unknown;
      } catch {
        result = task.resultDataJson;
      }
    }
    return c.json({
      ok: true,
      message: "Retrieve task status successfully",
      data: { task, result },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, message, data: { taskId } }, 502);
  }
}
