import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PhoneHealthTelemetryConfig } from "../src/config.js";
import {
  collectPhoneHealth,
  parseThermalService,
  PhoneHealthReporter,
} from "../src/phone-health.js";

const config: PhoneHealthTelemetryConfig = {
  enabled: true,
  siteId: "home_site",
  gatewayId: "mobile",
  deviceId: "pixel_health",
  intervalSeconds: 60,
  outboxLimit: 2,
};

const thermalOutput = `Thermal Status: 2
Current temperatures from HAL:
  Temperature{mValue=51.5, mType=0, mName=cpu-0, mStatus=0}
  Temperature{mValue=57.25, mType=0, mName=cpu-1, mStatus=0}
  Temperature{mValue=43.75, mType=1, mName=gpu-0, mStatus=0}
  Temperature{mValue=31.0, mType=2, mName=battery, mStatus=0}
Current cooling devices from HAL:
`;

assert.deepEqual(parseThermalService(thermalOutput), {
  status: 2,
});

const payload = await collectPhoneHealth(config, {
  readText: async (filePath) => {
    if (filePath.endsWith("/temp")) return "308";
    if (filePath.endsWith("/capacity")) return "78";
    if (filePath.endsWith("/status")) return "Charging";
    if (filePath.endsWith("/voltage_now")) return "4098082";
    return "";
  },
  readThermalService: async () => thermalOutput,
  statfs: async () => ({ bavail: 100, bsize: 4096 }),
  freeMemory: () => 123456,
  systemUptime: () => 789,
  collectorUptime: () => 12,
  now: () => new Date("2026-10-23T01:02:03.000Z"),
  randomUuid: () => "12345678-1234-4234-8234-123456789abc",
});

assert.deepEqual(payload, {
  schema_version: 2,
  message_id: "12345678-1234-4234-8234-123456789abc",
  site_id: "home_site",
  gateway_id: "mobile",
  device_id: "pixel_health",
  read_time_utc: "2026-10-23T01:02:03.000Z",
  sample_time_utc: null,
  observation_kind: "direct_read",
  quality: "ok",
  metrics: {
    battery_temperature_c: 30.8,
    battery_pct: 78,
    charging: 1,
    battery_voltage_v: 4.098082,
    device_thermal_status: 2,
    storage_free_bytes: 409600,
    memory_available_bytes: 123456,
    system_uptime_seconds: 789,
    collector_uptime_seconds: 12,
  },
  source: {
    driver: "android-phone-health",
    metric_status: {},
  },
});

const unavailable = await collectPhoneHealth(config, {
  readText: async () => "",
  readThermalService: async () => "",
  statfs: async () => {
    throw new Error("unavailable");
  },
  freeMemory: () => Number.NaN,
  systemUptime: () => Number.NaN,
  collectorUptime: () => Number.NaN,
  now: () => new Date("2026-10-23T01:02:03.000Z"),
  randomUuid: () => "22345678-1234-4234-8234-123456789abc",
});
assert.deepEqual(unavailable.metrics, {});
assert.equal(Object.keys(unavailable.source.metric_status).length, 9);

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "phone-health-test-"),
);
try {
  let shouldFail = true;
  const delivered: unknown[] = [];
  const reporter = new PhoneHealthReporter(
    config,
    temporaryRoot,
    async (_topic, value) => {
      if (shouldFail) throw new Error("offline");
      delivered.push(value);
    },
    async () => payload,
  );
  await reporter.runOnce();
  const outbox = path.join(temporaryRoot, "phone-health-outbox");
  assert.equal(fs.readdirSync(outbox).length, 1);
  shouldFail = false;
  const restartedReporter = new PhoneHealthReporter(
    config,
    temporaryRoot,
    async (_topic, value) => delivered.push(value),
    async () => assert.fail("restart replay must not recollect old telemetry"),
  );
  await restartedReporter.replay();
  assert.equal(fs.readdirSync(outbox).length, 0);
  assert.equal(delivered.length, 1);
  assert.equal(
    (delivered[0] as typeof payload).message_id,
    payload.message_id,
  );
  assert.equal(
    (delivered[0] as typeof payload).read_time_utc,
    payload.read_time_utc,
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("phone health telemetry tests passed");
