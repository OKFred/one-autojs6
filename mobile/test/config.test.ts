import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CONFIG,
  loadConfig,
  resolveReportChannels,
} from "../src/config.js";

assert.deepEqual(resolveReportChannels("mqtt"), {
  mqtt: true,
  http: false,
});
assert.deepEqual(
  resolveReportChannels("mqtt", "https://hodor.example.test/report"),
  {
    mqtt: true,
    http: true,
  },
);
assert.deepEqual(resolveReportChannels("http"), {
  mqtt: false,
  http: true,
});
assert.deepEqual(resolveReportChannels("both"), {
  mqtt: true,
  http: true,
});

assert.equal(DEFAULT_CONFIG.phoneHealthTelemetry.enabled, false);

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "autojs6-config-test-"),
);
const configPath = path.join(temporaryRoot, "config.json");
const previousConfigPath = process.env.AUTOJS6_CONFIG_PATH;
try {
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      security: { allowedScriptIds: ["device.apps.list"] },
      remoteControl: {
        enabled: true,
        allowedRelayOrigins: [
          "wss://relay.example.test",
          "ws://127.0.0.1:39001",
          "ws://localhost:39001",
          "wss://relay.example.test/path",
        ],
        localScrcpyUrl: "ws://192.0.2.10:8886/",
      },
      phoneHealthTelemetry: {
        enabled: true,
        siteId: "home_site",
        gatewayId: "mobile",
        deviceId: "pixel_health",
        intervalSeconds: 1,
        outboxLimit: 5000,
      },
    }),
  );
  process.env.AUTOJS6_CONFIG_PATH = configPath;
  const loaded = loadConfig().config;
  const allowed = loaded.security.allowedScriptIds;
  assert.equal(allowed.includes("device.network.routing.apply"), true);
  assert.equal(allowed.includes("device.network.routing.disable"), true);
  assert.equal(loaded.remoteControl.enabled, true);
  assert.deepEqual(loaded.remoteControl.allowedRelayOrigins, [
    "wss://relay.example.test",
    "ws://127.0.0.1:39001",
  ]);
  assert.equal(loaded.remoteControl.localScrcpyUrl, "ws://127.0.0.1:8886/");
  assert.deepEqual(loaded.phoneHealthTelemetry, {
    enabled: true,
    siteId: "home_site",
    gatewayId: "mobile",
    deviceId: "pixel_health",
    intervalSeconds: 60,
    outboxLimit: 1440,
  });
} finally {
  if (previousConfigPath === undefined) delete process.env.AUTOJS6_CONFIG_PATH;
  else process.env.AUTOJS6_CONFIG_PATH = previousConfigPath;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("config reporting channel tests passed");
