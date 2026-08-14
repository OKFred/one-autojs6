import type { Context } from "hono";

/**
 * 返回旧 Git 自更新接口的明确弃用结果。
 *
 * @swagger
 * /api/devices/update:
 *   post:
 *     deprecated: true
 *     tags: [设备管理]
 *     summary: 已弃用的客户端 Git 自更新
 *     responses:
 *       410:
 *         description: 请改用不可变客户端部署接口
 *
 * @param c Hono 路由上下文。
 * @returns 统一弃用响应。
 */
export async function createUpdate(c: Context) {
  return c.json(
    {
      ok: false,
      message:
        "Legacy git-based self-update is disabled; use /api/devices/deployments",
      data: {},
    },
    410,
  );
}
