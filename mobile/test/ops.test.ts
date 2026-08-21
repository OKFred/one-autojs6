import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DeviceOpsExecutor, parseVolumeOutput } from "../src/ops-executor.js";
import {
  DeviceOpsFailure,
  parseDeviceOpsOpenSessionCommand,
  parseDeviceOpsRequest,
} from "../src/ops-protocol.js";

const now = Date.now();
const openCommand = parseDeviceOpsOpenSessionCommand({
  protocolVersion: 1,
  type: "OPEN_SESSION",
  sessionId: "session_12345678",
  deviceId: "phone-001",
  wsUrl:
    "wss://hodor.this-time.com/api/v1/admin/mobile/device-ops/ws/session_12345678",
  nonce: "nonce_12345678",
  issuedAt: now,
  expiresAt: now + 600_000,
});
assert.equal(openCommand.sessionId, "session_12345678");

assert.throws(
  () =>
    parseDeviceOpsOpenSessionCommand({
      ...openCommand,
      wsUrl: "wss://hodor.this-time.com/path?token=secret",
    }),
  /must not contain credentials or query data/,
);
assert.throws(
  () =>
    parseDeviceOpsRequest(
      {
        protocolVersion: 1,
        type: "request",
        sessionId: openCommand.sessionId,
        requestId: "request_12345678",
        operation: "device.shell.exec",
        params: { command: "id" },
        createdAt: now,
        expiresAt: now + 10_000,
      },
      openCommand.sessionId,
    ),
  /Invalid ops request envelope/,
);
assert.deepEqual(parseVolumeOutput("volume is 7 in range [0..15]"), {
  current: 7,
  minimum: 0,
  maximum: 15,
});

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "one-autojs6-ops-"),
);
const allowedRoot = path.join(temporaryRoot, "allowed");
const outsideRoot = path.join(temporaryRoot, "outside");
const stateRoot = path.join(temporaryRoot, "state");
fs.mkdirSync(allowedRoot);
fs.mkdirSync(outsideRoot);
fs.writeFileSync(path.join(allowedRoot, "example.txt"), "ok");
fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "secret");

let volume = 7;
const commands: string[] = [];
const executor = new DeviceOpsExecutor({
  fileRoots: [{ id: "test-root", label: "Test", path: allowedRoot }],
  sharedStateDirectory: stateRoot,
  runRootCommand: async (command) => {
    commands.push(command);
    if (command.includes("--get"))
      return `volume is ${volume} in range [0..15]`;
    const next = /--set (\d+)$/.exec(command)?.[1];
    if (next) volume = Number(next);
    return "";
  },
  now: () => now,
});

const listing = (await executor.execute("device.files.list", {
  rootId: "test-root",
  path: "",
})) as { entries: Array<{ name: string }> };
assert.deepEqual(
  listing.entries.map((entry) => entry.name),
  ["example.txt"],
);

await assert.rejects(
  () =>
    executor.execute("device.files.list", {
      rootId: "test-root",
      path: "../outside",
    }),
  (error) =>
    error instanceof DeviceOpsFailure && error.code === "FILE_PATH_UNSAFE",
);

await executor.execute("device.audio.mute", { stream: "media" });
assert.equal(volume, 0);
await executor.execute("device.audio.unmute", { stream: "media" });
assert.equal(volume, 7);
assert.equal(
  commands.some((command) => command.includes(";")),
  false,
);

const capabilities = (await executor.execute(
  "device.ops.capabilities",
  {},
)) as { arbitraryShell: boolean; operations: string[] };
assert.equal(capabilities.arbitraryShell, false);
assert.equal(capabilities.operations.includes("device.shell.exec"), false);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
console.log("ops tests passed");
