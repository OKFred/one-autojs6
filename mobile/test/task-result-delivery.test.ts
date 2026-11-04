import assert from "node:assert/strict";
import { deliverPersistedTaskResult } from "../src/task-result-delivery.js";

let mqttCalls = 0;
let httpCalls = 0;
await assert.rejects(() =>
  deliverPersistedTaskResult({
    callbackRequired: true,
    mqtt: async () => {
      mqttCalls += 1;
    },
    http: async () => {
      httpCalls += 1;
      throw new Error("synthetic HTTP failure");
    },
  }),
);
assert.equal(mqttCalls, 1);
assert.equal(httpCalls, 1);

assert.equal(
  await deliverPersistedTaskResult({
    callbackRequired: true,
    mqtt: async () => {
      mqttCalls += 1;
      throw new Error("synthetic MQTT failure");
    },
    http: async () => {
      httpCalls += 1;
    },
  }),
  true,
);
assert.equal(await deliverPersistedTaskResult({ callbackRequired: false }), false);
assert.equal(
  await deliverPersistedTaskResult({
    callbackRequired: false,
    mqtt: async () => {
      mqttCalls += 1;
    },
  }),
  true,
);

console.log("task result delivery authority tests passed");
