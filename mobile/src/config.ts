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

/** TikTok 发布的本机安全策略。 */
export interface TikTokConfig {
  expectedHandle?: string;
  allowedMaterialRoots: string[];
  minIntervalSeconds: number;
  maxPostsPerDay: number;
  materialReuseSeconds: number;
  captionReuseSeconds: number;
  adbKeyboard: {
    enabled: boolean;
    apkSha256: string;
  };
  networkPolicy: {
    enabled: boolean;
    allowedCountries: string[];
    requireWifi: boolean;
    probeTimeoutMs: number;
  };
}

/** Temporary WSS device operations configuration. */
export interface DeviceOpsConfig {
  enabled: boolean;
  allowedWsOrigins: string[];
  fileRoots: Array<{ id: string; label: string; path: string }>;
}

/** 手机守护进程配置。 */
export interface Autojs6Config {
  deviceId?: string;
  mqtt: {
    qos: 0 | 1 | 2;
    sessionExpirySeconds: number;
  };
  report: {
    transport: "mqtt" | "http" | "both";
    httpBaseUrl?: string;
    requestTimeoutMs: number;
    heartbeatSeconds: number;
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
  ops: DeviceOpsConfig;
  tiktok: TikTokConfig;
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
  report: {
    transport: "mqtt",
    requestTimeoutMs: 15000,
    heartbeatSeconds: 60,
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
      "device.network.switch",
      "device.network.routing.apply",
      "device.network.routing.disable",
    ],
    maxParamsBytes: 65536,
  },
  tasks: {
    defaultTimeoutMs: 120000,
    maxTimeoutMs: 900000,
    queueLimit: 20,
    resultPollIntervalMs: 500,
  },
  ops: {
    enabled: false,
    allowedWsOrigins: ["wss://hodor.this-time.com"],
    fileRoots: [
      { id: "shared-download", label: "Downloads", path: "/sdcard/Download" },
      { id: "camera", label: "Camera", path: "/sdcard/DCIM" },
    ],
  },
  tiktok: {
    allowedMaterialRoots: [
      "/sdcard/Download/tiktok-materials",
      "/sdcard/Download",
      "/sdcard/DCIM/Camera",
    ],
    minIntervalSeconds: 1800,
    maxPostsPerDay: 3,
    materialReuseSeconds: 86400,
    captionReuseSeconds: 86400,
    adbKeyboard: {
      enabled: false,
      apkSha256: "",
    },
    networkPolicy: {
      enabled: false,
      allowedCountries: ["GB"],
      requireWifi: true,
      probeTimeoutMs: 12000,
    },
  },
  events: {
    battery: { ...DEFAULT_EVENT, enabled: true },
    network: { ...DEFAULT_EVENT, enabled: true },
    sms: { ...DEFAULT_EVENT, enabled: true },
    notification: { ...DEFAULT_EVENT, enabled: true },
  },
};

/**
 * 解析设备上报通道；supervisor 注入的管理 URL 不受业务环境模板关闭。
 *
 * @param transport 环境模板声明的上报模式。
 * @param managementReportUrl supervisor 注入的设备级 HTTPS 上报地址。
 * @returns 当前客户端应启用的 MQTT 与 HTTPS 通道。
 */
export function resolveReportChannels(
  transport: Autojs6Config["report"]["transport"],
  managementReportUrl?: string,
): { mqtt: boolean; http: boolean } {
  return {
    mqtt: transport === "mqtt" || transport === "both",
    http:
      Boolean(managementReportUrl?.trim()) ||
      transport === "http" ||
      transport === "both",
  };
}

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

/** 将有限整数配置约束在安全范围内。 */
function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.trunc(value), maximum));
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
  const report = isRecord(parsed.report) ? parsed.report : {};
  const security = isRecord(parsed.security) ? parsed.security : {};
  const tasks = isRecord(parsed.tasks) ? parsed.tasks : {};
  const ops = isRecord(parsed.ops) ? parsed.ops : {};
  const tiktok = isRecord(parsed.tiktok) ? parsed.tiktok : {};
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
      report: {
        transport:
          report.transport === "http" || report.transport === "both"
            ? report.transport
            : DEFAULT_CONFIG.report.transport,
        httpBaseUrl:
          typeof report.httpBaseUrl === "string"
            ? report.httpBaseUrl.replace(/\/+$/, "")
            : process.env.AUTOJS6_REPORT_URL?.replace(/\/+$/, ""),
        requestTimeoutMs:
          typeof report.requestTimeoutMs === "number"
            ? Math.max(1000, Math.min(report.requestTimeoutMs, 60000))
            : DEFAULT_CONFIG.report.requestTimeoutMs,
        heartbeatSeconds:
          typeof report.heartbeatSeconds === "number"
            ? Math.max(30, Math.min(report.heartbeatSeconds, 300))
            : DEFAULT_CONFIG.report.heartbeatSeconds,
      },
      security: {
        allowedScriptIds: [
          ...new Set([
            ...stringArray(
              security.allowedScriptIds,
              DEFAULT_CONFIG.security.allowedScriptIds,
            ),
            // 分流属于固定管理面能力，不能被业务环境模板移除。
            "device.network.routing.apply",
            "device.network.routing.disable",
          ]),
        ],
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
      ops: {
        enabled:
          typeof ops.enabled === "boolean"
            ? ops.enabled
            : DEFAULT_CONFIG.ops.enabled,
        allowedWsOrigins: stringArray(
          ops.allowedWsOrigins,
          DEFAULT_CONFIG.ops.allowedWsOrigins,
        ).filter((origin) => {
          try {
            const url = new URL(origin);
            return (
              url.origin === origin &&
              (url.protocol === "wss:" ||
                (url.protocol === "ws:" &&
                  (url.hostname === "localhost" ||
                    url.hostname === "127.0.0.1")))
            );
          } catch {
            return false;
          }
        }),
        fileRoots: Array.isArray(ops.fileRoots)
          ? ops.fileRoots.flatMap((value) =>
              isRecord(value) &&
              typeof value.id === "string" &&
              typeof value.label === "string" &&
              typeof value.path === "string"
                ? [{ id: value.id, label: value.label, path: value.path }]
                : [],
            )
          : DEFAULT_CONFIG.ops.fileRoots,
      },
      tiktok: {
        expectedHandle:
          typeof tiktok.expectedHandle === "string" &&
          tiktok.expectedHandle.trim()
            ? tiktok.expectedHandle.trim().replace(/^@/, "")
            : DEFAULT_CONFIG.tiktok.expectedHandle,
        allowedMaterialRoots: stringArray(
          tiktok.allowedMaterialRoots,
          DEFAULT_CONFIG.tiktok.allowedMaterialRoots,
        ),
        minIntervalSeconds: boundedInteger(
          tiktok.minIntervalSeconds,
          DEFAULT_CONFIG.tiktok.minIntervalSeconds,
          60,
          86400,
        ),
        maxPostsPerDay: boundedInteger(
          tiktok.maxPostsPerDay,
          DEFAULT_CONFIG.tiktok.maxPostsPerDay,
          1,
          100,
        ),
        materialReuseSeconds: boundedInteger(
          tiktok.materialReuseSeconds,
          DEFAULT_CONFIG.tiktok.materialReuseSeconds,
          0,
          2592000,
        ),
        captionReuseSeconds: boundedInteger(
          tiktok.captionReuseSeconds,
          DEFAULT_CONFIG.tiktok.captionReuseSeconds,
          0,
          2592000,
        ),
        adbKeyboard: {
          enabled:
            isRecord(tiktok.adbKeyboard) &&
            typeof tiktok.adbKeyboard.enabled === "boolean"
              ? tiktok.adbKeyboard.enabled
              : DEFAULT_CONFIG.tiktok.adbKeyboard.enabled,
          apkSha256:
            isRecord(tiktok.adbKeyboard) &&
            typeof tiktok.adbKeyboard.apkSha256 === "string"
              ? tiktok.adbKeyboard.apkSha256.trim().toLowerCase()
              : DEFAULT_CONFIG.tiktok.adbKeyboard.apkSha256,
        },
        networkPolicy: {
          enabled:
            isRecord(tiktok.networkPolicy) &&
            typeof tiktok.networkPolicy.enabled === "boolean"
              ? tiktok.networkPolicy.enabled
              : DEFAULT_CONFIG.tiktok.networkPolicy.enabled,
          allowedCountries: stringArray(
            isRecord(tiktok.networkPolicy)
              ? tiktok.networkPolicy.allowedCountries
              : undefined,
            DEFAULT_CONFIG.tiktok.networkPolicy.allowedCountries,
          )
            .map((country) => country.trim().toUpperCase())
            .filter((country) => /^[A-Z]{2}$/.test(country)),
          requireWifi:
            isRecord(tiktok.networkPolicy) &&
            typeof tiktok.networkPolicy.requireWifi === "boolean"
              ? tiktok.networkPolicy.requireWifi
              : DEFAULT_CONFIG.tiktok.networkPolicy.requireWifi,
          probeTimeoutMs: boundedInteger(
            isRecord(tiktok.networkPolicy)
              ? tiktok.networkPolicy.probeTimeoutMs
              : undefined,
            DEFAULT_CONFIG.tiktok.networkPolicy.probeTimeoutMs,
            3000,
            30000,
          ),
        },
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
