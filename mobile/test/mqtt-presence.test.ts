import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { MqttPresence } from "../src/mqtt-presence.js";
import { toHttpPresence } from "../src/report-presence.js";

const legacyDeviceId = "mobile_00000000000000";
const healthDeviceId = "00000000-0000-4000-8000-000000000001";
const clientSource = ts.createSourceFile("client.ts", readFileSync(new URL("../src/client.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const initializer = clientSource.statements.filter(ts.isVariableStatement)
  .flatMap((statement) => [...statement.declarationList.declarations])
  .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "mqttPresence")?.initializer;
assert.ok(initializer);
const actualPresence: MqttPresence = runInNewContext(initializer.getText(clientSource), {
  config: { phoneHealthTelemetry: { enabled: true, siteId: "example-site", gatewayId: "mobile", deviceId: healthDeviceId } },
  deviceId: legacyDeviceId,
  MqttPresence,
});
for (const value of [actualPresence.begin(), actualPresence.message(true), actualPresence.message(true), actualPresence.message(false)]) {
  assert.equal(value.reporter_id, healthDeviceId);
  assert.equal(value.device_id, healthDeviceId);
  assert.equal(value.deviceId, legacyDeviceId);
  assert.equal(toHttpPresence(value).deviceId, legacyDeviceId);
}

const clock = { value: 1000 };
const p = new MqttPresence({ site_id: "example-site", gateway_id: "mobile", device_id: "example-phone", reporter_id: "example-task-client" }, "example-task-client", () => clock.value);
const will = p.begin();
assert.equal(will.status, "OFFLINE");
assert.equal(will.source_time_utc, null);
assert.equal(will.uptime_ms, null);
assert.equal(will.sequence, null);
const birth = p.message(true);
assert.equal(birth.event, "online");
assert.equal(birth.status, "ONLINE");
assert.equal(birth.protocolVersion, 2);
assert.equal(birth.deviceId, "example-task-client");
assert.equal(birth.device_id, "example-phone");
assert.equal(birth.session_id, will.session_id);
assert.equal(birth.sequence, 1);
clock.value += 60_000;
const beat = p.message(true);
assert.equal(beat.event, "heartbeat");
assert.equal(beat.uptime_ms, 60_000);
assert.equal(beat.sequence, 2);
assert.notEqual(beat.event_id, birth.event_id);
const shutdown = p.message(false);
assert.equal(shutdown.reason, "shutdown");
assert.ok(shutdown.source_time_utc);
const nextWill = p.begin();
assert.notEqual(nextWill.session_id, will.session_id);
assert.equal(p.message(true).event, "online");
assert.ok(Buffer.byteLength(JSON.stringify(beat)) < 1024);

const httpKeys = ["deviceId", "protocolVersion", "status", "timestamp"].sort();
const legacy = {
  protocolVersion: 2 as const,
  deviceId: "example-task-client",
  status: "ONLINE" as const,
  timestamp: Date.now(),
};
assert.deepEqual(toHttpPresence(legacy), legacy);
assert.notEqual(toHttpPresence(legacy), legacy);
for (const extended of [birth, beat, shutdown]) {
  const mqttBefore = JSON.stringify(extended);
  const http = toHttpPresence(extended);
  assert.notDeepEqual(Object.keys(extended).sort(), httpKeys);
  assert.deepEqual(Object.keys(http).sort(), httpKeys);
  assert.deepEqual(http, {
    protocolVersion: extended.protocolVersion,
    deviceId: extended.deviceId,
    status: extended.status,
    timestamp: extended.timestamp,
  });
  assert.equal(JSON.stringify(extended), mqttBefore);
  assert.equal(extended.schema_version, 1);
  assert.ok(extended.session_id);
}
console.log("MQTT presence session, birth, heartbeat, graceful offline and legacy compatibility passed");
