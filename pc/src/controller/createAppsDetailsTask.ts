import { Context } from 'hono';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AutojsService } from '../service/autojs.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const autojsService = AutojsService.getInstance();

/**
 * 异步下发获取设备应用详细信息任务。
 * 
 * @swagger
 * /api/apps/details-task:
 *   post:
 *     tags: [应用管理]
 *     summary: 异步下发获取设备应用详细信息任务
 *     description: 异步下发包含 PackageManager 反射的 AutoJS 脚本，获取全面包详情 JSON 字符串，返回 taskId 供轮询。
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
export async function createAppsDetailsTask(c: Context) {
  try {
    const timeoutStr = c.req.query('timeout') || '30';
    const timeout = parseInt(timeoutStr, 10);

    const scriptPath = path.join(__dirname, '../scripts/get_apps_details.js');
    const script = fs.readFileSync(scriptPath, 'utf8');

    const PORT = parseInt(process.env.PORT || '3000', 10);
    const PC_IP = process.env.PC_IP || '';

    const task = await autojsService.dispatchTask(script, timeout, PC_IP, PORT);

    return c.json({
      ok: true,
      message: 'Apps details task dispatched successfully',
      data: {
        taskId: task.taskId,
        status: task.status
      }
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating apps details task:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
