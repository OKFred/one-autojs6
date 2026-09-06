import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import {
  DeviceOpsExecutor,
  OPS_MAX_BRIGHTNESS,
  OPS_MAX_FIND_DEVICE_DURATION_MS,
  OPS_MIN_BRIGHTNESS,
  parseBrightnessSettings,
  parseVolumeOutput,
} from "../src/ops-executor.js";
import {
  DeviceOpsFailure,
  OPS_MAX_ARTIFACT_BYTES,
  encodeDeviceOpsArtifactFrame,
  isDeviceOpsArtifact,
  parseDeviceOpsOpenSessionCommand,
  parseDeviceOpsRequest,
} from "../src/ops-protocol.js";
import {
  DeviceOpsSessionManager,
  isMutatingDeviceOpsOperation,
} from "../src/ops-session.js";
import {
  OPS_MAX_UI_DEPTH,
  OPS_MAX_UI_HIERARCHY_BYTES,
  OPS_MAX_UI_NODES,
  OPS_MAX_UI_TEXT_LENGTH,
  resolveUiTargetAt,
} from "../src/ui-target.js";
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
assert.equal(
  parseDeviceOpsRequest(
    {
      protocolVersion: 1,
      type: "request",
      sessionId: openCommand.sessionId,
      requestId: "request_brightness12345678",
      operation: "device.screen.brightness.set",
      params: { level: 128, mode: "manual" },
      createdAt: now,
      expiresAt: now + 10_000,
    },
    openCommand.sessionId,
  ).operation,
  "device.screen.brightness.set",
);
assert.deepEqual(parseVolumeOutput("volume is 7 in range [0..15]"), {
  current: 7,
  minimum: 0,
  maximum: 15,
});
assert.deepEqual(parseBrightnessSettings("31", "1"), {
  level: 31,
  percent: 12,
  mode: "automatic",
});
assert.equal(isMutatingDeviceOpsOperation("device.audio.get"), false);
assert.equal(
  isMutatingDeviceOpsOperation("device.screen.brightness.get"),
  false,
);
assert.equal(
  isMutatingDeviceOpsOperation("device.screen.brightness.set"),
  true,
);
assert.equal(isMutatingDeviceOpsOperation("device.alert.find"), true);
assert.equal(isMutatingDeviceOpsOperation("device.ui.target-at"), false);

const uiHierarchyFixture = [
  "UI hierchary dumped to: /data/local/tmp/one-autojs6-ui-test.xml",
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<hierarchy rotation="0">',
  '  <node index="0" package="com.example.messages" class="android.widget.FrameLayout" clickable="false" bounds="[0,0][1080,2340]">',
  '    <node index="0" package="com.example.messages" class="android.widget.Button" resource-id="com.example.messages:id/conversation" clickable="true" bounds="[100,200][500,400]">',
  '      <node index="0" package="com.example.messages" class="android.widget.TextView" text="FixtureContact 10000000000" clickable="false" bounds="[120,220][480,380]" />',
  "    </node>",
  '    <node index="1" package="com.example.messages" class="android.widget.Button" resource-id="com.example.messages:id/open_messages" clickable="true" bounds="[500,200][900,400]">',
  '      <node index="0" package="com.example.messages" class="android.widget.TextView" text="短信" clickable="false" bounds="[520,220][880,380]" />',
  "    </node>",
  '    <node index="2" package="com.example.messages" class="android.widget.EditText" resource-id="com.example.messages:id/compose_message_text" text="fixture-private-text" editable="true" clickable="true" bounds="[100,1800][800,2000]" />',
  '    <node index="3" package="com.example.messages" class="android.widget.Button" resource-id="com.example.messages:id/send_message_button" text="发送" content-desc="发送给 00000" clickable="true" bounds="[800,1800][1040,2000]" />',
  '    <node index="4" package="com.example.messages" class="android.widget.Button" clickable="true" bounds="[100,500][500,700]">',
  '      <node index="0" package="com.example.messages" class="android.widget.TextView" resource-id="com.example.messages:id/conversation_label" text="FixtureContact" clickable="false" bounds="[120,520][480,680]" />',
  "    </node>",
  "  </node>",
  "</hierarchy>",
].join("\n");
const uiActivityFixture =
  "topResumedActivity=ActivityRecord{abc u0 com.example.messages/.MainActivity} t42}";
const uiWindowsFixture =
  "mCurrentFocus=Window{abc u0 com.example.messages/com.example.messages.MainActivity}";

const promotedUiTarget = resolveUiTargetAt(
  uiHierarchyFixture,
  uiActivityFixture,
  uiWindowsFixture,
  "Physical size: 1080x2340",
  { x: 100, y: 150, screenWidth: 540, screenHeight: 1170 },
  now,
);
assert.equal(promotedUiTarget.target?.resourceId, "com.example.messages:id/conversation");
assert.equal(promotedUiTarget.target?.clickable, true);
assert.equal(promotedUiTarget.target?.confidence, "exact-resource-id");
assert.equal(promotedUiTarget.target?.text, undefined);
assert.deepEqual(promotedUiTarget.foreground, {
  packageName: "com.example.messages",
  activityName: "com.example.messages.MainActivity",
});
assert.deepEqual(promotedUiTarget.display, { width: 1080, height: 2340 });
assert.equal(JSON.stringify(promotedUiTarget).includes("10000000000"), false);

const labelledAncestorTarget = resolveUiTargetAt(
  uiHierarchyFixture,
  uiActivityFixture,
  uiWindowsFixture,
  "Physical size: 1080x2340",
  { x: 350, y: 150, screenWidth: 540, screenHeight: 1170 },
  now,
);
assert.equal(
  labelledAncestorTarget.target?.resourceId,
  "com.example.messages:id/open_messages",
);
assert.equal(labelledAncestorTarget.target?.text, undefined);
assert.equal(labelledAncestorTarget.target?.clickable, true);

const sameNodeIdentityTarget = resolveUiTargetAt(
  uiHierarchyFixture,
  uiActivityFixture,
  uiWindowsFixture,
  "Physical size: 1080x2340",
  { x: 150, y: 300, screenWidth: 540, screenHeight: 1170 },
  now,
);
assert.equal(
  sameNodeIdentityTarget.target?.resourceId,
  "com.example.messages:id/conversation_label",
);
assert.equal(
  sameNodeIdentityTarget.target?.className,
  "android.widget.TextView",
);
assert.deepEqual(sameNodeIdentityTarget.target?.bounds, {
  left: 120,
  top: 520,
  right: 480,
  bottom: 680,
  screenWidth: 1080,
  screenHeight: 2340,
});
assert.equal(sameNodeIdentityTarget.target?.clickable, false);
assert.deepEqual(sameNodeIdentityTarget.target?.text, {
  mode: "redacted",
  category: "unreviewed-content",
  length: 14,
});
assert.equal(JSON.stringify(sameNodeIdentityTarget).includes("FixtureContact"), false);

const editableUiTarget = resolveUiTargetAt(
  uiHierarchyFixture,
  uiActivityFixture,
  uiWindowsFixture,
  "Override size: 1080x2340",
  { x: 225, y: 950, screenWidth: 540, screenHeight: 1170 },
  now,
);
assert.deepEqual(editableUiTarget.target?.text, {
  mode: "parameter",
  key: "ui.compose_message_text",
});
assert.equal(editableUiTarget.target?.editable, true);
assert.equal(JSON.stringify(editableUiTarget).includes("fixture-private-text"), false);

const sendUiTarget = resolveUiTargetAt(
  uiHierarchyFixture,
  uiActivityFixture,
  uiWindowsFixture,
  "Physical size: 1080x2340",
  { x: 460, y: 950, screenWidth: 540, screenHeight: 1170 },
  now,
);
assert.deepEqual(sendUiTarget.target?.text, {
  mode: "literal",
  value: "发送",
  reviewed: true,
});
assert.deepEqual(sendUiTarget.target?.description, {
  mode: "redacted",
  category: "numeric-content",
  length: 9,
});
assert.equal(JSON.stringify(sendUiTarget).includes("00000"), false);

const noUiTarget = resolveUiTargetAt(
  '<hierarchy rotation="0"></hierarchy>',
  uiActivityFixture,
  uiWindowsFixture,
  "Physical size: 1080x2340",
  { x: 539, y: 1169, screenWidth: 540, screenHeight: 1170 },
  now,
);
assert.equal(noUiTarget.target, null);
assert.deepEqual(noUiTarget.display, { width: 1080, height: 2340 });
const orientationMismatchTarget = resolveUiTargetAt(
  uiHierarchyFixture,
  uiActivityFixture,
  uiWindowsFixture,
  "Physical size: 1080x2340",
  { x: 568, y: 264, screenWidth: 1136, screenHeight: 528 },
  now,
);
assert.equal(orientationMismatchTarget.target, null);
assert.deepEqual(orientationMismatchTarget.foreground, {
  packageName: "com.example.messages",
  activityName: "com.example.messages.MainActivity",
});
assert.deepEqual(orientationMismatchTarget.display, {
  width: 1080,
  height: 2340,
});
assert.throws(() =>
  resolveUiTargetAt(
    "<hierarchy><node bounds=\"[0,0][10,10]\"></hierarchy>",
    "",
    "",
    "",
    { x: 1, y: 1, screenWidth: 10, screenHeight: 10 },
    now,
  ),
);
assert.throws(() =>
  resolveUiTargetAt(
    `<hierarchy><node text="${"x".repeat(OPS_MAX_UI_TEXT_LENGTH + 1)}" bounds="[0,0][10,10]" /></hierarchy>`,
    "",
    "",
    "",
    { x: 1, y: 1, screenWidth: 10, screenHeight: 10 },
    now,
  ),
);
assert.throws(() =>
  resolveUiTargetAt(
    `<hierarchy>${'<node bounds="[0,0][10,10]">'.repeat(OPS_MAX_UI_DEPTH + 1)}${"</node>".repeat(OPS_MAX_UI_DEPTH + 1)}</hierarchy>`,
    "",
    "",
    "",
    { x: 1, y: 1, screenWidth: 10, screenHeight: 10 },
    now,
  ),
);
assert.throws(() =>
  resolveUiTargetAt(
    `<hierarchy>${'<node bounds="[0,0][10,10]" />'.repeat(OPS_MAX_UI_NODES + 1)}</hierarchy>`,
    "",
    "",
    "",
    { x: 1, y: 1, screenWidth: 10, screenHeight: 10 },
    now,
  ),
);
assert.throws(() =>
  resolveUiTargetAt(
    `<hierarchy>${" ".repeat(OPS_MAX_UI_HIERARCHY_BYTES)}</hierarchy>`,
    "",
    "",
    "",
    { x: 1, y: 1, screenWidth: 10, screenHeight: 10 },
    now,
  ),
);

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
let brightness = 31;
let brightnessMode = 1;
const commands: string[] = [];
const binaryCommands: string[] = [];
const executor = new DeviceOpsExecutor({
  fileRoots: [{ id: "test-root", label: "Test", path: allowedRoot }],
  sharedStateDirectory: stateRoot,
  runRootCommand: async (command) => {
    commands.push(command);
    if (command.includes("--get"))
      return `volume is ${volume} in range [0..15]`;
    if (command === "settings get system screen_brightness") {
      return String(brightness);
    }
    if (command === "settings get system screen_brightness_mode") {
      return String(brightnessMode);
    }
    const nextBrightness = /settings put system screen_brightness (\d+)$/.exec(
      command,
    )?.[1];
    if (nextBrightness) brightness = Number(nextBrightness);
    const nextBrightnessMode =
      /settings put system screen_brightness_mode ([01])$/.exec(command)?.[1];
    if (nextBrightnessMode) brightnessMode = Number(nextBrightnessMode);
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
const previousBrightness = await executor.execute(
  "device.screen.brightness.get",
  {},
);
assert.deepEqual(previousBrightness, {
  level: 31,
  percent: 12,
  mode: "automatic",
});
const changedBrightness = (await executor.execute(
  "device.screen.brightness.set",
  { level: 128, mode: "manual" },
)) as {
  previous: { level: number; mode: string };
  current: { level: number; mode: string };
};
assert.equal(changedBrightness.previous.level, 31);
assert.equal(changedBrightness.current.level, 128);
assert.equal(changedBrightness.current.mode, "manual");
await assert.rejects(
  () =>
    executor.execute("device.screen.brightness.set", {
      level: OPS_MIN_BRIGHTNESS - 1,
    }),
  (error) =>
    error instanceof DeviceOpsFailure &&
    error.code === "BRIGHTNESS_LEVEL_OUT_OF_RANGE",
);
await assert.rejects(
  () =>
    executor.execute("device.screen.brightness.set", {
      level: OPS_MAX_BRIGHTNESS + 1,
    }),
  (error) =>
    error instanceof DeviceOpsFailure &&
    error.code === "BRIGHTNESS_LEVEL_OUT_OF_RANGE",
);
await assert.rejects(
  () =>
    executor.execute("device.screen.brightness.set", {
      mode: "adaptive",
    }),
  (error) =>
    error instanceof DeviceOpsFailure &&
    error.code === "BRIGHTNESS_MODE_INVALID",
);
await assert.rejects(
  () => executor.execute("device.screen.brightness.get", { raw: true }),
  (error) =>
    error instanceof DeviceOpsFailure &&
    error.code === "OPERATION_PARAMS_INVALID",
);
let rollbackBrightnessMode = 1;
const rollbackCommands: string[] = [];
const rollbackExecutor = new DeviceOpsExecutor({
  fileRoots: [],
  sharedStateDirectory: stateRoot,
  runRootCommand: async (command) => {
    rollbackCommands.push(command);
    if (command === "settings get system screen_brightness") return "31";
    if (command === "settings get system screen_brightness_mode") {
      return String(rollbackBrightnessMode);
    }
    const nextMode =
      /settings put system screen_brightness_mode ([01])$/.exec(command)?.[1];
    if (nextMode) {
      rollbackBrightnessMode = Number(nextMode);
      return "";
    }
    if (command === "settings put system screen_brightness 128") {
      throw new Error("simulated write failure");
    }
    return "";
  },
});
await assert.rejects(
  () =>
    rollbackExecutor.execute("device.screen.brightness.set", {
      level: 128,
      mode: "manual",
    }),
  (error) =>
    error instanceof DeviceOpsFailure && error.code === "BRIGHTNESS_SET_FAILED",
);
assert.equal(rollbackBrightnessMode, 1);
assert.equal(
  rollbackCommands.includes("settings put system screen_brightness_mode 1"),
  true,
);
const findAlert = (await executor.execute("device.alert.find", {
  durationMs: 750,
})) as {
  notificationPosted: boolean;
  vibrationStarted: boolean;
  audible: boolean;
  dndSettingChanged: boolean;
};
assert.equal(findAlert.notificationPosted, true);
assert.equal(findAlert.vibrationStarted, true);
assert.equal(findAlert.audible, false);
assert.equal(findAlert.dndSettingChanged, false);
await assert.rejects(
  () =>
    executor.execute("device.alert.find", {
      durationMs: OPS_MAX_FIND_DEVICE_DURATION_MS + 1,
    }),
  (error) =>
    error instanceof DeviceOpsFailure &&
    error.code === "FIND_DEVICE_DURATION_OUT_OF_RANGE",
);
await assert.rejects(
  () =>
    executor.execute("device.alert.find", { durationMs: 750, sound: true }),
  (error) =>
    error instanceof DeviceOpsFailure &&
    error.code === "OPERATION_PARAMS_INVALID",
);
const failedAlertExecutor = new DeviceOpsExecutor({
  fileRoots: [],
  sharedStateDirectory: stateRoot,
  runRootCommand: async () => {
    throw new Error("simulated Android command failure");
  },
});
await assert.rejects(
  () => failedAlertExecutor.execute("device.alert.find", {}),
  (error) =>
    error instanceof DeviceOpsFailure &&
    error.code === "FIND_DEVICE_ALERT_FAILED",
);
assert.equal(
  commands.some((command) => command.includes(";")),
  false,
);
assert.equal(
  commands.includes(
    "cmd notification post -t 'One AutoJS6' one-autojs6-find-device 'Find-device request received'",
  ),
  true,
);
assert.equal(
  commands.includes(
    "cmd vibrator_manager synced -f -d one-autojs6-find-device oneshot 750",
  ),
  true,
);
assert.equal(
  commands.some((command) =>
    /zen_mode|notification_policy_access|dnd/i.test(command),
  ),
  false,
);

const capabilities = (await executor.execute(
  "device.ops.capabilities",
  {},
)) as {
  arbitraryShell: boolean;
  operations: string[];
  artifacts: { screenshot: { maxBytes: number; mimeTypes: string[] } };
  findDevice: { audible: boolean; changesDoNotDisturb: boolean };
  uiTargetAt: {
    returnsHierarchy: boolean;
    maxHierarchyBytes: number;
    maxNodes: number;
    maxDepth: number;
    maxTextLength: number;
  };
};
assert.equal(capabilities.arbitraryShell, false);
assert.equal(capabilities.operations.includes("device.shell.exec"), false);
assert.equal(capabilities.operations.includes("device.screen.capture"), true);
assert.equal(
  capabilities.operations.includes("device.screen.brightness.set"),
  true,
);
assert.equal(capabilities.operations.includes("device.telephony.get"), true);
assert.equal(capabilities.operations.includes("device.alert.find"), true);
assert.equal(capabilities.findDevice.audible, false);
assert.equal(capabilities.findDevice.changesDoNotDisturb, false);
assert.equal(capabilities.uiTargetAt.returnsHierarchy, false);
assert.equal(capabilities.uiTargetAt.maxHierarchyBytes, OPS_MAX_UI_HIERARCHY_BYTES);
assert.equal(capabilities.uiTargetAt.maxNodes, OPS_MAX_UI_NODES);
assert.equal(capabilities.uiTargetAt.maxDepth, OPS_MAX_UI_DEPTH);
assert.equal(capabilities.uiTargetAt.maxTextLength, OPS_MAX_UI_TEXT_LENGTH);
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
const telephonyRegistryFixture = [
  "Phone Id=0",
  "  mServiceState={mVoiceRegState=0(IN_SERVICE), mDataRegState=0(IN_SERVICE), mOperatorAlphaLong=Example Carrier, mOperatorAlphaShort=Example, getRilVoiceRadioTechnology=14(LTE), getRilDataRadioTechnology=14(LTE), mIsEmergencyOnly=false, mIsDataRoamingFromRegistration=false}",
  "  mSignalStrength=SignalStrength:{mLte=CellSignalStrengthLte: rssi=-65 rsrp=-100 rsrq=-17 rssnr=-2 level=3,mNr=CellSignalStrengthNr:{ csiRsrp = 2147483647 csiRsrq = 2147483647 ssRsrp = 2147483647 ssRsrq = 2147483647 ssSinr = 2147483647 level = 0 },primary=CellSignalStrengthLte}",
  "  mDataConnectionState=2",
].join("\n");
const subscriptionFixture =
  "{id=7 iccId=00000000000000000000 simSlotIndex=0 displayName=Work 20000000000 SIM carrierName=Example Carrier number=10000000000 dataRoaming=0 mcc=460 mnc=01 countryIso=cn isEmbedded=false imsi=000000000000001 imei=000000000000002}";
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
    if (command === "ip -o addr show") {
      return [
        "1: lo    inet 127.0.0.1/8 scope host lo",
        "2: wlan0    inet 192.168.1.2/24 scope global wlan0",
        "2: wlan0    inet6 fe80::1234/64 scope link",
      ].join("\n");
    }
    if (command === "ip route show") return "default via 192.168.1.1 dev wlan0";
    if (command === "getprop") return "";
    if (command === "getprop gsm.sim.state") return "LOADED";
    if (command === "dumpsys telephony.registry") {
      return telephonyRegistryFixture;
    }
    if (command === "dumpsys isub") return subscriptionFixture;
    if (command === "cmd wifi status") {
      return [
        "Wi-Fi is enabled",
        'Wifi is connected to "TEST"',
        'WifiInfo: SSID: "TEST", BSSID: 00:11:22:33:44:55, IP: /192.168.1.2, Wi-Fi standard: 5, RSSI: -36, Link speed: 65Mbps, Tx Link speed: 65Mbps, Rx Link speed: 72Mbps, Frequency: 2412MHz',
      ].join("\n");
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

const uiCommands: string[] = [];
const uiExecutor = new DeviceOpsExecutor({
  fileRoots: [],
  sharedStateDirectory: stateRoot,
  runRootCommand: async (command) => {
    uiCommands.push(command);
    if (command.startsWith("uiautomator dump --compressed ")) return "dumped";
    if (command.startsWith("cat /data/local/tmp/one-autojs6-ui-")) {
      return uiHierarchyFixture;
    }
    if (command === "dumpsys activity activities") return uiActivityFixture;
    if (command === "dumpsys window windows") return uiWindowsFixture;
    if (command === "wm size") return "Physical size: 1080x2340";
    return "";
  },
  now: () => now,
});
const executedUiTarget = (await uiExecutor.execute("device.ui.target-at", {
  x: 460,
  y: 950,
  screenWidth: 540,
  screenHeight: 1170,
})) as { target: { resourceId?: string } | null };
assert.equal(
  executedUiTarget.target?.resourceId,
  "com.example.messages:id/send_message_button",
);
assert.match(uiCommands[0], /^uiautomator dump --compressed \/data\/local\/tmp\/one-autojs6-ui-[a-f0-9]{32}\.xml$/);
const temporaryUiPath = uiCommands[0].split(" ").at(-1);
assert.equal(uiCommands[1], `cat ${temporaryUiPath}`);
assert.equal(uiCommands[2], `rm -f ${temporaryUiPath}`);
assert.equal(uiCommands.some((command) => command.includes("460")), false);
await assert.rejects(
  () =>
    uiExecutor.execute("device.ui.target-at", {
      x: 540,
      y: 0,
      screenWidth: 540,
      screenHeight: 1170,
    }),
  (error) =>
    error instanceof DeviceOpsFailure &&
    error.code === "UI_TARGET_COORDINATES_INVALID" &&
    error.status === "REJECTED",
);
const failedUiCommands: string[] = [];
const failedUiExecutor = new DeviceOpsExecutor({
  fileRoots: [],
  sharedStateDirectory: stateRoot,
  runRootCommand: async (command) => {
    failedUiCommands.push(command);
    if (command.startsWith("cat ")) throw new Error("simulated read failure");
    return "";
  },
});
await assert.rejects(
  () =>
    failedUiExecutor.execute("device.ui.target-at", {
      x: 1,
      y: 1,
      screenWidth: 10,
      screenHeight: 10,
    }),
  (error) =>
    error instanceof DeviceOpsFailure &&
    error.code === "UI_HIERARCHY_DUMP_FAILED",
);
assert.match(failedUiCommands.at(-1) || "", /^rm -f \/data\/local\/tmp\/one-autojs6-ui-/);
const network = (await android13Executor.execute("device.network.get", {})) as {
  activeTransport: string;
  validated: boolean;
  dnsServers: string[];
  wifiSsid: string;
  networkInterfaces: Array<{
    name: string;
    addresses: Array<{ address: string }>;
  }>;
  wifi: { enabled: boolean; rssiDbm: number; linkSpeedMbps: number };
  cellular: {
    available: boolean;
    slots: Array<{
      slotIndex: number;
      signal: { lte: { rsrpDbm: number; level: number } };
    }>;
  };
};
assert.equal(network.activeTransport, "wifi");
assert.equal(network.validated, true);
assert.deepEqual(network.dnsServers, ["1.1.1.1", "2606:4700:4700::1111"]);
assert.equal(network.wifiSsid, "TEST");
assert.equal(network.networkInterfaces[1].name, "wlan0");
assert.equal(network.networkInterfaces[1].addresses[0].address, "192.168.1.2");
assert.equal(network.wifi.enabled, true);
assert.equal(network.wifi.rssiDbm, -36);
assert.equal(network.wifi.linkSpeedMbps, 65);
assert.equal(network.cellular.available, true);
assert.equal(network.cellular.slots[0].signal.lte.rsrpDbm, -100);
assert.equal(network.cellular.slots[0].signal.lte.level, 3);
assert.equal(android13Commands.includes("cmd wifi status"), true);
assert.equal(android13Commands.includes("dumpsys wifi"), false);

const telephony = (await android13Executor.execute(
  "device.telephony.get",
  {},
)) as {
  available: boolean;
  sensitiveIdentifiersIncluded: boolean;
  subscriptions: Array<{
    subscriptionId: number;
    slotIndex: number;
    simState: string;
    displayName: string;
    phoneNumber: { availability: string; masked: string };
    signal: { lte: { rsrpDbm: number }; nr: null };
  }>;
};
assert.equal(telephony.available, true);
assert.equal(telephony.sensitiveIdentifiersIncluded, false);
assert.equal(telephony.subscriptions[0].subscriptionId, 7);
assert.equal(telephony.subscriptions[0].slotIndex, 0);
assert.equal(telephony.subscriptions[0].simState, "LOADED");
assert.equal(
  telephony.subscriptions[0].displayName,
  "Work [redacted-number] SIM",
);
assert.equal(telephony.subscriptions[0].phoneNumber.availability, "available");
assert.equal(telephony.subscriptions[0].phoneNumber.masked, "***0000");
assert.equal(telephony.subscriptions[0].signal.lte.rsrpDbm, -100);
assert.equal(telephony.subscriptions[0].signal.nr, null);
await assert.rejects(
  () => android13Executor.execute("device.telephony.get", { raw: true }),
  (error) =>
    error instanceof DeviceOpsFailure &&
    error.code === "OPERATION_PARAMS_INVALID",
);
const serializedTelephony = JSON.stringify(telephony);
for (const forbidden of [
  "iccId",
  "imsi",
  "imei",
  "00000000000000000000",
  "000000000000001",
  "000000000000002",
  "10000000000",
  "20000000000",
]) {
  assert.equal(serializedTelephony.includes(forbidden), false);
}

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

const blockedEvents: DeviceOpsSessionEvent[] = [];
const remoteBlockedManager = new DeviceOpsSessionManager({
  deviceId: "phone-001",
  reportToken: "device-report-token",
  allowedWsOrigins: ["ws://127.0.0.1:39001"],
  executor: sessionExecutor,
  isDeploymentBlocked: () => false,
  isRemoteControlBlocked: () => true,
  publishEvent: async (event) => {
    blockedEvents.push(event);
  },
});
await remoteBlockedManager.handleOpenCommand({
  protocolVersion: 1,
  type: "OPEN_SESSION",
  sessionId: "session_remote_blocked",
  deviceId: "phone-001",
  wsUrl: "ws://127.0.0.1:39001/ops",
  nonce: "nonce_remote_blocked12345678",
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
});
assert.equal(blockedEvents.length, 1);
assert.equal(blockedEvents[0].status, "REJECTED");
assert.equal(blockedEvents[0].code, "REMOTE_SESSION_ACTIVE");

await new Promise<void>((resolve, reject) => {
  websocketServer.close((error) => (error ? reject(error) : resolve()));
});

fs.rmSync(temporaryRoot, { recursive: true, force: true });
console.log("ops tests passed");
