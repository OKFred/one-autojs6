import { Context } from 'hono';
import { ShellService } from '../service/shell.service.js';

const shellService = ShellService.getInstance();

/**
 * 异步下发获取设备应用包名列表的任务。
 * 
 * @swagger
 * /api/apps/task:
 *   post:
 *     summary: 异步下发获取设备应用包名任务
 *     description: 异步下发 Shell 命令 `pm list packages` 获取应用包名，执行极其迅速，返回 taskId 供轮询。
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
export async function createAppsTask(c: Context) {
  try {
    const type = c.req.query('type') || 'all';
    const timeoutStr = c.req.query('timeout') || '15';
    const timeout = parseInt(timeoutStr, 10);

    let pmCmd = 'pm list packages';
    if (type === 'third') {
      pmCmd = 'pm list packages -3';
    } else if (type === 'system') {
      pmCmd = 'pm list packages -s';
    }

    const PORT = parseInt(process.env.PORT || '3000', 10);
    const PC_IP = process.env.PC_IP || '';

    const task = await shellService.dispatchTask(pmCmd, timeout, PC_IP, PORT, false);

    return c.json({
      ok: true,
      message: 'Apps package task dispatched successfully',
      data: {
        taskId: task.taskId,
        status: task.status
      }
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating apps list task:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
