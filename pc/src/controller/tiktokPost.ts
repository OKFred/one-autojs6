import { Context } from 'hono';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AutojsService } from '../service/autojs.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const autojsService = AutojsService.getInstance();

interface TikTokPostBody {
  title?: string;
  details?: string;
  titles?: string[];
  detailsPool?: string[];
  imagePath?: string;
  imagePaths?: string[];
  videoPath?: string;
  videoPaths?: string[];
  materialDir?: string;
  timeout?: number;
  minIntervalSeconds?: number;
  maxPostsPerDay?: number;
  linkOnly?: boolean;
  linkMaxAttempts?: number;
  linkRetrySeconds?: number;
}

/**
 * 读取可选 JSON 请求体，兼容旧版无请求体调用。
 *
 * @param c - Hono 路由上下文对象
 * @returns 解析后的 TikTok 发帖请求体
 */
async function readBody(c: Context): Promise<TikTokPostBody> {
  const rawBody = await c.req.text();
  if (!rawBody.trim()) return {};
  return JSON.parse(rawBody) as TikTokPostBody;
}

/**
 * 将查询字符串中的逗号分隔值转换为字符串数组。
 *
 * @param value - 查询参数原始值
 * @returns 去除空白和空项后的字符串数组
 */
function parseList(value?: string): string[] {
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * 读取并限制数值配置，避免异常参数导致脚本无限等待或风控失效。
 *
 * @param value - 待解析的值
 * @param fallback - 无效值时使用的默认值
 * @param min - 允许的最小值
 * @param max - 允许的最大值
 * @returns 限制在指定区间内的整数
 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * 异步下发“TikTok 自动发帖”任务。
 * 
 * @swagger
 * /api/tiktok/post:
 *   post:
 *     tags: [TikTok]
 *     summary: 异步下发 TikTok 自动发帖任务
 *     description: 异步下发执行 TikTok 发帖的 Auto.js 自动化脚本。支持素材池轮换、标题池、发布频率保护和结构化作品链接回传。
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
 *           default: 240
 *         description: 任务超时时间(秒)
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               details:
 *                 type: string
 *               titles:
 *                 type: array
 *                 items:
 *                   type: string
 *               detailsPool:
 *                 type: array
 *                 items:
 *                   type: string
 *               imagePath:
 *                 type: string
 *               imagePaths:
 *                 type: array
 *                 items:
 *                   type: string
 *               videoPath:
 *                 type: string
 *               videoPaths:
 *                 type: array
 *                 items:
 *                   type: string
 *               materialDir:
 *                 type: string
 *                 default: /sdcard/DCIM/Camera
 *               minIntervalSeconds:
 *                 type: integer
 *                 default: 900
 *               maxPostsPerDay:
 *                 type: integer
 *                 default: 10
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
    const body = await readBody(c);
    const title = body.title ?? c.req.query('title') ?? '';
    const details = body.details ?? c.req.query('details') ?? '';
    const titles = Array.isArray(body.titles) ? body.titles.filter((item) => typeof item === 'string' && item.trim()) : parseList(c.req.query('titles'));
    const detailsPool = Array.isArray(body.detailsPool) ? body.detailsPool.filter((item) => typeof item === 'string' && item.trim()) : parseList(c.req.query('detailsPool'));
    const imagePath = body.imagePath ?? c.req.query('imagePath') ?? '';
    const imagePaths = Array.isArray(body.imagePaths) ? body.imagePaths.filter((item) => typeof item === 'string' && item.trim()) : parseList(c.req.query('imagePaths'));
    const videoPath = body.videoPath ?? c.req.query('videoPath') ?? '';
    const videoPaths = Array.isArray(body.videoPaths) ? body.videoPaths.filter((item) => typeof item === 'string' && item.trim()) : parseList(c.req.query('videoPaths'));
    const materialDir = body.materialDir ?? c.req.query('materialDir') ?? '/sdcard/DCIM/Camera';
    const timeout = clampNumber(body.timeout ?? c.req.query('timeout'), 240, 120, 600);
    const minIntervalSeconds = clampNumber(body.minIntervalSeconds ?? c.req.query('minIntervalSeconds'), 900, 0, 86400);
    const maxPostsPerDay = clampNumber(body.maxPostsPerDay ?? c.req.query('maxPostsPerDay'), 10, 0, 100);
    const linkOnly = body.linkOnly === true || c.req.query('linkOnly') === 'true';
    const linkMaxAttempts = clampNumber(body.linkMaxAttempts ?? c.req.query('linkMaxAttempts'), 8, 1, 30);
    const linkRetrySeconds = clampNumber(body.linkRetrySeconds ?? c.req.query('linkRetrySeconds'), 15, 2, 60);

    if (!linkOnly && !title.trim() && !details.trim() && titles.length === 0 && detailsPool.length === 0) {
      return c.json({ ok: false, message: 'At least one title or details value is required', data: {} }, 400);
    }

    const request = {
      title,
      details,
      titles,
      detailsPool,
      imagePath,
      imagePaths,
      videoPath,
      videoPaths,
      materialDir,
      minIntervalSeconds,
      maxPostsPerDay,
      linkOnly,
      linkMaxAttempts,
      linkRetrySeconds
    };

    const templatePath = path.join(__dirname, '../scripts/tiktok_post_v2.js');
    let script = fs.readFileSync(templatePath, 'utf8');

    script = script.replace('{{requestJson}}', JSON.stringify(request));

    const task = await autojsService.dispatchTask(script, timeout);

    return c.json({
      ok: true,
      message: 'TikTok auto-post task dispatched successfully',
      data: {
        taskId: task.taskId,
        status: task.status,
        resultUrl: `/api/tasks/${task.taskId}`
      }
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating TikTok post task:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
