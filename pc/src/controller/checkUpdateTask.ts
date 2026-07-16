import { Context } from 'hono';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AutojsService } from '../service/autojs.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const autojsService = AutojsService.getInstance();

/**
 * 异步下发“检查宿主应用更新”任务。
 * 
 * @swagger
 * /api/apps/check-update-task:
 *   post:
 *     summary: 异步下发检查应用更新任务
 *     description: 异步下发包含 PackageManager 的 AutoJS 脚本，获取移动端对应包名的本地安装版本，对比最新版本并回调结果，返回 taskId 供轮询。
 *     parameters:
 *       - in: query
 *         name: packageName
 *         schema:
 *           type: string
 *           default: org.autojs.autojs6
 *         description: 要检查的应用包名
 *       - in: query
 *         name: latestVersion
 *         schema:
 *           type: string
 *         description: 最新版本号名称（如 6.4.0）
 *       - in: query
 *         name: latestVersionCode
 *         schema:
 *           type: integer
 *         description: 最新版本号代码（如 60400）
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
 *         description: 任务下发失败
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
export async function checkUpdateTask(c: Context) {
  try {
    const packageName = c.req.query('packageName') || 'org.autojs.autojs6';
    const latestVersion = c.req.query('latestVersion') || '';
    const latestVersionCode = c.req.query('latestVersionCode') || '';
    const timeoutStr = c.req.query('timeout') || '15';
    const timeout = parseInt(timeoutStr, 10);

    const PORT = parseInt(process.env.PORT || '3000', 10);
    const PC_IP = process.env.PC_IP || '';

    // 读取并渲染外部脚本模板
    const templatePath = path.join(__dirname, '../scripts/check_app_update.js');
    let script = fs.readFileSync(templatePath, 'utf8');
    script = script
      .replace('{{packageName}}', packageName)
      .replace('{{latestVersion}}', latestVersion)
      .replace('{{latestVersionCode}}', latestVersionCode);

    const task = await autojsService.dispatchTask(script, timeout, PC_IP, PORT);

    return c.json({
      ok: true,
      message: 'App check update task dispatched successfully',
      data: {
        taskId: task.taskId,
        status: task.status
      }
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating check update task:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
