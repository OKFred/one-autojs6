import { Context } from 'hono';
import { TaskService } from '../service/task.service.js';

const taskService = TaskService.getInstance();

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
 * 
 * @param c - Hono 路由上下文对象
 * @returns Hono JSON 响应
 */
export function getTaskStatus(c: Context) {
  const taskId = c.req.param('taskId') || '';
  const task = taskService.getTask(taskId);

  if (!task) {
    return c.json({
      ok: true,
      message: 'Task not found in system',
      data: {
        taskId,
        status: 'MISSING'
      }
    });
  }

  return c.json({
    ok: true,
    message: 'Retrieve task status successfully',
    data: {
      task
    }
  });
}
