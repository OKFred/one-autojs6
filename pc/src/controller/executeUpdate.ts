import { Context } from 'hono';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AutojsService } from '../service/autojs.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const autojsService = AutojsService.getInstance();

/**
 * 异步下发“执行宿主应用远程更新”任务。
 * 
 * @swagger
 * /api/apps/execute-update:
 *   post:
 *     tags: [应用更新]
 *     summary: 异步下发执行应用更新任务
 *     description: 异步下发执行 App 更新的 Auto.js 自动化脚本。支持 mode=download（直接下载 APK 并唤起安装）以及 mode=store（拉起应用商店通过无障碍自动寻找并点击更新按钮）。返回 taskId 供轮询。
 *     parameters:
 *       - in: query
 *         name: packageName
 *         schema:
 *           type: string
 *           default: org.autojs.autojs6
 *         description: 要更新的应用包名
 *       - in: query
 *         name: mode
 *         required: true
 *         schema:
 *           type: string
 *           enum: [download, store, zip]
 *         description: 更新模式：download(直接下载APK包安装)、store(跳转应用商店无障碍点击更新)、zip(下载ZIP包并自动双重策略解压安装)
 *       - in: query
 *         name: downloadUrl
 *         schema:
 *           type: string
 *         description: APK 下载链接 (当 mode=download 时必填)
 *       - in: query
 *         name: storePackage
 *         schema:
 *           type: string
 *         description: 目标应用商店的包名 (当 mode=store 时可选，如 Google Play "com.android.vending")
 *       - in: query
 *         name: timeout
 *         schema:
 *           type: integer
 *           default: 120
 *         description: 任务超时时间(秒，下载大文件或在商店等待时建议长超时)
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
 *         description: 参数请求错误
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
export async function executeUpdate(c: Context) {
  try {
    const packageName = c.req.query('packageName') || 'org.autojs.autojs6';
    const mode = c.req.query('mode') || '';
    const downloadUrl = c.req.query('downloadUrl') || '';
    const storePackage = c.req.query('storePackage') || '';
    const timeoutStr = c.req.query('timeout') || '120';
    const timeout = parseInt(timeoutStr, 10);

    if (mode !== 'download' && mode !== 'store' && mode !== 'zip') {
      return c.json({ ok: false, message: 'mode must be "download", "store", or "zip"', data: {} }, 400);
    }

    if ((mode === 'download' || mode === 'zip') && !downloadUrl) {
      return c.json({ ok: false, message: 'downloadUrl is required when mode is "download" or "zip"', data: {} }, 400);
    }

    const PORT = parseInt(process.env.PORT || '3000', 10);
    const PC_IP = process.env.PC_IP || '';

    let script = '';

    if (mode === 'zip') {
      const templatePath = path.join(__dirname, '../scripts/execute_update_zip.js');
      script = fs.readFileSync(templatePath, 'utf8').replace('{{downloadUrl}}', downloadUrl);
    } else if (mode === 'download') {
      const templatePath = path.join(__dirname, '../scripts/execute_update_download.js');
      script = fs.readFileSync(templatePath, 'utf8').replace('{{downloadUrl}}', downloadUrl);
    } else {
      const templatePath = path.join(__dirname, '../scripts/execute_update_store.js');
      script = fs.readFileSync(templatePath, 'utf8')
        .replace('{{packageName}}', packageName)
        .replace('{{storePackage}}', storePackage);
    }

    const task = await autojsService.dispatchTask(script, timeout, PC_IP, PORT);

    return c.json({
      ok: true,
      message: 'App execute update task dispatched successfully',
      data: {
        taskId: task.taskId,
        status: task.status
      }
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating execute update task:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
