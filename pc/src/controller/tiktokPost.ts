import type { Context } from "hono";
import { AutojsService } from "../service/autojs.service.js";
import {
  normalizeTikTokRequest,
  TikTokContractError,
  type TikTokLegacyQuery,
} from "../tiktok-contract.js";

const autojsService = AutojsService.getInstance();

/**
 * 读取可选 JSON 请求体，兼容旧版无请求体调用。
 *
 * @param c Hono 路由上下文。
 * @returns 解析后的未知 JSON 值；空请求体返回 undefined。
 */
async function readBody(c: Context): Promise<unknown> {
  const rawBody = await c.req.text();
  if (!rawBody.trim()) return undefined;
  return JSON.parse(rawBody) as unknown;
}

/**
 * 读取仍受支持的旧版查询参数。
 *
 * @param c Hono 路由上下文。
 * @returns 旧版字段映射。
 */
function readLegacyQuery(c: Context): TikTokLegacyQuery {
  return {
    title: c.req.query("title"),
    details: c.req.query("details"),
    titles: c.req.query("titles"),
    detailsPool: c.req.query("detailsPool"),
    imagePath: c.req.query("imagePath"),
    imagePaths: c.req.query("imagePaths"),
    videoPath: c.req.query("videoPath"),
    videoPaths: c.req.query("videoPaths"),
    materialDir: c.req.query("materialDir"),
    publicationId: c.req.query("publicationId"),
    expectedHandle: c.req.query("expectedHandle"),
    timeout: c.req.query("timeout"),
    minIntervalSeconds: c.req.query("minIntervalSeconds"),
    maxPostsPerDay: c.req.query("maxPostsPerDay"),
    linkOnly: c.req.query("linkOnly"),
    linkMaxAttempts: c.req.query("linkMaxAttempts"),
    linkRetrySeconds: c.req.query("linkRetrySeconds"),
  };
}

/**
 * 异步下发 TikTok v2 预检、发布、补链或状态查询任务。
 *
 * @swagger
 * /api/tiktok/post:
 *   post:
 *     tags: [TikTok]
 *     summary: 异步下发 TikTok v2 任务
 *     description: >-
 *       使用固定可信脚本 tiktok.post（scriptVersion=1）执行预检、单素材发布、
 *       按 publicationId 补链或状态查询。publish 未提供 publicationId 时由 PC 生成 UUID；
 *       recover/status 必须复用原 UUID。响应仅表示任务已异步受理，调用方应轮询 resultUrl。
 *       兼容旧版扁平发布字段；旧 linkOnly=true 必须同时提供 publicationId。
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contractVersion, action]
 *             properties:
 *               contractVersion:
 *                 type: integer
 *                 enum: [2]
 *               action:
 *                 type: string
 *                 enum: [publish, preflight, recover, status]
 *                 default: publish
 *               publicationId:
 *                 type: string
 *                 format: uuid
 *                 description: publish 可省略并由 PC 生成；recover/status 必填
 *               expectedHandle:
 *                 type: string
 *                 description: 可选账号二次断言；手机本机配置仍是权威账号
 *                 example: creator_account
 *               media:
 *                 type: object
 *                 description: publish 必填；preflight 可选
 *                 required: [mode, kind]
 *                 properties:
 *                   mode:
 *                     type: string
 *                     enum: [direct, pool]
 *                   kind:
 *                     type: string
 *                     enum: [image, video, auto]
 *                     description: direct 不接受 auto
 *                   path:
 *                     type: string
 *                     description: direct 模式的手机绝对路径
 *                     example: /sdcard/Download/tiktok-materials/example.mp4
 *                   paths:
 *                     type: array
 *                     maxItems: 20
 *                     items:
 *                       type: string
 *                     description: pool 模式的候选绝对路径；与 directory 二选一
 *                   directory:
 *                     type: string
 *                     description: pool 模式的候选目录；与 paths 二选一
 *               content:
 *                 type: object
 *                 properties:
 *                   title:
 *                     type: string
 *                     maxLength: 90
 *                   details:
 *                     type: string
 *                     maxLength: 4000
 *                   titles:
 *                     type: array
 *                     maxItems: 20
 *                     items:
 *                       type: string
 *                       maxLength: 90
 *                   detailsPool:
 *                     type: array
 *                     maxItems: 20
 *                     items:
 *                       type: string
 *                       maxLength: 4000
 *               policy:
 *                 type: object
 *                 description: 手机端策略为上限约束，请求不能放宽本机安全配置
 *                 properties:
 *                   minIntervalSeconds:
 *                     type: integer
 *                     minimum: 1
 *                     maximum: 86400
 *                     default: 1800
 *                   maxPostsPerDay:
 *                     type: integer
 *                     minimum: 1
 *                     maximum: 100
 *                     default: 3
 *                   materialReuseSeconds:
 *                     type: integer
 *                     minimum: 0
 *                     maximum: 2592000
 *                     default: 86400
 *                   captionReuseSeconds:
 *                     type: integer
 *                     minimum: 0
 *                     maximum: 2592000
 *                     default: 86400
 *               link:
 *                 type: object
 *                 properties:
 *                   maxAttempts:
 *                     type: integer
 *                     minimum: 1
 *                     maximum: 20
 *                     default: 8
 *                   retrySeconds:
 *                     type: integer
 *                     minimum: 2
 *                     maximum: 60
 *                     default: 15
 *               timeout:
 *                 type: integer
 *                 minimum: 120
 *                 maximum: 600
 *                 default: 420
 *           examples:
 *             publishVideo:
 *               summary: 发布单个视频
 *               value:
 *                 contractVersion: 2
 *                 action: publish
 *                 media:
 *                   mode: direct
 *                   kind: video
 *                   path: /sdcard/Download/tiktok-materials/example.mp4
 *                 content:
 *                   title: Evening walk
 *                   details: A quiet moment from today.
 *                 policy:
 *                   minIntervalSeconds: 1800
 *                   maxPostsPerDay: 3
 *                   materialReuseSeconds: 86400
 *                   captionReuseSeconds: 86400
 *                 link:
 *                   maxAttempts: 8
 *                   retrySeconds: 15
 *                 timeout: 420
 *             recoverLink:
 *               summary: 对已提交作品补链
 *               value:
 *                 contractVersion: 2
 *                 action: recover
 *                 publicationId: 8fa04e65-0c0c-46ca-bdb2-00bd21e53c28
 *                 link:
 *                   maxAttempts: 8
 *                   retrySeconds: 15
 *     responses:
 *       200:
 *         description: 任务已异步受理
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [ok, message, data]
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   required: [taskId, status, resultUrl, contractVersion, action, publicationId]
 *                   properties:
 *                     taskId:
 *                       type: string
 *                     status:
 *                       type: string
 *                       enum: [PENDING, EXECUTING]
 *                     resultUrl:
 *                       type: string
 *                     contractVersion:
 *                       type: integer
 *                       enum: [2]
 *                     action:
 *                       type: string
 *                       enum: [publish, preflight, recover, status]
 *                     publicationId:
 *                       type: string
 *                       format: uuid
 *       400:
 *         description: JSON 或 TikTok 契约校验失败
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [ok, message, data]
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *       401:
 *         description: Bearer Token 缺失或错误
 *       502:
 *         description: Node Server 或 MQTT 任务分发失败
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [ok, message, data]
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *
 * @param c Hono 路由上下文。
 * @returns 统一响应信封中的异步任务受理结果。
 */
export async function tiktokPost(c: Context) {
  let normalized;
  try {
    normalized = normalizeTikTokRequest(await readBody(c), readLegacyQuery(c));
  } catch (error) {
    const message =
      error instanceof SyntaxError
        ? "request body must contain valid JSON"
        : error instanceof TikTokContractError
          ? error.message
          : "invalid TikTok request";
    return c.json({ ok: false, message, data: {} }, 400);
  }

  try {
    const task = await autojsService.dispatchTask(
      "tiktok.post",
      normalized.params,
      normalized.timeoutSeconds,
    );
    return c.json({
      ok: true,
      message: "TikTok task dispatched successfully",
      data: {
        taskId: task.taskId,
        status: task.status,
        resultUrl: `/api/tasks/${task.taskId}`,
        contractVersion: normalized.params.contractVersion,
        action: normalized.params.action,
        publicationId: normalized.params.publicationId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[HTTP] TikTok task dispatch failed");
    return c.json({ ok: false, message, data: {} }, 502);
  }
}
