import { Context } from 'hono';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AutojsService } from '../service/autojs.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const autojsService = AutojsService.getInstance();

/**
 * 异步下发“手机通用下载与传文件”任务。
 * 
 * @swagger
 * /api/files/download:
 *   post:
 *     tags: [文件传输]
 *     summary: 异步下发文件下载任务
 *     description: 支持 HTTP(S), OSS(带签名的直链), 以及 SMB 协议。如果是 SMB，PC 后端将代理抓取该文件，然后把代理链接发给手机端。
 *     parameters:
 *       - in: query
 *         name: url
 *         schema:
 *           type: string
 *         required: true
 *         description: 文件源地址 (如 http://... 或 smb://192.168.1.4/share/path.jpg)
 *       - in: query
 *         name: protocol
 *         schema:
 *           type: string
 *           enum: [http, https, smb, oss]
 *           default: http
 *         description: 协议类型
 *       - in: query
 *         name: fileName
 *         schema:
 *           type: string
 *         description: 保存的文件名(如未指定则尝试从 url 解析)
 *       - in: query
 *         name: targetPath
 *         schema:
 *           type: string
 *         description: 手机端保存绝对路径 (默认为 /sdcard/Download/)
 *       - in: query
 *         name: timeout
 *         schema:
 *           type: integer
 *           default: 120
 *         description: 任务超时时间(秒)
 *     responses:
 *       200:
 *         description: 任务下发成功
 */
export async function downloadFile(c: Context) {
  try {
    const rawUrl = c.req.query('url');
    if (!rawUrl) {
      return c.json({ ok: false, message: 'URL is required', data: {} }, 400);
    }
    
    const protocol = c.req.query('protocol') || 'http';
    let fileName = c.req.query('fileName') || '';
    
    if (!fileName) {
      try {
        const u = new URL(rawUrl);
        const parts = u.pathname.split('/');
        fileName = parts[parts.length - 1] || 'downloaded_file.bin';
      } catch (e) {
        fileName = 'downloaded_file.bin';
      }
    }

    const defaultDir = '/sdcard/Download/';
    let targetPath = c.req.query('targetPath') || '';
    if (!targetPath) {
      targetPath = path.posix.join(defaultDir, fileName);
    } else if (targetPath.endsWith('/')) {
      targetPath = path.posix.join(targetPath, fileName);
    }

    const timeoutStr = c.req.query('timeout') || '120';
    const timeout = parseInt(timeoutStr, 10);

    const PORT = parseInt(process.env.PORT || '3000', 10);
    const PC_IP = process.env.PC_IP || '';

    // 判断如果协议是 smb，转换直链为 PC 端的代理链接
    let finalDownloadUrl = rawUrl;
    if (protocol === 'smb' || rawUrl.startsWith('smb://')) {
      finalDownloadUrl = `http://${PC_IP}:${PORT}/api/proxy?url=${encodeURIComponent(rawUrl)}`;
    }

    const templatePath = path.join(__dirname, '../scripts/download_file.js');
    let script = fs.readFileSync(templatePath, 'utf8');
    
    // 注入变量
    script = script
      .replace('{{downloadUrl}}', finalDownloadUrl)
      .replace('{{targetPath}}', targetPath);

    const task = await autojsService.dispatchTask(script, timeout, PC_IP, PORT);

    return c.json({
      ok: true,
      message: 'File download task dispatched successfully',
      data: {
        taskId: task.taskId,
        status: task.status,
        targetPath
      }
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating download task:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
