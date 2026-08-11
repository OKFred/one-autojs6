import assert from "node:assert/strict";

import {
  parseDeviceTaskRequest,
  type DeviceTaskRequest,
  type TaskPriority,
} from "../src/protocol.js";
import {
  canPreemptRunning,
  findHighPriorityEvictionIndex,
  insertQueuedTask,
  type QueuedDeviceTask,
} from "../src/task-queue.js";
import { validateRegisteredTaskParams } from "../src/task-registry.js";

function task(
  taskId: string,
  priority: TaskPriority,
  preemptRunning = false,
): DeviceTaskRequest {
  const createdAt = Date.now();
  return {
    protocolVersion: 2,
    taskId,
    deviceId: "device-test",
    scriptId: "device.apps.list",
    params: {},
    timeoutMs: 30_000,
    createdAt,
    expiresAt: createdAt + 60_000,
    traceId: `trace_${taskId}`,
    priority,
    preemptRunning,
  };
}

const queue: QueuedDeviceTask[] = [];
insertQueuedTask(queue, { request: task("normal_001", "NORMAL"), sequence: 0 });
insertQueuedTask(queue, { request: task("low_000001", "LOW"), sequence: 1 });
insertQueuedTask(queue, { request: task("high_00001", "HIGH"), sequence: 2 });
insertQueuedTask(queue, { request: task("normal_002", "NORMAL"), sequence: 3 });
assert.deepEqual(
  queue.map((entry) => entry.request.taskId),
  ["high_00001", "normal_001", "normal_002", "low_000001"],
  "queue must sort by priority and preserve same-priority FIFO",
);

assert.equal(
  canPreemptRunning(task("incoming_01", "HIGH"), task("running_001", "LOW")),
  false,
);
assert.equal(
  canPreemptRunning(
    task("incoming_02", "LOW", true),
    task("running_002", "NORMAL"),
  ),
  false,
);
assert.equal(
  canPreemptRunning(
    task("incoming_03", "NORMAL", true),
    task("running_003", "NORMAL"),
  ),
  true,
);
assert.equal(
  canPreemptRunning(
    task("incoming_04", "HIGH", true),
    task("running_004", "NORMAL"),
  ),
  true,
);

const evictionQueue: QueuedDeviceTask[] = [
  { request: task("normal_old1", "NORMAL"), sequence: 0 },
  { request: task("low_old_001", "LOW"), sequence: 1 },
  { request: task("low_new_001", "LOW"), sequence: 2 },
];
assert.equal(
  findHighPriorityEvictionIndex(evictionQueue, task("high_evict1", "HIGH")),
  1,
  "HIGH must evict the oldest task among the lowest waiting priority",
);
assert.equal(
  findHighPriorityEvictionIndex(
    [{ request: task("high_only01", "HIGH"), sequence: 0 }],
    task("high_reject", "HIGH"),
  ),
  -1,
  "an all-HIGH queue cannot be evicted",
);
assert.equal(
  findHighPriorityEvictionIndex(evictionQueue, task("normal_full", "NORMAL")),
  -1,
  "only an incoming HIGH task may evict",
);

const base = {
  protocolVersion: 2,
  taskId: "legacy_001",
  deviceId: "device-test",
  params: {},
  timeoutMs: 30_000,
  createdAt: 1,
  expiresAt: 60_001,
  traceId: "trace_legacy_001",
};
assert.deepEqual(
  parseDeviceTaskRequest({ ...base, scriptId: "device.apps.list" }).priority,
  "NORMAL",
);
assert.deepEqual(
  parseDeviceTaskRequest({ ...base, scriptId: "device.network.switch" })
    .priority,
  "HIGH",
);
assert.equal(
  parseDeviceTaskRequest({ ...base, scriptId: "device.apps.list" })
    .preemptRunning,
  false,
);
assert.throws(
  () =>
    parseDeviceTaskRequest({
      ...base,
      scriptId: "device.apps.list",
      priority: "URGENT",
    }),
  /priority/,
);
assert.match(
  validateRegisteredTaskParams(
    "device.network.switch",
    { target: "carrier", timeoutMs: 30_000 },
    40_000,
  ) || "",
  /reserve 15000ms/,
);
assert.equal(
  validateRegisteredTaskParams(
    "device.network.switch",
    { target: "carrier", timeoutMs: 30_000 },
    45_000,
  ),
  null,
);

console.log("task queue and protocol tests passed");
