import { timingSafeEqual } from "crypto";
import type { MiddlewareHandler } from "hono";

/** 使用恒定时间比较两个 UTF-8 令牌。 */
function safeTokenEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

/** 校验一个明文令牌是否匹配当前 PC API 令牌。 */
export function isValidApiToken(actualToken: string): boolean {
  const expectedToken = String(process.env.ONE_AUTOJS6_API_TOKEN || "");
  return (
    expectedToken.length >= 16 && safeTokenEquals(actualToken, expectedToken)
  );
}

/** 创建 PC 控制与任务查询接口的 Bearer Token 认证中间件。 */
export function createApiAuthMiddleware(): MiddlewareHandler {
  const expectedToken = String(process.env.ONE_AUTOJS6_API_TOKEN || "");
  if (expectedToken.length < 16) {
    throw new Error(
      "ONE_AUTOJS6_API_TOKEN is required and must contain at least 16 characters",
    );
  }
  return async (context, next) => {
    if (
      context.req.path === "/api/config" ||
      context.req.path === "/api-spec"
    ) {
      await next();
      return;
    }
    const authorization = context.req.header("authorization") || "";
    const actualToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (!isValidApiToken(actualToken)) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json(
        { ok: false, message: "Unauthorized", data: {} },
        401,
      );
    }
    await next();
  };
}
