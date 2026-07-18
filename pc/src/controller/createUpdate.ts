import { Context } from 'hono';
import { TaskService } from '../service/task.service.js';
import { MqttService } from '../service/mqtt.service.js';

const taskService = TaskService.getInstance();

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
    const timeoutStr = c.req.query('timeout') || '30';
    const timeout = parseInt(timeoutStr, 10);

    const PORT = parseInt(process.env.PORT || '3000', 10);
    const PC_IP = process.env.PC_IP || '';

    // 创建 update 任务
    const updateCmd = 'git reset --hard HEAD && git pull';
    const task = taskService.createTask('update', updateCmd, timeout);

    const payload = {
      taskId: task.taskId,
      cat: 'update',
      script: updateCmd,
      timeout,
      callbackUrl: `http://${PC_IP}:${PORT}/api/callback`
    };

    MqttService.getInstance().publish('autojs6/tasks', payload);
    console.log(`[TaskController] Dispatched Self-Update task ${task.taskId} to mobile`);

    return c.json({
      ok: true,
      message: 'Mobile self-update task dispatched successfully',
      data: {
        taskId: task.taskId,
        status: task.status
      }
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating update task:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
