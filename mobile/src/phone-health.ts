import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { PhoneHealthTelemetryConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const DRIVER = "android-phone-health";
const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PhoneHealthMetric =
  | "battery_temperature_c"
  | "battery_pct"
  | "battery_voltage_v"
  | "charging"
  | "device_thermal_status"
  | "storage_free_bytes"
  | "memory_available_bytes"
  | "system_uptime_seconds"
  | "collector_uptime_seconds";

export type PhoneHealthMetricStatus =
  | "unsupported"
  | "permission_denied"
  | "timeout"
  | "read_failed";

export interface PhoneHealthEnvelope {
  schema_version: 2;
  message_id: string;
  site_id: string;
  gateway_id: string;
  device_id: string;
  read_time_utc: string;
  sample_time_utc: null;
  observation_kind: "direct_read";
  quality: "ok";
  metrics: Partial<Record<PhoneHealthMetric, number>>;
  source: {
    driver: typeof DRIVER;
    metric_status: Partial<Record<PhoneHealthMetric, PhoneHealthMetricStatus>>;
  };
}

interface PhoneHealthDependencies {
  readText(filePath: string): Promise<string>;
  readThermalService(): Promise<string>;
  statfs(filePath: string): Promise<{ bavail: number; bsize: number }>;
  freeMemory(): number;
  systemUptime(): number;
  collectorUptime(): number;
  now(): Date;
  randomUuid(): string;
}

interface PhoneHealthOutboxEntry {
  topic: string;
  payload: PhoneHealthEnvelope;
  persisted_at_utc: string;
}

/** 读取固定 sysfs 文件；失败时返回空字符串。 */
async function readText(filePath: string): Promise<string> {
  try {
    return (await fs.promises.readFile(filePath, "utf8")).trim();
  } catch {
    return "";
  }
}

/** 在固定超时内读取 Android ThermalService。 */
async function readThermalService(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("dumpsys", ["thermalservice"], {
      timeout: 3000,
      maxBuffer: 256 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

/** 读取指定数据分区的可用字节数。 */
async function statfs(filePath: string): Promise<{ bavail: number; bsize: number }> {
  const value = await fs.promises.statfs(filePath);
  return { bavail: Number(value.bavail), bsize: Number(value.bsize) };
}

const DEFAULT_DEPENDENCIES: PhoneHealthDependencies = {
  readText,
  readThermalService,
  statfs,
  freeMemory: () => os.freemem(),
  systemUptime: () => os.uptime(),
  collectorUptime: () => process.uptime(),
  now: () => new Date(),
  randomUuid: () => crypto.randomUUID(),
};

/** 将有限数字写入指标，否则记录固定不可用原因。 */
function addMetric(
  metrics: PhoneHealthEnvelope["metrics"],
  metricStatus: PhoneHealthEnvelope["source"]["metric_status"],
  metric: PhoneHealthMetric,
  value: number,
  reason: PhoneHealthMetricStatus,
): void {
  if (Number.isFinite(value)) metrics[metric] = value;
  else metricStatus[metric] = reason;
}

/** 解析 Android ThermalService 当前状态，不把温度点猜成其他指标。 */
export function parseThermalService(output: string): { status?: number } {
  const statusText = /(?:^|\n)Thermal Status:\s*([0-6])\s*(?:\n|$)/.exec(
    output,
  )?.[1];
  return {
    status: statusText === undefined ? undefined : Number(statusText),
  };
}

/** 采集一次低开销手机健康快照。 */
export async function collectPhoneHealth(
  config: PhoneHealthTelemetryConfig,
  dependencies: PhoneHealthDependencies = DEFAULT_DEPENDENCIES,
): Promise<PhoneHealthEnvelope> {
  const [temperatureText, capacityText, statusText, voltageText, thermalText] =
    await Promise.all([
      dependencies.readText("/sys/class/power_supply/battery/temp"),
      dependencies.readText("/sys/class/power_supply/battery/capacity"),
      dependencies.readText("/sys/class/power_supply/battery/status"),
      dependencies.readText("/sys/class/power_supply/battery/voltage_now"),
      dependencies.readThermalService(),
    ]);
  const metrics: PhoneHealthEnvelope["metrics"] = {};
  const metricStatus: PhoneHealthEnvelope["source"]["metric_status"] = {};
  const batteryTemperatureRaw = temperatureText ? Number(temperatureText) : Number.NaN;
  addMetric(
    metrics,
    metricStatus,
    "battery_temperature_c",
    batteryTemperatureRaw >= -500 && batteryTemperatureRaw <= 2000
      ? batteryTemperatureRaw / 10
      : Number.NaN,
    "read_failed",
  );
  const batteryPct = capacityText ? Number(capacityText) : Number.NaN;
  addMetric(
    metrics,
    metricStatus,
    "battery_pct",
    batteryPct >= 0 && batteryPct <= 100 ? batteryPct : Number.NaN,
    "read_failed",
  );
  const charging = /^(Charging|Full)$/i.test(statusText)
    ? 1
    : /^(Discharging|Not charging)$/i.test(statusText)
      ? 0
      : Number.NaN;
  addMetric(metrics, metricStatus, "charging", charging, "read_failed");
  const voltageRaw = voltageText ? Number(voltageText) : Number.NaN;
  const voltage =
    voltageRaw >= 2_000_000 && voltageRaw <= 6_000_000
      ? voltageRaw / 1_000_000
      : voltageRaw >= 2000 && voltageRaw <= 6000
        ? voltageRaw / 1000
        : Number.NaN;
  addMetric(
    metrics,
    metricStatus,
    "battery_voltage_v",
    voltage,
    "read_failed",
  );
  const thermal = parseThermalService(thermalText);
  addMetric(
    metrics,
    metricStatus,
    "device_thermal_status",
    thermal.status ?? Number.NaN,
    "read_failed",
  );
  try {
    const storage = await dependencies.statfs("/data");
    addMetric(
      metrics,
      metricStatus,
      "storage_free_bytes",
      storage.bavail * storage.bsize,
      "read_failed",
    );
  } catch {
    metricStatus.storage_free_bytes = "read_failed";
  }
  addMetric(
    metrics,
    metricStatus,
    "memory_available_bytes",
    dependencies.freeMemory(),
    "read_failed",
  );
  addMetric(
    metrics,
    metricStatus,
    "system_uptime_seconds",
    dependencies.systemUptime(),
    "read_failed",
  );
  addMetric(
    metrics,
    metricStatus,
    "collector_uptime_seconds",
    dependencies.collectorUptime(),
    "read_failed",
  );
  return {
    schema_version: 2,
    message_id: dependencies.randomUuid(),
    site_id: config.siteId,
    gateway_id: config.gatewayId,
    device_id: config.deviceId,
    read_time_utc: dependencies.now().toISOString(),
    sample_time_utc: null,
    observation_kind: "direct_read",
    quality: "ok",
    metrics,
    source: { driver: DRIVER, metric_status: metricStatus },
  };
}

/** 管理一分钟采集、原子 outbox、QoS 1 确认与有界补报。 */
export class PhoneHealthReporter {
  private readonly outboxDirectory: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private replaying = false;

  /** 创建独立手机健康上报器。 */
  constructor(
    private readonly config: PhoneHealthTelemetryConfig,
    stateDirectory: string,
    private readonly publish: (topic: string, payload: unknown) => Promise<void>,
    private readonly collect: () => Promise<PhoneHealthEnvelope> = () =>
      collectPhoneHealth(config),
  ) {
    this.outboxDirectory = path.join(stateDirectory, "phone-health-outbox");
  }

  /** 返回不含敏感标识的遥测主题。 */
  topic(): string {
    return `iot/v1/${this.config.siteId}/${this.config.gatewayId}/devices/${this.config.deviceId}/telemetry`;
  }

  /** 启动即时采集和固定周期定时器。 */
  start(): void {
    if (!this.config.enabled || this.timer) return;
    void this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce(),
      this.config.intervalSeconds * 1000,
    );
  }

  /** 停止后续采集，不删除待确认消息。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** MQTT 重连后按原 message_id 和 read_time_utc 补报。 */
  async replay(): Promise<void> {
    if (!this.config.enabled || this.replaying) return;
    this.replaying = true;
    fs.mkdirSync(this.outboxDirectory, { recursive: true, mode: 0o700 });
    let expiredCount = 0;
    try {
      for (const fileName of fs.readdirSync(this.outboxDirectory).sort()) {
        if (!fileName.endsWith(".json")) continue;
        const filePath = path.join(this.outboxDirectory, fileName);
        let entry: PhoneHealthOutboxEntry;
        try {
          entry = this.readEntry(filePath);
        } catch {
          console.warn("[PHONE_HEALTH] Removed invalid telemetry outbox entry");
          fs.rmSync(filePath, { force: true });
          continue;
        }
        const persistedAt = Date.parse(entry.persisted_at_utc);
        if (
          !Number.isFinite(persistedAt) ||
          Date.now() - persistedAt > OUTBOX_MAX_AGE_MS
        ) {
          fs.rmSync(filePath, { force: true });
          expiredCount += 1;
          continue;
        }
        try {
          await this.publish(entry.topic, entry.payload);
          fs.rmSync(filePath, { force: true });
        } catch {
          console.warn("[PHONE_HEALTH] Telemetry delivery remains pending");
          break;
        }
      }
      if (expiredCount > 0) {
        console.warn(
          `[PHONE_HEALTH] Dropped expired telemetry count=${expiredCount}`,
        );
      }
    } finally {
      this.replaying = false;
    }
  }

  /** 执行一次防重叠采集，并在发送前原子持久化。 */
  async runOnce(): Promise<void> {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    try {
      await this.replay();
      const payload = await this.collect();
      const entry: PhoneHealthOutboxEntry = {
        topic: this.topic(),
        payload,
        persisted_at_utc: new Date().toISOString(),
      };
      this.persist(entry);
      await this.replay();
    } catch {
      console.warn("[PHONE_HEALTH] Collection or delivery failed safely");
    } finally {
      this.running = false;
    }
  }

  /** 原子保存单条遥测并淘汰最旧超限文件。 */
  private persist(entry: PhoneHealthOutboxEntry): void {
    fs.mkdirSync(this.outboxDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(
      this.outboxDirectory,
      `${Date.now()}-${entry.payload.message_id}.json`,
    );
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
    const files = fs
      .readdirSync(this.outboxDirectory)
      .filter((fileName) => fileName.endsWith(".json"))
      .sort();
    let evictedCount = 0;
    while (files.length > this.config.outboxLimit) {
      fs.rmSync(path.join(this.outboxDirectory, files.shift()!), {
        force: true,
      });
      evictedCount += 1;
    }
    if (evictedCount > 0) {
      console.warn(
        `[PHONE_HEALTH] Evicted oldest telemetry count=${evictedCount}`,
      );
    }
  }

  /** 严格读取本进程生成的 outbox 信封。 */
  private readEntry(filePath: string): PhoneHealthOutboxEntry {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("topic" in value) ||
      value.topic !== this.topic() ||
      !("payload" in value) ||
      typeof value.payload !== "object" ||
      value.payload === null ||
      !("persisted_at_utc" in value) ||
      typeof value.persisted_at_utc !== "string" ||
      !("message_id" in value.payload) ||
      typeof value.payload.message_id !== "string"
    ) {
      throw new Error("Invalid phone health outbox entry");
    }
    return value as PhoneHealthOutboxEntry;
  }
}
