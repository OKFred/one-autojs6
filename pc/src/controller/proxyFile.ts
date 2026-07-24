import { Context } from 'hono';
import SMB2 from '@marsaud/smb2';
import { Readable } from 'stream';

/**
 * 代理下载接口 (主要供手机 Auto.js 获取 PC 端的局域网文件或受限资源)
 *
 * @swagger
 * /api/proxy:
 *   get:
 *     tags: [文件传输]
 *     summary: 内部代理下载文件接口
 *     description: 提供给手机端调用的内部接口，用于拉取 SMB 等手机端无法直接访问的资源。
 *     parameters:
 *       - in: query
 *         name: url
 *         schema:
 *           type: string
 *         required: true
 *         description: 源文件地址，例如 smb://192.168.1.4/shareName/path/to/file.ext
 *     responses:
 *       200:
 *         description: 文件流
 */
export async function proxyFile(c: Context) {
  const urlStr = c.req.query('url');

  if (!urlStr) {
    return c.json({ ok: false, message: 'Missing url parameter' }, 400);
  }

  try {
    if (urlStr.startsWith('smb://')) {
      // 简单解析 smb://192.168.1.4/shareName/path/to/file.txt
      // URL 对象会把 192.168.1.4 当做 host, /shareName/path/to/file.txt 当做 pathname
      const urlObj = new URL(urlStr);
      const host = urlObj.hostname;
      
      const pathParts = decodeURIComponent(urlObj.pathname).split('/').filter(Boolean);
      if (pathParts.length < 2) {
        throw new Error('Invalid SMB url format. Expected smb://host/shareName/path...');
      }

      const shareName = pathParts[0];
      const filePath = pathParts.slice(1).join('\\'); // SMB 使用反斜杠

      // @ts-ignore
      const smb2Client = new SMB2({
        share: `\\\\${host}\\${shareName}`,
        domain: '',
        username: 'smb',       // 硬编码满足当前需求，或可通过参数传入
        password: 'smb123',
        autoCloseTimeout: 0
      });

      return new Promise<Response>((resolve, reject) => {
        smb2Client.createReadStream(filePath, (err: Error, readStream: Readable) => {
          if (err) {
            console.error('[SMB] Read stream error:', err);
            reject(err);
            return;
          }

          // 将 Node 的 Readable Stream 转换为 Web Stream
          const webStream = Readable.toWeb(readStream) as ReadableStream;
          
          // 返回文件流
          resolve(new Response(webStream, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${pathParts[pathParts.length - 1]}"`
            }
          }));
        });
      });
    }

    return c.json({ ok: false, message: 'Unsupported protocol for proxy' }, 400);

  } catch (err: any) {
    console.error('[Proxy] Error:', err);
    return c.json({ ok: false, message: err.message }, 500);
  }
}
