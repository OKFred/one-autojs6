/** AutoJS6 设备任务协议版本。 */
export const PROTOCOL_VERSION = 2 as const;

/** 设备任务终态。 */
export type TaskStatus =
  "SUCCESS" | "FAILURE" | "TIMEOUT" | "REJECTED" | "CANCELLED";

/** 服务端下发给单台设备的可信脚本任务。 */
export interface DeviceTaskRequest {
  protocolVersion: 2;
  taskId: string;
  deviceId: string;
  scriptId: string;
  scriptVersion?: number;
  params: Record<string, unknown>;
  timeoutMs: number;
  createdAt: number;
  expiresAt: number;
  traceId: string;
  callbackUrl?: string;
}

/** 手机端向服务端上报的统一任务结果。 */
export interface DeviceTaskResult {
  protocolVersion: 2;
  taskId: string;
  deviceId: string;
  scriptId: string;
  status: TaskStatus;
  code: string;
  message: string;
  data: unknown;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  traceId: string;
}

/** 手机端事件监听结果。 */
export interface DeviceEventPayload {
  protocolVersion: 2;
  deviceId: string;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

/** 手机端能力与在线状态。 */
export interface DevicePresencePayload {
  protocolVersion: 2;
  deviceId: string;
  status: "ONLINE" | "OFFLINE";
  clientVersion: string;
  timestamp: number;
  scripts: Array<{ scriptId: string; version: number }>;
}

/** 判断值是否为普通 JSON 对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析并校验 v2 任务的必需字段。
 *
 * @param value MQTT JSON 载荷。
 * @returns 合法任务。
 */
export function parseDeviceTaskRequest(value: unknown): DeviceTaskRequest {
  if (!isRecord(value)) throw new Error("Task payload must be an object");
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("Unsupported protocol version");
  }
  const stringKeys = ["taskId", "deviceId", "scriptId", "traceId"] as const;
  for (const key of stringKeys) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`Missing or invalid ${key}`);
    }
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(value.taskId as string)) {
    throw new Error("taskId contains unsupported characters");
  }
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(value.deviceId as string)) {
    throw new Error("deviceId contains unsupported characters");
  }
  if (!/^[a-z0-9._-]{1,100}$/.test(value.scriptId as string)) {
    throw new Error("scriptId contains unsupported characters");
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(value.traceId as string)) {
    throw new Error("traceId contains unsupported characters");
  }
  const numberKeys = ["timeoutMs", "createdAt", "expiresAt"] as const;
  for (const key of numberKeys) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new Error(`Missing or invalid ${key}`);
    }
  }
  if (!isRecord(value.params)) throw new Error("params must be an object");

  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: value.taskId as string,
    deviceId: value.deviceId as string,
    scriptId: value.scriptId as string,
    scriptVersion:
      typeof value.scriptVersion === "number" ? value.scriptVersion : undefined,
    params: value.params,
    timeoutMs: value.timeoutMs as number,
    createdAt: value.createdAt as number,
    expiresAt: value.expiresAt as number,
    traceId: value.traceId as string,
    callbackUrl:
      typeof value.callbackUrl === "string" ? value.callbackUrl : undefined,
  };
}
