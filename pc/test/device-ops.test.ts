import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import WebSocket, { type RawData, WebSocketServer } from "ws";

import {
  parseDeviceOpsArtifactFrame,
  parseDeviceOpsCreateInput,
  parseDeviceOpsResponse,
  parseDeviceUiTargetAtResult,
  type DeviceOpsOpenSessionCommand,
} from "../src/device-ops-protocol.js";
import {
  createDeviceOpsWebSocketEndpoint,
  DEVICE_OPS_SUBPROTOCOL,
  isValidDeviceOpsAuthorization,
  resolveDeviceOpsWebSocketConfig,
} from "../src/device-ops-websocket.js";
import { DeviceOpsService } from "../src/service/device-ops.service.js";
import { attachWebSocketUpgradeRouter } from "../src/websocket-upgrade-router.js";

/**
 * Start an HTTP server on an ephemeral loopback port.
 *
 * @param server Server to start.
 * @returns The allocated TCP port.
 */
async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP port");
  }
  return address.port;
}

/**
 * Resolve when a WebSocket opens, or reject on its first connection error.
 *
 * @param socket Client WebSocket.
 * @returns A promise settled by the connection attempt.
 */
function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

/**
 * Read exactly one WebSocket message.
 *
 * @param socket Connected client WebSocket.
 * @returns The next raw message and binary marker.
 */
function readMessage(
  socket: WebSocket,
): Promise<{ data: RawData; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => resolve({ data, isBinary }));
    socket.once("error", reject);
  });
}

/**
 * Poll an in-memory task until it becomes terminal.
 *
 * @param service Isolated gateway under test.
 * @param taskId Task identifier to poll.
 * @returns The terminal task view.
 */
async function waitForTerminalTask(
  service: DeviceOpsService,
  taskId: string,
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const task = service.getTask(taskId);
    if (task && task.status !== "EXECUTING") return task;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Device operations task did not become terminal");
}

/**
 * Close a client WebSocket without leaving an open test handle.
 *
 * @param socket Client WebSocket to close.
 * @returns A promise resolved once the socket is closed.
 */
async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  socket.close();
  await closed;
}

/**
 * Close a no-server WebSocket server.
 *
 * @param server WebSocket server to close.
 * @returns A promise resolved after all clients have closed.
 */
async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("device operation parsing enforces the new diagnostic parameter contracts", () => {
  assert.deepEqual(
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.ui.target-at",
      params: { x: 264, y: 568, screenWidth: 528, screenHeight: 1136 },
    }).params,
    { x: 264, y: 568, screenWidth: 528, screenHeight: 1136 },
  );
  assert.throws(() =>
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.ui.target-at",
      params: { x: 264, y: 568, screenWidth: 528 },
    }),
  );
  assert.throws(() =>
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.ui.target-at",
      params: {
        x: 528,
        y: 568,
        screenWidth: 528,
        screenHeight: 1136,
      },
    }),
  );
  assert.throws(() =>
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.ui.target-at",
      params: {
        x: 10.5,
        y: 10,
        screenWidth: 528,
        screenHeight: 1136,
      },
    }),
  );
  assert.throws(() =>
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.ui.target-at",
      params: {
        x: 10,
        y: 10,
        screenWidth: 528,
        screenHeight: 1136,
        command: "uiautomator dump",
      },
    }),
  );
  assert.deepEqual(
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.screen.brightness.get",
    }).params,
    {},
  );
  assert.deepEqual(
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.screen.brightness.set",
      params: { level: 128, mode: "manual" },
    }).params,
    { level: 128, mode: "manual" },
  );
  assert.throws(() =>
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.screen.brightness.set",
      params: {},
    }),
  );
  assert.throws(() =>
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.screen.brightness.set",
      params: { level: 0 },
    }),
  );
  assert.deepEqual(
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.telephony.get",
    }).params,
    {},
  );
  assert.deepEqual(
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.network.get",
    }).params,
    {},
  );
  assert.deepEqual(
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.alert.find",
    }).params,
    { durationMs: 2000 },
  );
  assert.deepEqual(
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.audio.set",
      params: { stream: "ring", level: 7 },
    }).params,
    { stream: "ring", level: 7 },
  );
  assert.throws(() =>
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.audio.set",
      params: { stream: "ring", level: -1 },
    }),
  );
  assert.throws(() =>
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.alert.find",
      params: { audible: true },
    }),
  );
  assert.throws(() =>
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.alert.find",
      params: { durationMs: 5001 },
    }),
  );
  assert.throws(() =>
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "shell.exec",
      params: { command: "id" },
    }),
  );
});

test("UI target results accept only the bounded privacy-safe contract", () => {
  const data = {
    target: {
      source: "android-uiautomator",
      confidence: "exact-resource-id",
      packageName: "com.example.messages",
      activityName: ".MainActivity",
      className: "android.widget.EditText",
      resourceId: "com.example.messages:id/compose_message_text",
      text: { mode: "parameter", key: "ui.compose_message_text" },
      description: {
        mode: "redacted",
        category: "numeric-content",
        length: 9,
      },
      bounds: {
        left: 100,
        top: 1800,
        right: 800,
        bottom: 2000,
        screenWidth: 1080,
        screenHeight: 2340,
      },
      clickable: true,
      editable: true,
    },
    foreground: {
      packageName: "com.example.messages",
      activityName: ".MainActivity",
    },
    display: { width: 1080, height: 2340 },
    capturedAt: 1_750_000_000_000,
  };
  assert.deepEqual(parseDeviceUiTargetAtResult(data), data);
  assert.deepEqual(
    parseDeviceUiTargetAtResult({ ...data, target: null }),
    { ...data, target: null },
  );
  assert.throws(() =>
    parseDeviceUiTargetAtResult({
      ...data,
      hierarchy: "<hierarchy />",
    }),
  );
  assert.throws(() =>
    parseDeviceUiTargetAtResult({
      ...data,
      target: {
        ...data.target,
        text: { mode: "literal", value: "fixture-private-text", reviewed: false },
      },
    }),
  );
  assert.deepEqual(
    parseDeviceUiTargetAtResult({
      ...data,
      target: {
        ...data.target,
        text: { mode: "literal", value: "发送", reviewed: true },
      },
    }).target?.text,
    { mode: "literal", value: "发送", reviewed: true },
  );
  assert.throws(() =>
    parseDeviceUiTargetAtResult({
      ...data,
      target: {
        ...data.target,
        text: { mode: "literal", value: "FixtureContact", reviewed: true },
      },
    }),
  );
  assert.throws(() =>
    parseDeviceUiTargetAtResult({
      ...data,
      target: { ...data.target, resourceId: undefined },
    }),
  );
  assert.throws(() =>
    parseDeviceUiTargetAtResult({
      ...data,
      target: { ...data.target, confidence: "heuristic" },
    }),
  );
  assert.throws(() =>
    parseDeviceUiTargetAtResult({
      ...data,
      target: {
        ...data.target,
        confidence: "composite",
        resourceId: undefined,
        text: undefined,
        description: undefined,
      },
    }),
  );
  const successResponse = {
    protocolVersion: 1,
    type: "response",
    sessionId: "session_12345678",
    requestId: "request_12345678",
    operation: "device.ui.target-at",
    status: "SUCCESS",
    code: "OPS_OPERATION_SUCCEEDED",
    message: "FixtureContact 10000000000",
    data,
    startedAt: 10,
    finishedAt: 20,
    durationMs: 10,
  };
  assert.equal(
    parseDeviceOpsResponse(successResponse).message,
    "Operation completed",
  );
  assert.throws(() =>
    parseDeviceOpsResponse({
      ...successResponse,
      data: { ...data, hierarchy: "forbidden" },
    }),
  );
  const failedResponse = {
    protocolVersion: 1,
    type: "response",
    sessionId: "session_12345678",
    requestId: "request_12345678",
    operation: "device.ui.target-at",
    status: "FAILURE",
    code: "UI_HIERARCHY_DUMP_FAILED",
    message: "<hierarchy text=\"FixtureContact 10000000000\" />",
    data: {},
    startedAt: 10,
    finishedAt: 20,
    durationMs: 10,
  };
  const parsedFailure = parseDeviceOpsResponse(failedResponse);
  assert.deepEqual(parsedFailure.data, {});
  assert.equal(parsedFailure.message, "Android UI hierarchy dump failed");
  assert.equal(parsedFailure.message.includes("FixtureContact"), false);
  assert.throws(() =>
    parseDeviceOpsResponse({
      ...failedResponse,
      data: { pageSource: "<hierarchy />" },
    }),
  );
  assert.throws(() =>
    parseDeviceOpsResponse({
      ...failedResponse,
      code: "DEVICE_MESSAGE_WITH_PRIVATE_DATA",
    }),
  );
});

test("device screenshot artifact parsing verifies length and SHA-256", () => {
  const content = Buffer.from("bounded screenshot bytes", "utf8");
  const header = Buffer.from(
    JSON.stringify({
      protocolVersion: 1,
      type: "artifact",
      sessionId: "session_12345678",
      requestId: "request_12345678",
      operation: "device.screen.capture",
      artifactId: "artifact_12345678",
      mimeType: "image/png",
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      width: 1080,
      height: 1920,
      capturedAt: 1_750_000_000_000,
    }),
    "utf8",
  );
  const frame = Buffer.alloc(4 + header.byteLength + content.byteLength);
  frame.writeUInt32BE(header.byteLength, 0);
  header.copy(frame, 4);
  content.copy(frame, 4 + header.byteLength);

  assert.deepEqual(parseDeviceOpsArtifactFrame(frame).content, content);
  const tampered = Buffer.from(frame);
  tampered[tampered.byteLength - 1] ^= 1;
  assert.throws(() => parseDeviceOpsArtifactFrame(tampered), /checksum/);
});

test("optional ops WSS configuration is disabled only when both values are absent", () => {
  assert.equal(resolveDeviceOpsWebSocketConfig({}), null);
  assert.equal(
    resolveDeviceOpsWebSocketConfig({
      DEVICE_OPS_REPORT_TOKEN: "1234567890123456",
      REMOTE_CONTROL_RELAY_WS_URL: "ws://127.0.0.1:3000/api/remote/ws",
    }),
    null,
  );
  assert.throws(
    () =>
      resolveDeviceOpsWebSocketConfig({
        DEVICE_OPS_REPORT_TOKEN: "1234567890123456",
      }),
    /configured together/,
  );
  assert.deepEqual(
    resolveDeviceOpsWebSocketConfig({
      DEVICE_OPS_REPORT_TOKEN: "1234567890123456",
      DEVICE_OPS_WS_URL: "ws://127.0.0.1:3000/api/ops/ws",
    }),
    {
      reportToken: "1234567890123456",
      wsUrl: "ws://127.0.0.1:3000/api/ops/ws",
      pathname: "/api/ops/ws",
    },
  );
  assert.throws(() =>
    resolveDeviceOpsWebSocketConfig({
      DEVICE_OPS_REPORT_TOKEN: "1234567890123456",
      DEVICE_OPS_WS_URL: "ws://192.0.2.10/api/ops/ws",
    }),
  );
  assert.throws(
    () =>
      resolveDeviceOpsWebSocketConfig({
        DEVICE_OPS_REPORT_TOKEN: "1234567890123456",
        DEVICE_OPS_WS_URL: "ws://127.0.0.1:3000/api/screen",
      }),
    /must not reuse/,
  );
  assert.throws(
    () =>
      resolveDeviceOpsWebSocketConfig({
        ONE_AUTOJS6_API_TOKEN: "1234567890123456",
        DEVICE_OPS_REPORT_TOKEN: "1234567890123456",
        DEVICE_OPS_WS_URL: "ws://127.0.0.1:3000/api/ops/ws",
      }),
    /must not reuse ONE_AUTOJS6_API_TOKEN/,
  );
});

test("device WSS authentication requires the separate Device credential", () => {
  const token = "0123456789abcdef0123456789abcdef";
  assert.equal(isValidDeviceOpsAuthorization(`Device ${token}`, token), true);
  assert.equal(isValidDeviceOpsAuthorization(`Bearer ${token}`, token), false);
  assert.equal(isValidDeviceOpsAuthorization("Device wrong-token-value", token), false);
});

test("disabled operations service fails safely before MQTT publication", async () => {
  let publications = 0;
  const service = new DeviceOpsService({
    wsUrl: null,
    publishOpenSession: async () => {
      publications += 1;
    },
  });
  try {
    await assert.rejects(
      service.createOperation(
        parseDeviceOpsCreateInput({
          clientId: "pixel-5",
          operation: "device.network.get",
        }),
      ),
      (error: unknown) =>
        error instanceof Error &&
        "httpStatus" in error &&
        error.httpStatus === 503,
    );
    assert.equal(publications, 0);
  } finally {
    service.dispose();
  }
});

test("UI target operation is accepted as an asynchronous task", async () => {
  const published: DeviceOpsOpenSessionCommand[] = [];
  const service = new DeviceOpsService({
    wsUrl: "ws://127.0.0.1:3000/api/ops/ws",
    publishOpenSession: async (_deviceId, command) => {
      published.push(command);
    },
    createId: () => "opsid_ui_target_0001",
    createNonce: () => "nonce_abcdefghijklmnopqrstuvwxyz0123456789",
  });
  try {
    const accepted = await service.createOperation(
      parseDeviceOpsCreateInput({
        clientId: "pixel-5",
        operation: "device.ui.target-at",
        params: { x: 264, y: 568, screenWidth: 528, screenHeight: 1136 },
        timeoutMs: 3_000,
      }),
    );
    assert.equal(accepted.status, "EXECUTING");
    assert.equal(accepted.operation, "device.ui.target-at");
    assert.equal(accepted.startedAtUtc, null);
    assert.equal(published.length, 1);
  } finally {
    service.dispose();
  }
});

test("one upgrade router serves screen and ops paths without mutual aborts", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  let opsConnections = 0;
  let screenConnections = 0;
  const gateway = {
    acceptDeviceSocket: () => {
      opsConnections += 1;
    },
  } as unknown as DeviceOpsService;
  const opsEndpoint = createDeviceOpsWebSocketEndpoint(
    {
      reportToken: token,
      wsUrl: "ws://127.0.0.1:3000/api/ops/ws",
      pathname: "/api/ops/ws",
    },
    gateway,
  );
  const screenServer = new WebSocketServer({ noServer: true });
  screenServer.on("connection", () => {
    screenConnections += 1;
  });
  const httpServer = createServer();
  attachWebSocketUpgradeRouter(httpServer, [
    { pathname: "/api/screen", webSocketServer: screenServer },
    opsEndpoint,
  ]);
  assert.equal(httpServer.listenerCount("upgrade"), 1);
  const port = await listenOnLoopback(httpServer);
  const screenSocket = new WebSocket(`ws://127.0.0.1:${port}/api/screen`);
  const opsSocket = new WebSocket(
    `ws://127.0.0.1:${port}/api/ops/ws`,
    DEVICE_OPS_SUBPROTOCOL,
    { headers: { Authorization: `Device ${token}` } },
  );
  try {
    await Promise.all([waitForOpen(screenSocket), waitForOpen(opsSocket)]);
    assert.equal(screenConnections, 1);
    assert.equal(opsConnections, 1);
  } finally {
    await Promise.all([closeSocket(screenSocket), closeSocket(opsSocket)]);
    await Promise.all([
      closeWebSocketServer(screenServer),
      closeWebSocketServer(opsEndpoint.webSocketServer),
    ]);
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("operation creation returns EXECUTING before the device connects", async () => {
  const published: DeviceOpsOpenSessionCommand[] = [];
  let sequence = 0;
  const service = new DeviceOpsService({
    wsUrl: "ws://127.0.0.1:3000/api/ops/ws",
    publishOpenSession: async (_deviceId, command) => {
      published.push(command);
    },
    createId: () => `opsid_${String(++sequence).padStart(8, "0")}`,
    createNonce: () => "nonce_abcdefghijklmnopqrstuvwxyz0123456789",
  });
  const accepted = await service.createOperation(
    parseDeviceOpsCreateInput({
      clientId: "pixel-5",
      operation: "device.network.get",
      timeoutMs: 3_000,
    }),
  );
  assert.equal(accepted.status, "EXECUTING");
  assert.equal(accepted.startedAtUtc, null);
  assert.equal(published.length, 1);
  assert.equal(published[0].protocolVersion, 1);
  assert.equal(published[0].type, "OPEN_SESSION");
  assert.equal(published[0].deviceId, "pixel-5");
  assert.equal(published[0].wsUrl, "ws://127.0.0.1:3000/api/ops/ws");
  assert.ok(published[0].expiresAt > published[0].issuedAt);

  const httpServer = createServer();
  const socketServer = new WebSocketServer({ noServer: true });
  socketServer.on("connection", (socket) => service.acceptDeviceSocket(socket));
  attachWebSocketUpgradeRouter(httpServer, [
    { pathname: "/api/ops/ws", webSocketServer: socketServer },
  ]);
  const port = await listenOnLoopback(httpServer);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ops/ws`);
  try {
    await waitForOpen(socket);
    const requestMessage = readMessage(socket);
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "hello",
        role: "device",
        sessionId: published[0].sessionId,
        deviceId: published[0].deviceId,
        nonce: published[0].nonce,
        capabilities: { operations: ["device.network.get"] },
        timestamp: Date.now(),
      }),
    );
    const requestFrame = await requestMessage;
    assert.equal(requestFrame.isBinary, false);
    const request = JSON.parse(requestFrame.data.toString()) as {
      sessionId: string;
      requestId: string;
      operation: string;
    };
    assert.equal(request.sessionId, published[0].sessionId);
    assert.equal(request.requestId, accepted.taskId);
    assert.equal(request.operation, "device.network.get");
    const startedAt = Date.now();
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "response",
        sessionId: request.sessionId,
        requestId: request.requestId,
        operation: request.operation,
        status: "SUCCESS",
        code: "OK",
        message: "Network state retrieved",
        data: { interfaces: [] },
        startedAt,
        finishedAt: startedAt + 5,
        durationMs: 5,
      }),
    );
    const terminal = await waitForTerminalTask(service, accepted.taskId);
    assert.equal(terminal.status, "SUCCESS");
    assert.deepEqual(terminal.data, { interfaces: [] });

    const secondRequestMessage = readMessage(socket);
    const secondAccepted = await service.createOperation(
      parseDeviceOpsCreateInput({
        clientId: "pixel-5",
        operation: "device.network.get",
        timeoutMs: 3_000,
      }),
    );
    assert.equal(secondAccepted.status, "EXECUTING");
    assert.equal(secondAccepted.sessionId, accepted.sessionId);
    assert.equal(published.length, 2);
    assert.equal(published[1].sessionId, published[0].sessionId);
    const secondFrame = await secondRequestMessage;
    const secondRequest = JSON.parse(secondFrame.data.toString()) as {
      sessionId: string;
      requestId: string;
      operation: string;
    };
    const secondStartedAt = Date.now();
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "response",
        sessionId: secondRequest.sessionId,
        requestId: secondRequest.requestId,
        operation: secondRequest.operation,
        status: "SUCCESS",
        code: "OK",
        message: "Network state retrieved",
        data: { interfaces: [{ name: "wlan0" }] },
        startedAt: secondStartedAt,
        finishedAt: secondStartedAt + 5,
        durationMs: 5,
      }),
    );
    const secondTerminal = await waitForTerminalTask(
      service,
      secondAccepted.taskId,
    );
    assert.equal(secondTerminal.status, "SUCCESS");

    const thirdRequestMessage = readMessage(socket);
    const thirdAccepted = await service.createOperation(
      parseDeviceOpsCreateInput({
        clientId: "pixel-5",
        operation: "device.network.get",
        timeoutMs: 3_000,
      }),
    );
    await thirdRequestMessage;
    await closeSocket(socket);
    const unknownOutcome = await waitForTerminalTask(
      service,
      thirdAccepted.taskId,
    );
    assert.equal(unknownOutcome.status, "FAILURE");
    assert.equal(unknownOutcome.code, "OPS_CONNECTION_LOST");
  } finally {
    service.dispose();
    await closeSocket(socket);
    await closeWebSocketServer(socketServer);
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
