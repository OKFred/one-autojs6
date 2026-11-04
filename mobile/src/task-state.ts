import type { DeviceTaskRequest } from "./protocol.js";
import type { QueuedDeviceTask } from "./task-queue.js";

/** Operator command accepted on the device-specific task control topic. */
export interface TaskControlCommand {
  protocolVersion: 2;
  action: "CANCEL";
  commandId: string;
  taskId: string;
  createdAt: number;
  expiresAt: number;
}

/** Safe task summary exposed to the control plane. */
export interface DeviceTaskStateItem {
  taskId: string;
  scriptId: string;
  priority: DeviceTaskRequest["priority"];
  createdAt: number;
  startedAt: number | null;
  position: number | null;
  phase: "STARTING" | "RUNNING" | "QUEUED";
  cancellable: boolean;
}

/** Retained device queue snapshot without task parameters or business content. */
export interface DeviceTaskStateSnapshot {
  protocolVersion: 2;
  deviceId: string;
  sessionId: string;
  sessionStartedAt: number;
  timestamp: number;
  revision: number;
  running: DeviceTaskStateItem | null;
  queued: DeviceTaskStateItem[];
}

/** Return whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return whether a broad package stop is still bound to the same live task. */
export function canUsePackageFallback(
  allowed: boolean,
  expectedTaskId: string,
  activeTaskId: string | null,
  cleanupPending: boolean,
): boolean {
  return (
    allowed &&
    !cleanupPending &&
    activeTaskId !== null &&
    activeTaskId === expectedTaskId
  );
}

/** Return whether cancellation still targets one fully launched active task. */
export function canCancelActiveTask(
  requestedTaskId: string,
  activeTaskId: string | null,
  launched: boolean,
  cleanupPending: boolean,
): boolean {
  return (
    launched &&
    !cleanupPending &&
    activeTaskId !== null &&
    activeTaskId === requestedTaskId
  );
}

/** Parse one strict operator cancellation command. */
export function parseTaskControlCommand(
  value: unknown,
  now = Date.now(),
): TaskControlCommand {
  if (!isRecord(value) || value.protocolVersion !== 2 || value.action !== "CANCEL") {
    throw new Error("Unsupported task control command");
  }
  for (const key of ["commandId", "taskId"] as const) {
    if (
      typeof value[key] !== "string" ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(value[key])
    ) {
      throw new Error(`Invalid ${key}`);
    }
  }
  if (
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    throw new Error("Invalid task control expiry");
  }
  const createdAt = value.createdAt as number;
  const expiresAt = value.expiresAt as number;
  if (
    createdAt > now + 30_000 ||
    expiresAt <= createdAt ||
    expiresAt - createdAt > 5 * 60_000
  ) {
    throw new Error("Invalid task control expiry");
  }
  return {
    protocolVersion: 2,
    action: "CANCEL",
    commandId: value.commandId as string,
    taskId: value.taskId as string,
    createdAt,
    expiresAt,
  };
}

/** Build the privacy-safe retained snapshot shown by the task control UI. */
export function buildTaskStateSnapshot(options: {
  deviceId: string;
  sessionId: string;
  sessionStartedAt: number;
  revision: number;
  timestamp: number;
  active: {
    request: DeviceTaskRequest;
    enqueuedAt: number;
    startedAt: number;
    launched: boolean;
  } | null;
  starting: {
    request: DeviceTaskRequest;
    enqueuedAt: number;
    startedAt: number;
  } | null;
  queue: readonly QueuedDeviceTask[];
}): DeviceTaskStateSnapshot {
  const current = options.active || options.starting;
  return {
    protocolVersion: 2,
    deviceId: options.deviceId,
    sessionId: options.sessionId,
    sessionStartedAt: options.sessionStartedAt,
    timestamp: options.timestamp,
    revision: options.revision,
    running: current
      ? {
          taskId: current.request.taskId,
          scriptId: current.request.scriptId,
          priority: current.request.priority,
          createdAt: current.enqueuedAt,
          startedAt: current.startedAt,
          position: null,
          phase: options.active?.launched ? "RUNNING" : "STARTING",
          cancellable: options.active?.launched === true,
        }
      : null,
    queued: options.queue.map(({ request, enqueuedAt }, index) => ({
      taskId: request.taskId,
      scriptId: request.scriptId,
      priority: request.priority,
      createdAt: enqueuedAt,
      startedAt: null,
      position: index + 1,
      phase: "QUEUED",
      cancellable: true,
    })),
  };
}
