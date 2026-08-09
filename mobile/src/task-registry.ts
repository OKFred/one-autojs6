import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
    scriptId: "client.self-update",
    kind: "client",
    version: 1,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 60_000,
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
