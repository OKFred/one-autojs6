import assert from "node:assert/strict";
import {
  buildTaskStateSnapshot,
  canCancelActiveTask,
  canUsePackageFallback,
  parseTaskControlCommand,
} from "../src/task-state.js";
import type { DeviceTaskRequest } from "../src/protocol.js";

/** Create a minimal synthetic request for queue-state tests. */
function task(taskId: string, priority: DeviceTaskRequest["priority"]): DeviceTaskRequest {
  return {
    protocolVersion: 2,
    taskId,
    deviceId: "device-1",
    scriptId: "app.version.check",
    params: { secret: "must-not-leak" },
    timeoutMs: 60_000,
    createdAt: 100,
    expiresAt: 60_100,
    traceId: `trace_${taskId}`,
    priority,
    preemptRunning: false,
  };
}

const command = parseTaskControlCommand({
  protocolVersion: 2,
  action: "CANCEL",
  commandId: "command_123",
  taskId: "task_12345",
  createdAt: 1_000,
  expiresAt: 61_000,
});
assert.equal(command.taskId, "task_12345");
assert.throws(() => parseTaskControlCommand({ ...command, action: "KILL" }));
assert.throws(() => parseTaskControlCommand({ ...command, taskId: "../bad" }));
assert.throws(() =>
  parseTaskControlCommand({ ...command, expiresAt: command.createdAt + 300_001 }),
);
assert.throws(() =>
  parseTaskControlCommand(
    { ...command, createdAt: 1_000_000, expiresAt: 1_030_000 },
    900_000,
  ),
);
assert.equal(canUsePackageFallback(true, "task_12345", "task_12345", false), true);
assert.equal(canUsePackageFallback(false, "task_12345", "task_12345", false), false);
assert.equal(canUsePackageFallback(true, "task_12345", "task_later", false), false);
assert.equal(canUsePackageFallback(true, "task_12345", "task_12345", true), false);
assert.equal(canCancelActiveTask("task_12345", "task_12345", true, false), true);
assert.equal(canCancelActiveTask("task_12345", "task_12345", false, false), false);
assert.equal(canCancelActiveTask("task_12345", "task_later", true, false), false);

const active = task("active_123", "NORMAL");
const queued = task("queued_123", "HIGH");
const snapshot = buildTaskStateSnapshot({
  deviceId: "device-1",
  sessionId: "session_123",
  sessionStartedAt: 50,
  revision: 7,
  timestamp: 500,
  active: { request: active, enqueuedAt: 200, startedAt: 300, launched: true },
  starting: null,
  queue: [{ request: queued, sequence: 1, enqueuedAt: 250 }],
});
assert.equal(snapshot.running?.phase, "RUNNING");
assert.equal(snapshot.running?.cancellable, true);
assert.equal(snapshot.queued[0]?.position, 1);
assert.equal(snapshot.queued[0]?.createdAt, 250);
assert.equal(JSON.stringify(snapshot).includes("must-not-leak"), false);

const launching = buildTaskStateSnapshot({
  deviceId: "device-1",
  sessionId: "session_123",
  sessionStartedAt: 50,
  revision: 8,
  timestamp: 550,
  active: { request: active, enqueuedAt: 200, startedAt: 300, launched: false },
  starting: null,
  queue: [],
});
assert.equal(launching.running?.phase, "STARTING");
assert.equal(launching.running?.cancellable, false);

const starting = buildTaskStateSnapshot({
  deviceId: "device-1",
  sessionId: "session_123",
  sessionStartedAt: 50,
  revision: 9,
  timestamp: 600,
  active: null,
  starting: { request: active, enqueuedAt: 200, startedAt: 550 },
  queue: [],
});
assert.equal(starting.running?.phase, "STARTING");
assert.equal(starting.running?.cancellable, false);

const maximumQueue = Array.from({ length: 256 }, (_, index) => ({
  request: task(`task_${String(index).padStart(95, "x")}`, "NORMAL"),
  sequence: index,
  enqueuedAt: index,
}));
const maximumSnapshot = buildTaskStateSnapshot({
  deviceId: "d".repeat(100),
  sessionId: "session_123",
  sessionStartedAt: 50,
  revision: 10,
  timestamp: 700,
  active: null,
  starting: null,
  queue: maximumQueue,
});
assert.equal(maximumSnapshot.queued.length, 256);
assert.equal(
  Buffer.byteLength(JSON.stringify(maximumSnapshot), "utf8") <= 256 * 1024,
  true,
);

console.log("task state and control tests passed");
