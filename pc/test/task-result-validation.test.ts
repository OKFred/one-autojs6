import assert from "node:assert/strict";

import {
  isMatchingTaskResult,
  parseTaskResult,
  type DeviceTaskResultPayload,
  type RemoteTask,
} from "../src/service/node-server.service.js";

const task: RemoteTask = {
  taskId: "task_known_001",
  clientId: "device-known",
  scriptId: "device.apps.list",
  traceId: "trace_known_001",
  priority: "NORMAL",
  preemptRunning: false,
  preemptedByTaskId: null,
  status: "EXECUTING",
  resultMessage: null,
  resultCode: null,
  resultDataJson: null,
  createTimeUtc: 1,
  expiresAtUtc: 60_001,
  finishedAtUtc: null,
};

const result: DeviceTaskResultPayload = {
  protocolVersion: 2,
  taskId: task.taskId,
  deviceId: task.clientId,
  scriptId: task.scriptId || "",
  status: "SUCCESS",
  code: "OK",
  message: "done",
  data: null,
  startedAt: 2,
  finishedAt: 3,
  durationMs: 1,
  traceId: task.traceId || "",
};

assert.deepEqual(parseTaskResult(result), result);
assert.equal(parseTaskResult({ ...result, status: undefined }), null);
assert.equal(parseTaskResult({ ...result, status: "DONE" }), null);
assert.equal(parseTaskResult({ ...result, durationMs: Number.NaN }), null);
assert.equal(isMatchingTaskResult(task, task.clientId, result), true);
assert.equal(isMatchingTaskResult(task, "forged-device", result), false);
assert.equal(
  isMatchingTaskResult(task, task.clientId, {
    ...result,
    deviceId: "forged-device",
  }),
  false,
);
assert.equal(
  isMatchingTaskResult(task, task.clientId, {
    ...result,
    taskId: "unknown_task_001",
  }),
  false,
);
assert.equal(
  isMatchingTaskResult(task, task.clientId, {
    ...result,
    scriptId: "forged.script",
  }),
  false,
);
assert.equal(
  isMatchingTaskResult(task, task.clientId, {
    ...result,
    traceId: "forged_trace_001",
  }),
  false,
);
assert.equal(
  isMatchingTaskResult({ ...task, status: "SUCCESS" }, task.clientId, result),
  false,
);

console.log("PC task result validation tests passed");
