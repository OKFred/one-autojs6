import { Context } from 'hono';
import { TaskService } from '../service/task.service.js';

const taskService = TaskService.getInstance();

/**
 * 获取系统内存中的所有任务列表。
 * 
 * @swagger
 * /api/tasks:
 *   get:
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
export function getAllTasks(c: Context) {
  return c.json({
    ok: true,
    message: 'Retrieve all tasks successfully',
    data: {
      tasks: taskService.getAllTasks()
    }
  });
}
