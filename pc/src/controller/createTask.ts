import { Context } from 'hono';
import { AutojsService } from '../service/autojs.service.js';
import { ShellService } from '../service/shell.service.js';

const autojsService = AutojsService.getInstance();
const shellService = ShellService.getInstance();

/**
 * 下发通用任务 (支持 AutoJS6 脚本与本地 Shell 命令)。
 * 
 * @swagger
 * /api/tasks:
 *   post:
 *     tags: [通用任务]
 *     summary: 下发通用任务
 *     description: 立即在内存中创建任务，并根据分类 (cat) 通过 MQTT 发送执行载荷。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - script
 *             properties:
 *               cat:
 *                 type: string
 *                 description: 任务类型，支持 autojs6 或 shell
 *                 default: autojs6
 *               script:
 *                 type: string
 *                 description: 要执行的 Auto.js 脚本或 Shell 命令
 *               timeout:
 *                 type: integer
 *                 description: 任务超时时间(秒)
 *                 default: 30
 *               useRoot:
 *                 type: boolean
 *                 description: 是否以 Root 权限执行 (仅在 cat=shell 时有效)
 *                 default: false
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
 *       400:
 *         description: 请求参数错误
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
 *         description: 服务器内部异常
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
export async function createTask(c: Context) {
  try {
    const body = await c.req.json<{
      cat?: 'autojs6' | 'shell';
      script?: string;
      timeout?: number | string;
      useRoot?: boolean;
    }>();
    const { cat = 'autojs6', script, timeout, useRoot = false } = body;

    if (!script) {
      return c.json({ ok: false, message: 'script is required', data: {} }, 400);
    }

    const taskTimeout = parseInt(String(timeout || '30'), 10);
    const PORT = parseInt(process.env.PORT || '3000', 10);
    const PC_IP = process.env.PC_IP || '';

    let task;
    if (cat === 'shell') {
      task = await shellService.dispatchTask(script, taskTimeout, PC_IP, PORT, useRoot);
    } else {
      task = await autojsService.dispatchTask(script, taskTimeout, PC_IP, PORT);
    }

    return c.json({
      ok: true,
      message: 'Task dispatched successfully',
      data: {
        taskId: task.taskId,
        status: task.status
      }
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating task:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
