import { Context } from "hono";
import { NodeServerService } from "../service/node-server.service.js";

const nodeServer = NodeServerService.getInstance();

/**
 * 获取系统内存中的所有任务列表。
 *
 * @swagger
 * /api/tasks:
 *   get:
 *     tags: [任务管理]
 *     summary: 获取所有任务列表
 *     description: 查询系统中所有在内存中被追踪的任务信息。
 *     responses:
 *       200:
 *         description: 获取成功
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
 *                     tasks:
 *                       type: array
 *                       items:
 *                         type: object
 *
 * @param c - Hono 路由上下文对象
 * @returns Hono JSON 响应
 */
export async function getAllTasks(c: Context) {
  try {
    const result = await nodeServer.listTasks(c.req.query("clientId"));
    return c.json({
      ok: true,
      message: "Retrieve all tasks successfully",
      data: { tasks: result.list, total: result.total },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, message, data: { tasks: [] } }, 502);
  }
}
