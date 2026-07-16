import { Context } from 'hono';
import { TaskService } from '../service/task.service.js';

const taskService = TaskService.getInstance();

/**
 * 接收移动端执行结果的回调。
 * 
 * @swagger
 * /api/callback:
 *   post:
 *     summary: 接收移动端的回调
 *     description: 移动端脚本/命令执行结束后，向此接口汇报执行结果（SUCCESS 或 FAILURE），PC端用以更新状态。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - taskId
 *               - status
 *             properties:
 *               taskId:
 *                 type: string
 *                 description: 任务 ID
 *               status:
 *                 type: string
 *                 description: 执行结果，SUCCESS 或 FAILURE
 *               message:
 *                 type: string
 *                 description: 执行返回数据或异常信息
 *     responses:
 *       200:
 *         description: 回调处理成功
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
 *       400:
 *         description: 请求参数不全
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
 *       404:
 *         description: 未找到任务
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
 *       500:
 *         description: 回调处理失败
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
export async function handleCallback(c: Context) {
  try {
    const body = await c.req.json<{ taskId?: string; status?: 'SUCCESS' | 'FAILURE'; message?: string }>();
    const { taskId, status, message } = body;

    if (!taskId || !status) {
      return c.json({ ok: false, message: 'taskId and status are required', data: {} }, 400);
    }

    const updated = taskService.updateTaskStatus(taskId, status, message);
    if (!updated) {
      const task = taskService.getTask(taskId);
      if (!task) {
        console.warn(`[HTTP] Received callback for missing or untracked task: ${taskId}`);
        return c.json({ ok: false, message: 'Task not found', data: {} }, 404);
      } else {
        console.log(`[HTTP] Task ${taskId} already in terminal state: ${task.status}. Callback ignored.`);
      }
    }

    return c.json({ ok: true, message: 'Callback processed successfully', data: {} });
  } catch (err: any) {
    console.error('[HTTP] Callback handle error:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
