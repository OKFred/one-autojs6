import type { Context } from "hono";
import { AutojsService } from "../service/autojs.service.js";
import type { TrustedScriptId } from "../service/node-server.service.js";

const autojsService = AutojsService.getInstance();

const trustedScriptIds: TrustedScriptId[] = [
  "device.apps.list",
  "app.install",
  "app.version.check",
  "app.update.store",
  "app.update.zip",
  "file.download",
  "tiktok.post",
  "client.self-update",
];

/** 判断字符串是否为 PC 允许代理的可信脚本标识。 */
function isTrustedScriptId(value: string): value is TrustedScriptId {
  return trustedScriptIds.includes(value as TrustedScriptId);
}

/**
 * 下发手机端可信脚本任务。
 * 原始 JavaScript、Shell、kill 与动态监听配置不再受支持。
 */
export async function createTask(c: Context) {
  try {
    const body = await c.req.json<{
      scriptId?: string;
      params?: Record<string, unknown>;
      timeout?: number | string;
      clientId?: string;
    }>();
    if (!body.scriptId || !isTrustedScriptId(body.scriptId)) {
      return c.json(
        {
          ok: false,
          message:
            "A registered scriptId is required; remote source and shell tasks are disabled",
          data: {},
        },
        400,
      );
    }
    const timeout = Number.parseInt(String(body.timeout || "120"), 10);
    const task = await autojsService.dispatchTask(
      body.scriptId,
      body.params || {},
      timeout,
      body.clientId,
    );
    return c.json({
      ok: true,
      message: "Trusted task dispatched through Node Server",
      data: task,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[HTTP] Error creating trusted task:", error);
    return c.json({ ok: false, message, data: {} }, 500);
  }
}
