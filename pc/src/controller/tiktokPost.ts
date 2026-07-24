import { Context } from 'hono';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AutojsService } from '../service/autojs.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const autojsService = AutojsService.getInstance();

/**
 * 异步下发“TikTok 自动发帖”任务。
 * 
 * @swagger
 * /api/tiktok/post:
 *   post:
 *     tags: [TikTok]
 *     summary: 异步下发 TikTok 自动发帖任务
 *     description: 异步下发执行 TikTok 发帖的 Auto.js 自动化脚本。默认选取相册第一张图片。
 *     parameters:
 *       - in: query
 *         name: title
 *         schema:
 *           type: string
 *         description: 帖子标题
 *       - in: query
 *         name: details
 *         schema:
 *           type: string
 *         description: 帖子详情/描述
 *       - in: query
 *         name: timeout
 *         schema:
 *           type: integer
 *           default: 120
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
export async function tiktokPost(c: Context) {
  try {
    const title = c.req.query('title') || 'nice blouse';
    const details = c.req.query('details') || 'looking good';
    const imagePath = c.req.query('imagePath') || '';
    const timeoutStr = c.req.query('timeout') || '120';
    const timeout = parseInt(timeoutStr, 10);

    const PORT = parseInt(process.env.PORT || '3000', 10);
    const PC_IP = process.env.PC_IP || '';

    const templatePath = path.join(__dirname, '../scripts/tiktok_post.js');
    let script = fs.readFileSync(templatePath, 'utf8');
    
    // 注入变量
    script = script
      .replace('{{title}}', title)
      .replace('{{details}}', details)
      .replace('{{imagePath}}', imagePath);

    const task = await autojsService.dispatchTask(script, timeout, PC_IP, PORT);

    return c.json({
      ok: true,
      message: 'TikTok auto-post task dispatched successfully',
      data: {
        taskId: task.taskId,
        status: task.status
      }
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating TikTok post task:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
