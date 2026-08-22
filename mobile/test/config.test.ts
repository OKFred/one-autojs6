import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, resolveReportChannels } from "../src/config.js";

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

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "autojs6-config-test-"),
);
const configPath = path.join(temporaryRoot, "config.json");
const previousConfigPath = process.env.AUTOJS6_CONFIG_PATH;
try {
  fs.writeFileSync(
    configPath,
    JSON.stringify({ security: { allowedScriptIds: ["device.apps.list"] } }),
  );
  process.env.AUTOJS6_CONFIG_PATH = configPath;
  const allowed = loadConfig().config.security.allowedScriptIds;
  assert.equal(allowed.includes("device.network.routing.apply"), true);
  assert.equal(allowed.includes("device.network.routing.disable"), true);
} finally {
  if (previousConfigPath === undefined) delete process.env.AUTOJS6_CONFIG_PATH;
  else process.env.AUTOJS6_CONFIG_PATH = previousConfigPath;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("config reporting channel tests passed");
