import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isRecord } from "./protocol.js";

/** 单个手机事件监听器配置。 */
export interface EventObserverConfig {
  enabled: boolean;
  debounceMs: number;
  packageAllowList: string[];
  packageDenyList: string[];
}

/** 手机守护进程配置。 */
export interface Autojs6Config {
  deviceId?: string;
  mqtt: {
    qos: 0 | 1 | 2;
    sessionExpirySeconds: number;
  };
  security: {
    allowedScriptIds: string[];
    maxParamsBytes: number;
  };
  tasks: {
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    queueLimit: number;
    resultPollIntervalMs: number;
  };
  events: Record<
    "battery" | "network" | "sms" | "notification",
    EventObserverConfig
  >;
}

const DEFAULT_EVENT: EventObserverConfig = {
  enabled: false,
  debounceMs: 1000,
  packageAllowList: [],
  packageDenyList: [],
};

/** 安全优先的手机端默认配置。 */
export const DEFAULT_CONFIG: Autojs6Config = {
  mqtt: {
    qos: 1,
    sessionExpirySeconds: 86400,
  },
  security: {
    allowedScriptIds: [
      "device.apps.list",
      "app.install",
      "app.version.check",
      "app.update.store",
      "app.update.zip",
      "file.download",
      "tiktok.post",
      "client.self-update",
    ],
    maxParamsBytes: 65536,
  },
  tasks: {
    defaultTimeoutMs: 120000,
    maxTimeoutMs: 900000,
    queueLimit: 20,
    resultPollIntervalMs: 500,
  },
  events: {
    battery: { ...DEFAULT_EVENT, enabled: true },
    network: { ...DEFAULT_EVENT, enabled: true },
    sms: { ...DEFAULT_EVENT },
    notification: { ...DEFAULT_EVENT },
  },
};

/** 返回当前 mobile 项目的根目录。 */
function getMobileRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..");
}

/** 从未知输入中提取字符串数组。 */
function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : fallback;
}

/** 合并单个事件配置。 */
function mergeEventConfig(
  value: unknown,
  fallback: EventObserverConfig,
): EventObserverConfig {
  if (!isRecord(value)) return fallback;
  return {
    enabled:
      typeof value.enabled === "boolean" ? value.enabled : fallback.enabled,
    debounceMs:
      typeof value.debounceMs === "number"
        ? value.debounceMs
        : fallback.debounceMs,
    packageAllowList: stringArray(
      value.packageAllowList,
      fallback.packageAllowList,
    ),
    packageDenyList: stringArray(
      value.packageDenyList,
      fallback.packageDenyList,
    ),
  };
}

/**
 * 读取并校验 `autojs6-config.json`。文件不存在时使用安全默认值。
 *
 * @returns 配置与实际读取路径。
 */
export function loadConfig(): { config: Autojs6Config; configPath: string } {
  const configPath =
    process.env.AUTOJS6_CONFIG_PATH ||
    path.join(getMobileRoot(), "autojs6-config.json");
  if (!fs.existsSync(configPath)) {
    return { config: DEFAULT_CONFIG, configPath };
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!isRecord(parsed))
    throw new Error("autojs6-config.json must be an object");
  const mqtt = isRecord(parsed.mqtt) ? parsed.mqtt : {};
  const security = isRecord(parsed.security) ? parsed.security : {};
  const tasks = isRecord(parsed.tasks) ? parsed.tasks : {};
  const events = isRecord(parsed.events) ? parsed.events : {};
  const qos = mqtt.qos === 0 || mqtt.qos === 2 ? mqtt.qos : 1;

  return {
    configPath,
    config: {
      deviceId:
        typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
      mqtt: {
        qos,
        sessionExpirySeconds:
          typeof mqtt.sessionExpirySeconds === "number"
            ? mqtt.sessionExpirySeconds
            : DEFAULT_CONFIG.mqtt.sessionExpirySeconds,
      },
      security: {
        allowedScriptIds: stringArray(
          security.allowedScriptIds,
          DEFAULT_CONFIG.security.allowedScriptIds,
        ),
        maxParamsBytes:
          typeof security.maxParamsBytes === "number"
            ? security.maxParamsBytes
            : DEFAULT_CONFIG.security.maxParamsBytes,
      },
      tasks: {
        defaultTimeoutMs:
          typeof tasks.defaultTimeoutMs === "number"
            ? tasks.defaultTimeoutMs
            : DEFAULT_CONFIG.tasks.defaultTimeoutMs,
        maxTimeoutMs:
          typeof tasks.maxTimeoutMs === "number"
            ? tasks.maxTimeoutMs
            : DEFAULT_CONFIG.tasks.maxTimeoutMs,
        queueLimit:
          typeof tasks.queueLimit === "number"
            ? tasks.queueLimit
            : DEFAULT_CONFIG.tasks.queueLimit,
        resultPollIntervalMs:
          typeof tasks.resultPollIntervalMs === "number"
            ? tasks.resultPollIntervalMs
            : DEFAULT_CONFIG.tasks.resultPollIntervalMs,
      },
      events: {
        battery: mergeEventConfig(
          events.battery,
          DEFAULT_CONFIG.events.battery,
        ),
        network: mergeEventConfig(
          events.network,
          DEFAULT_CONFIG.events.network,
        ),
        sms: mergeEventConfig(events.sms, DEFAULT_CONFIG.events.sms),
        notification: mergeEventConfig(
          events.notification,
          DEFAULT_CONFIG.events.notification,
        ),
      },
    },
  };
}
