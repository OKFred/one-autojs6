import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import { DeviceOpsExecutor, parseVolumeOutput } from "../src/ops-executor.js";
import {
  DeviceOpsFailure,
  OPS_MAX_ARTIFACT_BYTES,
  encodeDeviceOpsArtifactFrame,
  isDeviceOpsArtifact,
  parseDeviceOpsOpenSessionCommand,
  parseDeviceOpsRequest,
} from "../src/ops-protocol.js";
import { DeviceOpsSessionManager } from "../src/ops-session.js";
import { rejectedSubscriptionTopics } from "../src/utils/mqtt.js";

const now = Date.now();

/** Build the minimum PNG header needed by the screenshot validator. */
function screenshotPng(width = 1080, height = 2340): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value);
  value.writeUInt32BE(13, 8);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

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
const binaryCommands: string[] = [];
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
  runRootBinaryCommand: async (command) => {
    binaryCommands.push(command);
    return screenshotPng();
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
)) as {
  arbitraryShell: boolean;
  operations: string[];
  artifacts: { screenshot: { maxBytes: number; mimeTypes: string[] } };
};
assert.equal(capabilities.arbitraryShell, false);
assert.equal(capabilities.operations.includes("device.shell.exec"), false);
assert.equal(capabilities.operations.includes("device.screen.capture"), true);
assert.deepEqual(capabilities.artifacts.screenshot, {
  maxBytes: OPS_MAX_ARTIFACT_BYTES,
  mimeTypes: ["image/png"],
});

const screenshot = await executor.execute("device.screen.capture", {});
assert.equal(isDeviceOpsArtifact(screenshot), true);
if (!isDeviceOpsArtifact(screenshot)) throw new Error("Expected artifact");
assert.equal(binaryCommands[0], "nice -n 10 screencap -p");
assert.equal(screenshot.width, 1080);
assert.equal(screenshot.height, 2340);
assert.match(screenshot.sha256, /^[0-9a-f]{64}$/);
const artifactFrame = encodeDeviceOpsArtifactFrame(
  { sessionId: openCommand.sessionId, requestId: "request_12345678" },
  screenshot,
);
const headerLength = artifactFrame.readUInt32BE(0);
const artifactHeader = JSON.parse(
  artifactFrame.toString("utf8", 4, 4 + headerLength),
) as { requestId: string; sizeBytes: number; sha256: string };
assert.equal(artifactHeader.requestId, "request_12345678");
assert.equal(artifactHeader.sizeBytes, screenshot.content.byteLength);
assert.equal(artifactHeader.sha256, screenshot.sha256);
assert.deepEqual(artifactFrame.subarray(4 + headerLength), screenshot.content);

const oversizedExecutor = new DeviceOpsExecutor({
  fileRoots: [],
  sharedStateDirectory: stateRoot,
  runRootBinaryCommand: async () => Buffer.alloc(OPS_MAX_ARTIFACT_BYTES + 1),
});
await assert.rejects(
  () => oversizedExecutor.execute("device.screen.capture", {}),
  (error) =>
    error instanceof DeviceOpsFailure && error.code === "SCREENSHOT_TOO_LARGE",
);
const invalidScreenshotExecutor = new DeviceOpsExecutor({
  fileRoots: [],
  sharedStateDirectory: stateRoot,
  runRootBinaryCommand: async () => Buffer.from("not-a-png"),
});
await assert.rejects(
  () => invalidScreenshotExecutor.execute("device.screen.capture", {}),
  (error) =>
    error instanceof DeviceOpsFailure &&
    error.code === "SCREENSHOT_FORMAT_INVALID",
);
assert.deepEqual(
  rejectedSubscriptionTopics([
    { topic: "tasks", qos: 1 },
    { topic: "deploy", qos: 128 },
    { topic: "ops", qos: 1, reasonCode: 0 },
    { topic: "events", qos: 1, reasonCode: 0x87 },
  ]),
  ["deploy", "events"],
);

const android13Commands: string[] = [];
const android13Executor = new DeviceOpsExecutor({
  fileRoots: [{ id: "test-root", label: "Test", path: allowedRoot }],
  sharedStateDirectory: stateRoot,
  runRootCommand: async (command) => {
    android13Commands.push(command);
    if (command === "dumpsys activity activities") {
      return "topResumedActivity=ActivityRecord{abc u0 com.example.app/.MainActivity} t42}";
    }
    if (command === "dumpsys window windows") return "mTopFocusedDisplayId=0";
    if (command === "dumpsys connectivity") {
      return [
        "Active default network: 103",
        "  NetworkAgentInfo{network{102} ni{MOBILE[LTE] CONNECTED} lp{{DnsAddresses: [ /8.8.8.8 ]}} nc{[ Transports: CELLULAR Capabilities: INTERNET]}}",
        "  NetworkAgentInfo{network{103} ni{WIFI CONNECTED} lp{{DnsAddresses: [ /1.1.1.1,/2606:4700:4700::1111 ]}} nc{[ Transports: WIFI Capabilities: INTERNET&VALIDATED]}}",
      ].join("\n");
    }
    if (command === "ip -o addr show") return "1: lo inet 127.0.0.1/8";
    if (command === "ip route show") return "default via 192.168.1.1 dev wlan0";
    if (command === "getprop") return "";
    if (command === "cmd wifi status") {
      return 'WifiInfo: SSID: "TEST", BSSID: 00:11:22:33:44:55, IP: /192.168.1.2';
    }
    return "";
  },
  now: () => now,
});
const foreground = (await android13Executor.execute(
  "device.foreground.get",
  {},
)) as { packageName: string; activityClass: string };
assert.equal(foreground.packageName, "com.example.app");
assert.equal(foreground.activityClass, ".MainActivity");
const network = (await android13Executor.execute("device.network.get", {})) as {
  activeTransport: string;
  validated: boolean;
  dnsServers: string[];
  wifiSsid: string;
};
assert.equal(network.activeTransport, "wifi");
assert.equal(network.validated, true);
assert.deepEqual(network.dnsServers, ["1.1.1.1", "2606:4700:4700::1111"]);
assert.equal(network.wifiSsid, "TEST");
assert.equal(android13Commands.includes("cmd wifi status"), true);
assert.equal(android13Commands.includes("dumpsys wifi"), false);

const websocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise<void>((resolve, reject) => {
  websocketServer.once("listening", resolve);
  websocketServer.once("error", reject);
});
const websocketAddress = websocketServer.address();
if (!websocketAddress || typeof websocketAddress === "string") {
  throw new Error("Expected a TCP WebSocket test address");
}
const sessionNow = Date.now();
const sessionId = "session_screenshot12345678";
const responses: Array<Record<string, unknown>> = [];
let artifacts = 0;
const concurrentResult = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("Screenshot concurrency test timed out")),
    2_000,
  );
  websocketServer.once("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        artifacts += 1;
      } else {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "hello") {
          for (const suffix of ["first", "second"]) {
            socket.send(
              JSON.stringify({
                protocolVersion: 1,
                type: "request",
                sessionId,
                requestId: `request_${suffix}12345678`,
                operation: "device.screen.capture",
                params: {},
                createdAt: Date.now(),
                expiresAt: Date.now() + 15_000,
              }),
            );
          }
        } else if (frame.type === "response") {
          responses.push(frame);
        }
      }
      if (artifacts === 1 && responses.length === 2) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});
const sessionExecutor = new DeviceOpsExecutor({
  fileRoots: [],
  sharedStateDirectory: stateRoot,
  runRootBinaryCommand: async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return screenshotPng();
  },
});
const sessionManager = new DeviceOpsSessionManager({
  deviceId: "phone-001",
  reportToken: "device-report-token",
  allowedWsOrigins: [`ws://127.0.0.1:${websocketAddress.port}`],
  executor: sessionExecutor,
  isDeploymentBlocked: () => false,
  publishEvent: async () => undefined,
});
await sessionManager.handleOpenCommand({
  protocolVersion: 1,
  type: "OPEN_SESSION",
  sessionId,
  deviceId: "phone-001",
  wsUrl: `ws://127.0.0.1:${websocketAddress.port}/ops`,
  nonce: "nonce_screenshot12345678",
  issuedAt: sessionNow,
  expiresAt: sessionNow + 60_000,
});
await concurrentResult;
assert.equal(artifacts, 1);
assert.equal(
  responses.filter((response) => response.status === "SUCCESS").length,
  1,
);
assert.equal(
  responses.some(
    (response) =>
      response.status === "REJECTED" &&
      response.code === "OPS_CONCURRENCY_LIMIT",
  ),
  true,
);
await sessionManager.close(
  "TEST_COMPLETE",
  "Screenshot concurrency test complete",
);
await new Promise<void>((resolve, reject) => {
  websocketServer.close((error) => (error ? reject(error) : resolve()));
});

fs.rmSync(temporaryRoot, { recursive: true, force: true });
console.log("ops tests passed");
