import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseNetworkRoutingPolicy } from "./network-routing.js";

/** 手机本地可信脚本定义。 */
export interface RegisteredTaskScript {
  scriptId: string;
  kind: "autojs" | "client";
  fileName?: string;
  version: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}

const REGISTRY: readonly RegisteredTaskScript[] = [
  {
    scriptId: "device.apps.list",
    kind: "autojs",
    fileName: "device_apps_list.js",
    version: 1,
    defaultTimeoutMs: 120000,
    maxTimeoutMs: 300000,
  },
  {
    scriptId: "app.install",
    kind: "autojs",
    fileName: "app_install.js",
    version: 1,
    defaultTimeoutMs: 300000,
    maxTimeoutMs: 900000,
  },
  {
    scriptId: "app.version.check",
    kind: "autojs",
    fileName: "app_version_check.js",
    version: 1,
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 120_000,
  },
  {
    scriptId: "app.update.store",
    kind: "autojs",
    fileName: "app_update_store.js",
    version: 1,
    defaultTimeoutMs: 120_000,
    maxTimeoutMs: 300_000,
  },
  {
    scriptId: "app.update.zip",
    kind: "autojs",
    fileName: "app_update_zip.js",
    version: 1,
    defaultTimeoutMs: 600_000,
    maxTimeoutMs: 900_000,
  },
  {
    scriptId: "file.download",
    kind: "autojs",
    fileName: "file_download.js",
    version: 1,
    defaultTimeoutMs: 300_000,
    maxTimeoutMs: 900_000,
  },
  {
    scriptId: "tiktok.post",
    kind: "autojs",
    fileName: "tiktok_post_v2.js",
    version: 1,
    defaultTimeoutMs: 420000,
    maxTimeoutMs: 900000,
  },
  {
    scriptId: "device.network.switch",
    kind: "autojs",
    fileName: "device_network_switch.js",
    version: 1,
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 150_000,
  },
  {
    scriptId: "device.network.routing.apply",
    kind: "client",
    version: 1,
    defaultTimeoutMs: 120_000,
    maxTimeoutMs: 300_000,
  },
  {
    scriptId: "device.network.routing.disable",
    kind: "client",
    version: 1,
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 120_000,
  },
];

/** 获取全部本地可信脚本的只读元数据。 */
export function listRegisteredScripts(): readonly RegisteredTaskScript[] {
  return REGISTRY;
}

/**
 * 按标识获取本地可信脚本定义。
 *
 * @param scriptId 服务端下发的脚本标识。
 */
export function getRegisteredScript(
  scriptId: string,
): RegisteredTaskScript | undefined {
  return REGISTRY.find((item) => item.scriptId === scriptId);
}

/**
 * 校验需要在最终执行端再次约束的脚本参数。
 *
 * @returns 合法时返回 null，否则返回稳定的错误说明。
 */
export function validateRegisteredTaskParams(
  scriptId: string,
  params: Record<string, unknown>,
  taskTimeoutMs?: number,
): string | null {
  if (scriptId === "device.network.routing.apply") {
    try {
      parseNetworkRoutingPolicy(params);
      return null;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Invalid network routing policy";
    }
  }
  if (scriptId === "device.network.routing.disable") {
    return Number.isInteger(params.generation) && Number(params.generation) >= 1
      ? null
      : "generation must be a positive integer";
  }
  if (scriptId !== "device.network.switch") return null;
  const target = String(
    params.target ?? params.network ?? "wifi",
  ).toLowerCase();
  if (
    !["wifi", "ethernet", "carrier", "cellular", "mobile", "data"].includes(
      target,
    )
  ) {
    return "Network target must be wifi, ethernet or carrier";
  }
  if (params.timeoutMs !== undefined) {
    if (
      typeof params.timeoutMs !== "number" ||
      !Number.isFinite(params.timeoutMs) ||
      params.timeoutMs < 1_000 ||
      params.timeoutMs > 120_000
    ) {
      return "Network detection timeoutMs must be between 1000 and 120000";
    }
  }
  const detectionTimeoutMs =
    typeof params.timeoutMs === "number" ? params.timeoutMs : 20_000;
  if (
    taskTimeoutMs !== undefined &&
    taskTimeoutMs < detectionTimeoutMs + 15_000
  ) {
    return "Network task timeout must reserve 15000ms for restore and result delivery";
  }
  return null;
}

/**
 * 从手机客户端部署目录读取脚本正文。
 *
 * @param definition 已注册脚本定义。
 */
export function readRegisteredScript(definition: RegisteredTaskScript): string {
  if (definition.kind !== "autojs" || !definition.fileName) {
    throw new Error(`Task ${definition.scriptId} is not an AutoJS script`);
  }
  const currentFile = fileURLToPath(import.meta.url);
  const mobileRoot = path.resolve(path.dirname(currentFile), "..");
  const candidates = [
    path.join(mobileRoot, "task-scripts", definition.fileName),
    path.join(path.dirname(currentFile), "task-scripts", definition.fileName),
  ];
  const scriptPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!scriptPath) {
    throw new Error(`Trusted script file is missing: ${definition.fileName}`);
  }
  return fs.readFileSync(scriptPath, "utf8");
}
