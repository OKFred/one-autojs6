import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import WebSocket, { type RawData, WebSocketServer } from "ws";

import {
  REMOTE_CONTROL_MAX_DEVICE_BINARY_BYTES,
  REMOTE_CONTROL_MAX_JSON_BYTES,
  parseRemoteControlCreateInput,
  parseRemoteControlHello,
  parseRemoteControlP2PSignal,
  parseRemoteControlP2PState,
  parseRemoteControlSessionEvent,
  parseRemoteControlStunUrls,
  parseRemoteControlTransportState,
  type RemoteControlOpenSessionCommand,
} from "../src/remote-control-protocol.js";
import {
  createRemoteControlUpgradeAdmission,
  createRemoteControlWebSocketEndpoint,
  REMOTE_CONTROL_SUBPROTOCOL,
  REMOTE_CONTROL_SUBPROTOCOL_V1,
  REMOTE_CONTROL_SUBPROTOCOL_V2,
  resolveRemoteControlWebSocketConfig,
  selectRemoteControlSubprotocol,
  type RemoteControlWebSocketEndpoint,
} from "../src/remote-control-websocket.js";
import {
  RemoteControlGatewayError,
  RemoteControlService,
  type RemoteControlSessionCreated,
} from "../src/service/remote-control.service.js";
import { attachWebSocketUpgradeRouter } from "../src/websocket-upgrade-router.js";

/**
 * Start a test HTTP server on an ephemeral loopback port.
 *
 * @param server Server to start.
 * @returns Allocated port.
 */
async function listenRemoteServer(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Remote relay test server did not expose a TCP port");
  }
  return address.port;
}

/**
 * Wait for one client WebSocket to open.
 *
 * @param socket Client WebSocket.
 * @returns Promise settled by the connection attempt.
 */
function waitRemoteOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (
    socket.readyState === WebSocket.CLOSING ||
    socket.readyState === WebSocket.CLOSED
  ) {
    return Promise.reject(new Error("Remote relay WebSocket was rejected"));
  }
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

/**
 * Wait for one WebSocket close frame.
 *
 * @param socket Connected WebSocket expected to close.
 * @returns Close code and bounded reason text.
 */
function waitRemoteClose(
  socket: WebSocket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString("utf8") }),
    );
  });
}

/**
 * Read one relay WebSocket message.
 *
 * @param socket Connected WebSocket.
 * @returns Next raw message and binary marker.
 */
function readRemoteMessage(
  socket: WebSocket,
): Promise<{ data: RawData; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => resolve({ data, isBinary }));
    socket.once("error", reject);
  });
}

/**
 * Read and parse one non-binary relay control frame.
 *
 * @param socket Connected WebSocket.
 * @returns Parsed JSON object.
 */
async function readRemoteJson(
  socket: WebSocket,
): Promise<Record<string, unknown>> {
  const frame = await readRemoteMessage(socket);
  assert.equal(frame.isBinary, false);
  return JSON.parse(frame.data.toString()) as Record<string, unknown>;
}

/**
 * Read a fixed number of relay messages without racing multiple once listeners.
 *
 * @param socket Connected WebSocket.
 * @param count Positive number of messages to retain in arrival order.
 * @returns Messages in the exact order emitted by ws.
 */
function readRemoteMessages(
  socket: WebSocket,
  count: number,
): Promise<Array<{ data: RawData; isBinary: boolean }>> {
  return new Promise((resolve, reject) => {
    const messages: Array<{ data: RawData; isBinary: boolean }> = [];
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    const onMessage = (data: RawData, isBinary: boolean) => {
      messages.push({ data, isBinary });
      if (messages.length < count) return;
      socket.off("error", onError);
      socket.off("message", onMessage);
      resolve(messages);
    };
    socket.once("error", onError);
    socket.on("message", onMessage);
  });
}

/**
 * Close one client WebSocket and wait for completion.
 *
 * @param socket Client WebSocket.
 * @returns Promise resolved after close.
 */
async function closeRemoteSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  socket.close();
  await closed;
}

/**
 * Close one no-server WSS after its clients are gone.
 *
 * @param server WebSocket server.
 * @returns Promise resolved after closure.
 */
async function closeRemoteWss(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Connected v2 test peers and their isolated server resources. */
interface RemoteP2PTestHarness {
  service: RemoteControlService;
  endpoint: RemoteControlWebSocketEndpoint;
  httpServer: Server;
  controller: WebSocket;
  device: WebSocket;
  created: RemoteControlSessionCreated;
  invitation: RemoteControlOpenSessionCommand;
}

/**
 * Create one isolated P2P-preferred lease with connected but unbound peers.
 *
 * @param options Optional protocol offers and shortened negotiation timeout.
 * @returns Test harness whose peers are ready to send relay.hello.
 */
async function createRemoteP2PTestHarness(
  options: {
    controllerProtocols?: string[];
    deviceProtocols?: string[];
    negotiationMs?: number;
  } = {},
): Promise<RemoteP2PTestHarness> {
  const invitations: RemoteControlOpenSessionCommand[] = [];
  let id = 0;
  let ticket = 0;
  const service = new RemoteControlService({
    relayWsUrl: "ws://127.0.0.1:3000/api/remote/ws",
    allowP2P: true,
    stunUrls: ["stun:stun.cloudflare.com:3478"],
    negotiationMs: options.negotiationMs,
    publishOpenSession: async (_deviceId, command) => {
      invitations.push(command);
    },
    createId: () => `remote_${String(++id).padStart(12, "0")}`,
    createTicket: () => `ticket_${String(++ticket).padStart(36, "0")}`,
    createAttemptId: () => "attempt_12345678",
  });
  const created = await service.createSession(
    parseRemoteControlCreateInput({
      clientId: "pixel-5",
      transportPreference: "p2p-preferred",
    }),
  );
  const invitation = invitations[0];
  assert.ok(invitation);
  const endpoint = createRemoteControlWebSocketEndpoint(
    {
      deviceToken: "device-token-0123456789abcdef",
      relayWsUrl: "ws://127.0.0.1:3000/api/remote/ws",
      pathname: "/api/remote/ws",
      browserOrigins: new Set(["http://studio.local"]),
      allowP2P: true,
      stunUrls: ["stun:stun.cloudflare.com:3478"],
    },
    service,
  );
  const httpServer = createServer();
  attachWebSocketUpgradeRouter(httpServer, [endpoint]);
  const port = await listenRemoteServer(httpServer);
  const controller = new WebSocket(
    `ws://127.0.0.1:${port}/api/remote/ws`,
    options.controllerProtocols || [
      REMOTE_CONTROL_SUBPROTOCOL_V1,
      REMOTE_CONTROL_SUBPROTOCOL_V2,
    ],
    { origin: "http://studio.local" },
  );
  const device = new WebSocket(
    `ws://127.0.0.1:${port}/api/remote/ws`,
    options.deviceProtocols || [
      REMOTE_CONTROL_SUBPROTOCOL_V1,
      REMOTE_CONTROL_SUBPROTOCOL_V2,
    ],
    {
      headers: {
        Authorization: "Device device-token-0123456789abcdef",
      },
    },
  );
  await Promise.all([waitRemoteOpen(controller), waitRemoteOpen(device)]);
  return {
    service,
    endpoint,
    httpServer,
    controller,
    device,
    created,
    invitation,
  };
}

/**
 * Send version-matched hello frames from both connected harness peers.
 *
 * @param harness Isolated connected peer harness.
 * @returns Nothing.
 */
function sendRemoteHarnessHellos(harness: RemoteP2PTestHarness): void {
  const controllerVersion =
    harness.controller.protocol === REMOTE_CONTROL_SUBPROTOCOL_V2 ? 2 : 1;
  const deviceVersion =
    harness.device.protocol === REMOTE_CONTROL_SUBPROTOCOL_V2 ? 2 : 1;
  harness.controller.send(
    JSON.stringify({
      protocolVersion: controllerVersion,
      type: "relay.hello",
      role: "controller",
      sessionId: harness.created.sessionId,
      ticket: harness.created.browserTicket,
      timestamp: Date.now(),
    }),
  );
  harness.device.send(
    JSON.stringify({
      protocolVersion: deviceVersion,
      type: "relay.hello",
      role: "device",
      sessionId: harness.created.sessionId,
      deviceId: "pixel-5",
      ticket: harness.invitation.deviceTicket,
      timestamp: Date.now(),
    }),
  );
}

/**
 * Complete one deterministic v2 offer/answer and two-sided ready exchange.
 *
 * @param harness Connected v2 P2P harness.
 * @returns Active attempt identifier and the final ready frames.
 */
async function completeRemoteHarnessP2P(
  harness: RemoteP2PTestHarness,
): Promise<{
  attemptId: string;
  controllerReady: Record<string, unknown>;
  deviceReady: Record<string, unknown>;
}> {
  const controllerStartPromise = readRemoteJson(harness.controller);
  const deviceStartPromise = readRemoteJson(harness.device);
  sendRemoteHarnessHellos(harness);
  const [controllerStart, deviceStart] = await Promise.all([
    controllerStartPromise,
    deviceStartPromise,
  ]);
  assert.equal(controllerStart.type, "relay.p2p.start");
  assert.deepEqual(controllerStart, deviceStart);
  assert.deepEqual(Object.keys(controllerStart).sort(), [
    "attemptId",
    "deadlineAt",
    "iceServers",
    "protocolVersion",
    "sessionId",
    "type",
  ]);
  const attemptId = String(controllerStart.attemptId);
  const offerPromise = readRemoteJson(harness.device);
  harness.controller.send(
    JSON.stringify({
      protocolVersion: 2,
      type: "relay.p2p.signal",
      sessionId: harness.created.sessionId,
      attemptId,
      sequence: 0,
      signalType: "offer",
      description: { type: "offer", sdp: "v=0\r\no=controller" },
    }),
  );
  assert.equal((await offerPromise).signalType, "offer");
  const answerPromise = readRemoteJson(harness.controller);
  harness.device.send(
    JSON.stringify({
      protocolVersion: 2,
      type: "relay.p2p.signal",
      sessionId: harness.created.sessionId,
      attemptId,
      sequence: 0,
      signalType: "answer",
      description: { type: "answer", sdp: "v=0\r\no=device" },
    }),
  );
  assert.equal((await answerPromise).signalType, "answer");
  const controllerReadyPromise = readRemoteJson(harness.controller);
  const deviceReadyPromise = readRemoteJson(harness.device);
  harness.controller.send(
    JSON.stringify({
      protocolVersion: 2,
      type: "relay.p2p.state",
      sessionId: harness.created.sessionId,
      attemptId,
      sequence: 1,
      state: "ready",
      selectedPair: {
        localCandidateType: "srflx",
        remoteCandidateType: "host",
        protocol: "udp",
      },
    }),
  );
  harness.device.send(
    JSON.stringify({
      protocolVersion: 2,
      type: "relay.p2p.state",
      sessionId: harness.created.sessionId,
      attemptId,
      sequence: 1,
      state: "ready",
    }),
  );
  const [controllerReady, deviceReady] = await Promise.all([
    controllerReadyPromise,
    deviceReadyPromise,
  ]);
  return { attemptId, controllerReady, deviceReady };
}

/**
 * Close all resources owned by a P2P test harness.
 *
 * @param harness Harness to dispose.
 * @returns Promise resolved when sockets and servers are closed.
 */
async function closeRemoteP2PTestHarness(
  harness: RemoteP2PTestHarness,
): Promise<void> {
  harness.service.dispose();
  await Promise.all([
    closeRemoteSocket(harness.controller),
    closeRemoteSocket(harness.device),
  ]);
  await Promise.all([
    closeRemoteWss(harness.endpoint.controllerWebSocketServer),
    closeRemoteWss(harness.endpoint.deviceWebSocketServer),
  ]);
  await new Promise<void>((resolve, reject) =>
    harness.httpServer.close((error) =>
      error ? reject(error) : resolve(),
    ),
  );
}

test("remote-control create and hello parsing is strict and bounded", () => {
  assert.deepEqual(parseRemoteControlCreateInput({ clientId: "pixel-5" }), {
    clientId: "pixel-5",
    ttlMs: 600_000,
    transportPreference: "relay",
  });
  assert.deepEqual(
    parseRemoteControlCreateInput({
      clientId: "pixel-5",
      ttlMs: 30_000,
      transportPreference: "p2p-preferred",
    }),
    {
      clientId: "pixel-5",
      ttlMs: 30_000,
      transportPreference: "p2p-preferred",
    },
  );
  assert.throws(() =>
    parseRemoteControlCreateInput({
      clientId: "pixel-5",
      command: "shell",
    }),
  );
  assert.throws(() =>
    parseRemoteControlCreateInput({ clientId: "pixel-5", ttlMs: 29_999 }),
  );
  assert.equal(
    parseRemoteControlHello({
      protocolVersion: 1,
      type: "relay.hello",
      role: "controller",
      sessionId: "session_12345678",
      ticket: "ticket_abcdefghijklmnopqrstuvwxyz123456",
      timestamp: 1_750_000_000_000,
    }).role,
    "controller",
  );
  assert.throws(() =>
    parseRemoteControlHello({
      protocolVersion: 1,
      type: "relay.hello",
      role: "controller",
      sessionId: "session_12345678",
      deviceId: "pixel-5",
      ticket: "ticket_abcdefghijklmnopqrstuvwxyz123456",
      timestamp: 1_750_000_000_000,
    }),
  );
});

test("P2P interface accepts only bounded typed SDP or ICE signaling", () => {
  assert.equal(
    parseRemoteControlP2PSignal({
      protocolVersion: 2,
      type: "relay.p2p.signal",
      sessionId: "session_12345678",
      attemptId: "attempt_12345678",
      sequence: 0,
      signalType: "offer",
      description: { type: "offer", sdp: "v=0\r\n" },
    }).signalType,
    "offer",
  );
  assert.throws(() =>
    parseRemoteControlP2PSignal({
      protocolVersion: 2,
      type: "relay.p2p.signal",
      sessionId: "session_12345678",
      attemptId: "attempt_12345678",
      sequence: 0,
      signalType: "offer",
      description: { type: "offer", sdp: "x".repeat(49 * 1024) },
    }),
  );
  assert.throws(() =>
    parseRemoteControlP2PSignal({
      protocolVersion: 2,
      type: "relay.p2p.signal",
      sessionId: "session_12345678",
      attemptId: "attempt_12345678",
      sequence: 0,
      signalType: "shell",
      payload: "id",
    }),
  );
  assert.throws(() =>
    parseRemoteControlP2PSignal({
      protocolVersion: 1,
      type: "relay.p2p.signal",
      sessionId: "session_12345678",
      attemptId: "attempt_12345678",
      sequence: 0,
      signalType: "offer",
      description: { type: "offer", sdp: "v=0\r\n" },
    }),
  );
  assert.equal(
    parseRemoteControlP2PState({
      protocolVersion: 2,
      type: "relay.p2p.state",
      sessionId: "session_12345678",
      attemptId: "attempt_12345678",
      sequence: 0,
      state: "ready",
      selectedPair: {
        localCandidateType: "srflx",
        remoteCandidateType: "host",
        protocol: "udp",
      },
    }).selectedPair?.protocol,
    "udp",
  );
  assert.throws(() =>
    parseRemoteControlP2PState({
      protocolVersion: 2,
      type: "relay.p2p.state",
      sessionId: "session_12345678",
      attemptId: "attempt_12345678",
      sequence: 0,
      state: "ready",
      selectedPair: {
        localCandidateType: "srflx",
        remoteCandidateType: "host",
        protocol: "udp",
        address: "192.0.2.10",
      },
    }),
  );
  assert.throws(() =>
    parseRemoteControlP2PState({
      protocolVersion: 2,
      type: "relay.p2p.state",
      sessionId: "session_12345678",
      attemptId: "attempt_12345678",
      state: "failed",
      reasonCode: "P2P_TEST_FAILURE",
    }),
  );
  assert.equal(
    parseRemoteControlTransportState({
      protocolVersion: 2,
      type: "relay.transport.state",
      sessionId: "session_12345678",
      transport: "relay",
      state: "ready",
    }).transport,
    "relay",
  );
});

test("device remote-session events are strict and correlated", () => {
  const value = {
    protocolVersion: 1,
    type: "REMOTE_SESSION_EVENT",
    eventId: "event_12345678",
    sessionId: "session_12345678",
    deviceId: "pixel-5",
    state: "CONNECTED",
    code: "REMOTE_CONNECTED",
    message: "Connected to the relay",
    timestamp: 1_750_000_000_000,
  } as const;
  assert.equal(parseRemoteControlSessionEvent(value).state, "CONNECTED");
  assert.throws(() =>
    parseRemoteControlSessionEvent({ ...value, deviceId: "other", shell: "id" }),
  );
  assert.throws(() =>
    parseRemoteControlSessionEvent({ ...value, code: "invalid code" }),
  );
});

test("remote relay configuration is optional but rejects partial or shared auth", () => {
  assert.equal(
    selectRemoteControlSubprotocol(
      new Set([
        REMOTE_CONTROL_SUBPROTOCOL_V1,
        REMOTE_CONTROL_SUBPROTOCOL_V2,
      ]),
    ),
    REMOTE_CONTROL_SUBPROTOCOL_V2,
  );
  assert.deepEqual(
    parseRemoteControlStunUrls(
      "stun:stun.cloudflare.com:3478,stuns:stun.example.com:5349",
      true,
    ),
    ["stun:stun.cloudflare.com:3478", "stuns:stun.example.com:5349"],
  );
  assert.throws(() => parseRemoteControlStunUrls("turn:relay.example.com", true));
  assert.throws(() => parseRemoteControlStunUrls("stun:host:70000", true));
  assert.throws(() => parseRemoteControlStunUrls("stun:host:not-a-port", true));
  assert.equal(resolveRemoteControlWebSocketConfig({}), null);
  assert.equal(
    resolveRemoteControlWebSocketConfig({
      DEVICE_OPS_REPORT_TOKEN: "device-token-0123456789abcdef",
    }),
    null,
  );
  assert.throws(() =>
    resolveRemoteControlWebSocketConfig({
      REMOTE_CONTROL_RELAY_WS_URL: "ws://127.0.0.1:3000/api/remote/ws",
    }),
  );
  assert.throws(() =>
    resolveRemoteControlWebSocketConfig({
      DEVICE_OPS_REPORT_TOKEN: "device-token-0123456789abcdef",
      REMOTE_CONTROL_RELAY_WS_URL: "ws://127.0.0.1:3000/custom/relay",
    }),
  );
  assert.throws(() =>
    resolveRemoteControlWebSocketConfig({
      DEVICE_OPS_REPORT_TOKEN: "device-token-0123456789abcdef",
      REMOTE_CONTROL_RELAY_WS_URL: "ws://localhost:3000/api/remote/ws",
    }),
  );
  const config = resolveRemoteControlWebSocketConfig({
    PORT: "3000",
    ONE_AUTOJS6_API_TOKEN: "browser-token-0123456789abcdef",
    DEVICE_OPS_REPORT_TOKEN: "device-token-0123456789abcdef",
    REMOTE_CONTROL_RELAY_WS_URL: "ws://127.0.0.1:3000/api/remote/ws",
    SCRCPY_ORIGIN: "http://127.0.0.1:8000",
  });
  assert.ok(config);
  assert.equal(config.pathname, "/api/remote/ws");
  assert.equal(config.allowP2P, false);
  assert.deepEqual(config.stunUrls, []);
  assert.equal(config.browserOrigins.has("http://127.0.0.1:8000"), true);
  assert.throws(() =>
    resolveRemoteControlWebSocketConfig({
      ONE_AUTOJS6_API_TOKEN: "same-token-0123456789abcdef",
      DEVICE_OPS_REPORT_TOKEN: "same-token-0123456789abcdef",
      REMOTE_CONTROL_RELAY_WS_URL: "ws://127.0.0.1:3000/api/remote/ws",
    }),
  );
  assert.throws(() =>
    resolveRemoteControlWebSocketConfig({
      DEVICE_OPS_REPORT_TOKEN: "device-token-0123456789abcdef",
      REMOTE_CONTROL_RELAY_WS_URL: "ws://127.0.0.1:3000/api/remote/ws",
      REMOTE_CONTROL_ALLOW_P2P_NEGOTIATION: "yes",
    }),
  );
  assert.throws(() =>
    resolveRemoteControlWebSocketConfig({
      DEVICE_OPS_REPORT_TOKEN: "device-token-0123456789abcdef",
      REMOTE_CONTROL_RELAY_WS_URL: "ws://127.0.0.1:3000/api/remote/ws",
      REMOTE_CONTROL_ALLOW_P2P_NEGOTIATION: "true",
    }),
  );
  const p2pConfig = resolveRemoteControlWebSocketConfig({
    DEVICE_OPS_REPORT_TOKEN: "device-token-0123456789abcdef",
    REMOTE_CONTROL_RELAY_WS_URL: "ws://127.0.0.1:3000/api/remote/ws",
    REMOTE_CONTROL_ALLOW_P2P_NEGOTIATION: "true",
    REMOTE_CONTROL_STUN_URLS: "stun:stun.cloudflare.com:3478",
  });
  assert.deepEqual(p2pConfig?.stunUrls, [
    "stun:stun.cloudflare.com:3478",
  ]);
  assert.throws(() =>
    resolveRemoteControlWebSocketConfig({
      DEVICE_OPS_REPORT_TOKEN: "device-token-0123456789abcdef",
      REMOTE_CONTROL_RELAY_WS_URL: "ws://127.0.0.1:3000/api/remote/ws",
      REMOTE_CONTROL_BROWSER_ORIGINS: "https://studio.example.com/path",
    }),
  );
});

test("remote relay upgrade admission is bounded per direct address", () => {
  let now = 1_750_000_000_000;
  const admit = createRemoteControlUpgradeAdmission({
    now: () => now,
    windowMs: 1_000,
    maxAttempts: 2,
    maxAddresses: 2,
  });
  assert.equal(admit("192.0.2.10"), true);
  assert.equal(admit("192.0.2.10"), true);
  assert.equal(admit("192.0.2.10"), false);
  assert.equal(admit("192.0.2.11"), true);
  now += 1_000;
  assert.equal(admit("192.0.2.10"), true);
  assert.throws(() =>
    createRemoteControlUpgradeAdmission({ windowMs: 999 }),
  );
});

test("session creation is async, device-exclusive, and releases on close", async () => {
  const published: RemoteControlOpenSessionCommand[] = [];
  let id = 0;
  let ticket = 0;
  const service = new RemoteControlService({
    relayWsUrl: "ws://127.0.0.1:3000/api/remote/ws",
    publishOpenSession: async (_deviceId, command) => {
      published.push(command);
    },
    createId: () => `remote_${String(++id).padStart(12, "0")}`,
    createTicket: () => `ticket_${String(++ticket).padStart(36, "0")}`,
  });
  try {
    const created = await service.createSession(
      parseRemoteControlCreateInput({ clientId: "pixel-5" }),
    );
    assert.equal(created.status, "EXECUTING");
    assert.equal(created.sessionState, "WAITING_PEERS");
    assert.equal(published.length, 1);
    assert.equal(published[0].type, "OPEN_REMOTE_SESSION");
    assert.equal(published[0].sessionId, created.sessionId);
    assert.notEqual(published[0].deviceTicket, created.browserTicket);
    const polled = JSON.stringify(service.getSession(created.sessionId));
    assert.equal(polled.includes(created.browserTicket), false);
    assert.equal(polled.includes(published[0].deviceTicket), false);

    await assert.rejects(
      service.createSession(
        parseRemoteControlCreateInput({ clientId: "pixel-5" }),
      ),
      (error: unknown) =>
        error instanceof RemoteControlGatewayError && error.httpStatus === 409,
    );
    const closed = service.closeSession(created.sessionId);
    assert.equal(closed?.status, "CANCELLED");
    assert.equal(closed?.sessionState, "CLOSED");
    const replacement = await service.createSession(
      parseRemoteControlCreateInput({ clientId: "pixel-5" }),
    );
    assert.notEqual(replacement.sessionId, created.sessionId);
    const eventTimestamp = Date.now();
    service.handleDeviceSessionEvent("another-device", {
      protocolVersion: 1,
      type: "REMOTE_SESSION_EVENT",
      eventId: "event_12345678",
      sessionId: replacement.sessionId,
      deviceId: "pixel-5",
      state: "REJECTED",
      code: "REMOTE_LOCAL_SCRCPY_UNAVAILABLE",
      message: "Local endpoint unavailable",
      timestamp: eventTimestamp,
    });
    assert.equal(service.getSession(replacement.sessionId)?.status, "EXECUTING");
    service.handleDeviceSessionEvent("pixel-5", {
      protocolVersion: 1,
      type: "REMOTE_SESSION_EVENT",
      eventId: "event_12345679",
      sessionId: replacement.sessionId,
      deviceId: "pixel-5",
      state: "REJECTED",
      code: "REMOTE_LOCAL_SCRCPY_UNAVAILABLE",
      message: "Local endpoint unavailable",
      timestamp: eventTimestamp,
    });
    const rejected = service.getSession(replacement.sessionId);
    assert.equal(rejected?.status, "FAILURE");
    assert.equal(rejected?.sessionState, "FAILED");
    assert.equal(rejected?.lastDeviceEventState, "REJECTED");
    assert.equal(rejected?.lastDeviceEventCode, "REMOTE_LOCAL_SCRCPY_UNAVAILABLE");
    const afterRejected = await service.createSession(
      parseRemoteControlCreateInput({ clientId: "pixel-5" }),
    );
    assert.notEqual(afterRejected.sessionId, replacement.sessionId);
  } finally {
    service.dispose();
  }
});

test("creation response remains EXECUTING when a device event races MQTT PUBACK", async () => {
  let id = 0;
  let ticket = 0;
  let service: RemoteControlService;
  service = new RemoteControlService({
    relayWsUrl: "ws://127.0.0.1:3000/api/remote/ws",
    publishOpenSession: async (deviceId, command) => {
      service.handleDeviceSessionEvent(deviceId, {
        protocolVersion: 1,
        type: "REMOTE_SESSION_EVENT",
        eventId: "event_12345678",
        sessionId: command.sessionId,
        deviceId,
        state: "REJECTED",
        code: "REMOTE_DEVICE_BUSY",
        message: "Device is busy",
        timestamp: command.issuedAt,
      });
    },
    createId: () => `remote_${String(++id).padStart(12, "0")}`,
    createTicket: () => `ticket_${String(++ticket).padStart(36, "0")}`,
  });
  try {
    const accepted = await service.createSession(
      parseRemoteControlCreateInput({ clientId: "pixel-5" }),
    );
    assert.equal(accepted.status, "EXECUTING");
    assert.equal(accepted.sessionState, "WAITING_PEERS");
    const polled = service.getSession(accepted.sessionId);
    assert.equal(polled?.status, "FAILURE");
    assert.equal(polled?.sessionState, "FAILED");
    assert.equal(polled?.code, "REMOTE_DEVICE_BUSY");
  } finally {
    service.dispose();
  }
});

test("browser and device rendezvous outbound then relay binary frames in order", async () => {
  const deviceToken = "device-token-0123456789abcdef";
  const invitations: RemoteControlOpenSessionCommand[] = [];
  let id = 0;
  let ticket = 0;
  const service = new RemoteControlService({
    relayWsUrl: "ws://127.0.0.1:3000/api/remote/ws",
    publishOpenSession: async (_deviceId, command) => {
      invitations.push(command);
    },
    createId: () => `remote_${String(++id).padStart(12, "0")}`,
    createTicket: () => `ticket_${String(++ticket).padStart(36, "0")}`,
  });
  const created = await service.createSession(
    parseRemoteControlCreateInput({ clientId: "pixel-5" }),
  );
  assert.equal(invitations.length, 1);
  const invitation = invitations[0];
  assert.ok(invitation);

  const endpoint = createRemoteControlWebSocketEndpoint(
    {
      deviceToken,
      relayWsUrl: "ws://127.0.0.1:3000/api/remote/ws",
      pathname: "/api/remote/ws",
      browserOrigins: new Set(["http://studio.local"]),
      allowP2P: false,
      stunUrls: [],
    },
    service,
  );
  assert.equal(
    endpoint.controllerWebSocketServer.options.maxPayload,
    REMOTE_CONTROL_MAX_JSON_BYTES,
  );
  assert.equal(
    endpoint.deviceWebSocketServer.options.maxPayload,
    REMOTE_CONTROL_MAX_DEVICE_BINARY_BYTES,
  );
  const httpServer = createServer();
  let screenConnections = 0;
  const screenServer = new WebSocketServer({ noServer: true });
  screenServer.on("connection", () => {
    screenConnections += 1;
  });
  attachWebSocketUpgradeRouter(httpServer, [
    { pathname: "/api/screen", webSocketServer: screenServer },
    endpoint,
  ]);
  const port = await listenRemoteServer(httpServer);
  const screen = new WebSocket(`ws://127.0.0.1:${port}/api/screen`);
  const screenOpened = waitRemoteOpen(screen);
  const queryCredential = new WebSocket(
    `ws://127.0.0.1:${port}/api/remote/ws?ticket=${created.browserTicket}`,
    REMOTE_CONTROL_SUBPROTOCOL,
    { origin: "http://studio.local" },
  );
  const queryCredentialOpened = waitRemoteOpen(queryCredential);
  const wrongOrigin = new WebSocket(
    `ws://127.0.0.1:${port}/api/remote/ws`,
    REMOTE_CONTROL_SUBPROTOCOL,
    { origin: "http://untrusted.local" },
  );
  const wrongOriginOpened = waitRemoteOpen(wrongOrigin);
  const invalidAuthorization = new WebSocket(
    `ws://127.0.0.1:${port}/api/remote/ws`,
    REMOTE_CONTROL_SUBPROTOCOL,
    {
      origin: "http://studio.local",
      headers: { Authorization: "Device invalid-device-token" },
    },
  );
  const invalidAuthorizationOpened = waitRemoteOpen(invalidAuthorization);
  const oversizedController = new WebSocket(
    `ws://127.0.0.1:${port}/api/remote/ws`,
    REMOTE_CONTROL_SUBPROTOCOL,
    { origin: "http://studio.local" },
  );
  const oversizedControllerOpened = waitRemoteOpen(oversizedController);
  const controller = new WebSocket(
    `ws://127.0.0.1:${port}/api/remote/ws`,
    REMOTE_CONTROL_SUBPROTOCOL,
    { origin: "http://studio.local" },
  );
  const controllerOpened = waitRemoteOpen(controller);
  const device = new WebSocket(
    `ws://127.0.0.1:${port}/api/remote/ws`,
    REMOTE_CONTROL_SUBPROTOCOL,
    { headers: { Authorization: `Device ${deviceToken}` } },
  );
  const deviceOpened = waitRemoteOpen(device);
  try {
    await Promise.all([
      screenOpened,
      assert.rejects(queryCredentialOpened),
      assert.rejects(wrongOriginOpened),
      assert.rejects(invalidAuthorizationOpened),
      oversizedControllerOpened,
      controllerOpened,
      deviceOpened,
    ]);
    assert.equal(screenConnections, 1);
    assert.equal(queryCredential.readyState, WebSocket.CLOSED);
    assert.equal(wrongOrigin.readyState, WebSocket.CLOSED);
    assert.equal(invalidAuthorization.readyState, WebSocket.CLOSED);
    assert.equal(endpoint.controllerWebSocketServer.clients.size, 2);
    assert.equal(endpoint.deviceWebSocketServer.clients.size, 1);
    const oversizedControllerClosed = waitRemoteClose(oversizedController);
    oversizedController.send(
      Buffer.alloc(REMOTE_CONTROL_MAX_JSON_BYTES + 1),
    );
    assert.equal((await oversizedControllerClosed).code, 1009);
    const controllerReady = readRemoteMessage(controller);
    const deviceReady = readRemoteMessage(device);
    controller.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "relay.hello",
        role: "controller",
        sessionId: created.sessionId,
        ticket: created.browserTicket,
        timestamp: Date.now(),
      }),
    );
    device.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "relay.hello",
        role: "device",
        sessionId: created.sessionId,
        deviceId: "pixel-5",
        ticket: invitation.deviceTicket,
        timestamp: Date.now(),
      }),
    );
    const readyFrames = await Promise.all([controllerReady, deviceReady]);
    for (const frame of readyFrames) {
      assert.equal(frame.isBinary, false);
      const ready = JSON.parse(frame.data.toString()) as Record<string, unknown>;
      assert.equal(ready.type, "relay.ready");
      assert.deepEqual(Object.keys(ready).sort(), [
        "expiresAt",
        "protocolVersion",
        "sessionId",
        "transport",
        "type",
      ]);
    }
    assert.equal(service.getSession(created.sessionId)?.sessionState, "ACTIVE");

    const deviceControlFrames = readRemoteMessages(device, 2);
    controller.send(Buffer.from([1, 2, 3, 4]));
    controller.send(Buffer.from([5, 6]));
    const receivedControls = await deviceControlFrames;
    assert.equal(receivedControls.every((frame) => frame.isBinary), true);
    assert.deepEqual(
      receivedControls.map((frame) => Buffer.from(frame.data as Buffer)),
      [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6])],
    );

    const controllerMediaFrames = readRemoteMessages(controller, 2);
    device.send(Buffer.from([9, 8, 7, 6, 5]));
    device.send(Buffer.from([4, 3, 2, 1]));
    const receivedMedia = await controllerMediaFrames;
    assert.equal(receivedMedia.every((frame) => frame.isBinary), true);
    assert.deepEqual(
      receivedMedia.map((frame) => Buffer.from(frame.data as Buffer)),
      [Buffer.from([9, 8, 7, 6, 5]), Buffer.from([4, 3, 2, 1])],
    );

    const controllerClosedFrame = readRemoteMessage(controller);
    const deviceClosedFrame = readRemoteMessage(device);
    const closed = service.closeSession(created.sessionId);
    assert.equal(closed?.status, "CANCELLED");
    const closedFrames = await Promise.all([
      controllerClosedFrame,
      deviceClosedFrame,
    ]);
    for (const frame of closedFrames) {
      const closedFrame = JSON.parse(frame.data.toString()) as Record<
        string,
        unknown
      >;
      assert.equal(closedFrame.type, "relay.closed");
      assert.deepEqual(Object.keys(closedFrame).sort(), [
        "code",
        "message",
        "protocolVersion",
        "sessionId",
        "type",
      ]);
    }
  } finally {
    service.dispose();
    await Promise.all([
      closeRemoteSocket(screen),
      closeRemoteSocket(queryCredential),
      closeRemoteSocket(wrongOrigin),
      closeRemoteSocket(invalidAuthorization),
      closeRemoteSocket(oversizedController),
      closeRemoteSocket(controller),
      closeRemoteSocket(device),
    ]);
    await Promise.all([
      closeRemoteWss(screenServer),
      closeRemoteWss(endpoint.controllerWebSocketServer),
      closeRemoteWss(endpoint.deviceWebSocketServer),
    ]);
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("v2 selects P2P before data and recovers to relay only after device ack", async () => {
  const harness = await createRemoteP2PTestHarness();
  try {
    assert.equal(harness.controller.protocol, REMOTE_CONTROL_SUBPROTOCOL_V2);
    assert.equal(harness.device.protocol, REMOTE_CONTROL_SUBPROTOCOL_V2);
    const { attemptId, controllerReady, deviceReady } =
      await completeRemoteHarnessP2P(harness);
    for (const ready of [controllerReady, deviceReady]) {
      assert.deepEqual(ready, {
        protocolVersion: 2,
        type: "relay.ready",
        sessionId: harness.created.sessionId,
        transport: "p2p",
        expiresAt: harness.created.expiresAtUtc,
      });
    }
    const active = harness.service.getSession(harness.created.sessionId);
    assert.equal(active?.sessionState, "ACTIVE");
    assert.equal(active?.selectedTransport, "p2p");
    assert.deepEqual(active?.p2pSelectedPair, {
      localCandidateType: "srflx",
      remoteCandidateType: "host",
      protocol: "udp",
    });
    assert.equal(JSON.stringify(active).includes("o=controller"), false);

    const controllerRecoveringPromise = readRemoteJson(harness.controller);
    const deviceRecoveringPromise = readRemoteJson(harness.device);
    harness.controller.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.state",
        sessionId: harness.created.sessionId,
        attemptId,
        sequence: 2,
        state: "failed",
        reasonCode: "P2P_CONNECTION_FAILED",
      }),
    );
    const recoveringFrames = await Promise.all([
      controllerRecoveringPromise,
      deviceRecoveringPromise,
    ]);
    for (const frame of recoveringFrames) {
      assert.deepEqual(frame, {
        protocolVersion: 2,
        type: "relay.transport",
        sessionId: harness.created.sessionId,
        transport: "relay",
        phase: "recovering",
        reasonCode: "P2P_CONNECTION_FAILED",
      });
    }
    assert.equal(
      harness.service.getSession(harness.created.sessionId)?.sessionState,
      "RECOVERING_TRANSPORT",
    );
    assert.equal(
      harness.service.getSession(harness.created.sessionId)?.selectedTransport,
      null,
    );

    const controllerRecoveredPromise = readRemoteJson(harness.controller);
    const deviceRecoveredPromise = readRemoteJson(harness.device);
    harness.device.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.transport.state",
        sessionId: harness.created.sessionId,
        transport: "relay",
        state: "ready",
      }),
    );
    const recoveredFrames = await Promise.all([
      controllerRecoveredPromise,
      deviceRecoveredPromise,
    ]);
    assert.equal(
      recoveredFrames.every(
        (frame) =>
          frame.type === "relay.transport" && frame.phase === "ready",
      ),
      true,
    );
    const recovered = harness.service.getSession(harness.created.sessionId);
    assert.equal(recovered?.sessionState, "ACTIVE");
    assert.equal(recovered?.selectedTransport, "relay");
    assert.equal(recovered?.p2pFailureCode, "P2P_CONNECTION_FAILED");

    const relayedPromise = readRemoteMessage(harness.device);
    harness.controller.send(Buffer.from([7, 8, 9]));
    const relayed = await relayedPromise;
    assert.equal(relayed.isBinary, true);
    assert.deepEqual(Buffer.from(relayed.data as Buffer), Buffer.from([7, 8, 9]));
  } finally {
    await closeRemoteP2PTestHarness(harness);
  }
});

test("route probes authorize only canonical phone ICE candidate addresses", async () => {
  const harness = await createRemoteP2PTestHarness();
  try {
    const controllerStartPromise = readRemoteJson(harness.controller);
    const deviceStartPromise = readRemoteJson(harness.device);
    sendRemoteHarnessHellos(harness);
    const [start] = await Promise.all([
      controllerStartPromise,
      deviceStartPromise,
    ]);
    const offerPromise = readRemoteJson(harness.device);
    harness.controller.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.signal",
        sessionId: harness.created.sessionId,
        attemptId: start.attemptId,
        sequence: 0,
        signalType: "offer",
        description: { type: "offer", sdp: "v=0\r\no=controller" },
      }),
    );
    await offerPromise;
    const answerPromise = readRemoteJson(harness.controller);
    harness.device.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.signal",
        sessionId: harness.created.sessionId,
        attemptId: start.attemptId,
        sequence: 0,
        signalType: "answer",
        description: { type: "answer", sdp: "v=0\r\no=device" },
      }),
    );
    await answerPromise;
    assert.equal(
      harness.service.authorizeRouteProbeTarget(
        harness.created.sessionId,
        "192.168.50.8",
      ),
      null,
    );

    const candidatePromise = readRemoteJson(harness.controller);
    harness.device.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.signal",
        sessionId: harness.created.sessionId,
        attemptId: start.attemptId,
        sequence: 1,
        signalType: "ice-candidate",
        candidate: {
          candidate:
            "candidate:2 1 udp 2122260223 192.168.50.8 53124 typ host generation 0",
          sdpMid: "0",
          sdpMLineIndex: 0,
        },
      }),
    );
    await candidatePromise;
    assert.equal(
      harness.service.authorizeRouteProbeTarget(
        harness.created.sessionId,
        "192.168.50.8",
      ),
      "192.168.50.8",
    );
    assert.equal(
      harness.service.authorizeRouteProbeTarget(
        harness.created.sessionId,
        "192.168.50.9",
      ),
      null,
    );

    const controllerCandidatePromise = readRemoteJson(harness.device);
    harness.controller.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.signal",
        sessionId: harness.created.sessionId,
        attemptId: start.attemptId,
        sequence: 1,
        signalType: "ice-candidate",
        candidate: {
          candidate:
            "candidate:3 1 udp 2122260223 10.0.0.20 53125 typ host generation 0",
        },
      }),
    );
    await controllerCandidatePromise;
    assert.equal(
      harness.service.authorizeRouteProbeTarget(
        harness.created.sessionId,
        "10.0.0.20",
      ),
      null,
    );
    harness.service.closeSession(harness.created.sessionId);
    assert.equal(
      harness.service.authorizeRouteProbeTarget(
        harness.created.sessionId,
        "192.168.50.8",
      ),
      null,
    );
  } finally {
    await closeRemoteP2PTestHarness(harness);
  }
});

test("mixed v2 and legacy v1 peers select relay without starting P2P", async () => {
  const harness = await createRemoteP2PTestHarness({
    controllerProtocols: [
      REMOTE_CONTROL_SUBPROTOCOL_V1,
      REMOTE_CONTROL_SUBPROTOCOL_V2,
    ],
    deviceProtocols: [REMOTE_CONTROL_SUBPROTOCOL_V1],
  });
  try {
    assert.equal(harness.controller.protocol, REMOTE_CONTROL_SUBPROTOCOL_V2);
    assert.equal(harness.device.protocol, REMOTE_CONTROL_SUBPROTOCOL_V1);
    const controllerReadyPromise = readRemoteJson(harness.controller);
    const deviceReadyPromise = readRemoteJson(harness.device);
    sendRemoteHarnessHellos(harness);
    const [controllerReady, deviceReady] = await Promise.all([
      controllerReadyPromise,
      deviceReadyPromise,
    ]);
    assert.equal(controllerReady.protocolVersion, 2);
    assert.equal(controllerReady.transport, "relay");
    assert.equal(controllerReady.reasonCode, "P2P_PEER_LEGACY");
    assert.deepEqual(Object.keys(deviceReady).sort(), [
      "expiresAt",
      "protocolVersion",
      "sessionId",
      "transport",
      "type",
    ]);
    assert.equal(deviceReady.protocolVersion, 1);
    assert.equal(
      harness.service.getSession(harness.created.sessionId)?.p2pStatus,
      "FALLBACK",
    );
  } finally {
    await closeRemoteP2PTestHarness(harness);
  }
});

test("v2 negotiation timeout selects relay and exposes only sanitized diagnostics", async () => {
  const harness = await createRemoteP2PTestHarness({ negotiationMs: 50 });
  try {
    const controllerStartPromise = readRemoteJson(harness.controller);
    const deviceStartPromise = readRemoteJson(harness.device);
    sendRemoteHarnessHellos(harness);
    const [controllerStart, deviceStart] = await Promise.all([
      controllerStartPromise,
      deviceStartPromise,
    ]);
    assert.equal(controllerStart.type, "relay.p2p.start");
    assert.equal(deviceStart.type, "relay.p2p.start");
    assert.equal(
      harness.service.getSession(harness.created.sessionId)?.sessionState,
      "SELECTING_TRANSPORT",
    );
    const controllerReadyPromise = readRemoteJson(harness.controller);
    const deviceReadyPromise = readRemoteJson(harness.device);
    const readyFrames = await Promise.all([
      controllerReadyPromise,
      deviceReadyPromise,
    ]);
    assert.equal(
      readyFrames.every(
        (frame) =>
          frame.type === "relay.ready" &&
          frame.transport === "relay" &&
          frame.reasonCode === "P2P_NEGOTIATION_TIMEOUT",
      ),
      true,
    );
    const fallback = harness.service.getSession(harness.created.sessionId);
    assert.equal(fallback?.sessionState, "ACTIVE");
    assert.equal(fallback?.selectedTransport, "relay");
    assert.equal(fallback?.p2pFailureCode, "P2P_NEGOTIATION_TIMEOUT");
    assert.equal(typeof fallback?.p2pNegotiationDurationMs, "number");
    const relayedPromise = readRemoteMessage(harness.device);
    harness.controller.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.state",
        sessionId: harness.created.sessionId,
        attemptId: controllerStart.attemptId,
        sequence: 0,
        state: "failed",
        reasonCode: "P2P_LATE_FAILURE",
      }),
    );
    harness.controller.send(Buffer.from([4, 2]));
    const relayed = await relayedPromise;
    assert.equal(relayed.isBinary, true);
    assert.deepEqual(Buffer.from(relayed.data as Buffer), Buffer.from([4, 2]));
  } finally {
    await closeRemoteP2PTestHarness(harness);
  }
});

test("v2 relay recovery timeout closes the lease instead of reopening binary", async () => {
  const harness = await createRemoteP2PTestHarness({ negotiationMs: 50 });
  try {
    const { attemptId } = await completeRemoteHarnessP2P(harness);
    const controllerRecoveringPromise = readRemoteJson(harness.controller);
    const deviceRecoveringPromise = readRemoteJson(harness.device);
    harness.device.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.state",
        sessionId: harness.created.sessionId,
        attemptId,
        sequence: 2,
        state: "failed",
        reasonCode: "P2P_CONNECTION_CLOSED",
      }),
    );
    await Promise.all([controllerRecoveringPromise, deviceRecoveringPromise]);
    const controllerClosedPromise = readRemoteJson(harness.controller);
    const deviceClosedPromise = readRemoteJson(harness.device);
    const closedFrames = await Promise.all([
      controllerClosedPromise,
      deviceClosedPromise,
    ]);
    assert.equal(
      closedFrames.every(
        (frame) =>
          frame.type === "relay.closed" &&
          frame.code === "P2P_RECOVERY_TIMEOUT",
      ),
      true,
    );
    const failed = harness.service.getSession(harness.created.sessionId);
    assert.equal(failed?.status, "FAILURE");
    assert.equal(failed?.sessionState, "FAILED");
  } finally {
    await closeRemoteP2PTestHarness(harness);
  }
});

test("v2 rejects stale attempts and WSS binary while P2P is active", async () => {
  const selectingBinaryHarness = await createRemoteP2PTestHarness();
  try {
    const controllerStartPromise = readRemoteJson(
      selectingBinaryHarness.controller,
    );
    const deviceStartPromise = readRemoteJson(selectingBinaryHarness.device);
    sendRemoteHarnessHellos(selectingBinaryHarness);
    await Promise.all([controllerStartPromise, deviceStartPromise]);
    const controllerFramesPromise = readRemoteMessages(
      selectingBinaryHarness.controller,
      2,
    );
    selectingBinaryHarness.controller.send(Buffer.from([1]));
    const controllerFrames = await controllerFramesPromise;
    assert.equal(JSON.parse(controllerFrames[0].data.toString()).type, "relay.error");
    assert.equal(JSON.parse(controllerFrames[1].data.toString()).type, "relay.closed");
  } finally {
    await closeRemoteP2PTestHarness(selectingBinaryHarness);
  }

  const staleHarness = await createRemoteP2PTestHarness();
  try {
    const controllerStartPromise = readRemoteJson(staleHarness.controller);
    const deviceStartPromise = readRemoteJson(staleHarness.device);
    sendRemoteHarnessHellos(staleHarness);
    await Promise.all([controllerStartPromise, deviceStartPromise]);
    const controllerFramesPromise = readRemoteMessages(
      staleHarness.controller,
      2,
    );
    staleHarness.controller.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.signal",
        sessionId: staleHarness.created.sessionId,
        attemptId: "attempt_stale_12345678",
        sequence: 0,
        signalType: "offer",
        description: { type: "offer", sdp: "v=0\r\n" },
      }),
    );
    const controllerFrames = await controllerFramesPromise;
    assert.equal(JSON.parse(controllerFrames[0].data.toString()).type, "relay.error");
    assert.equal(JSON.parse(controllerFrames[1].data.toString()).type, "relay.closed");
    assert.equal(
      staleHarness.service.getSession(staleHarness.created.sessionId)?.status,
      "FAILURE",
    );
  } finally {
    await closeRemoteP2PTestHarness(staleHarness);
  }

  const sequenceHarness = await createRemoteP2PTestHarness();
  try {
    const controllerStartPromise = readRemoteJson(sequenceHarness.controller);
    const deviceStartPromise = readRemoteJson(sequenceHarness.device);
    sendRemoteHarnessHellos(sequenceHarness);
    const [start] = await Promise.all([
      controllerStartPromise,
      deviceStartPromise,
    ]);
    const controllerFramesPromise = readRemoteMessages(
      sequenceHarness.controller,
      2,
    );
    sequenceHarness.controller.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.signal",
        sessionId: sequenceHarness.created.sessionId,
        attemptId: start.attemptId,
        sequence: 1,
        signalType: "offer",
        description: { type: "offer", sdp: "v=0\r\n" },
      }),
    );
    const controllerFrames = await controllerFramesPromise;
    assert.equal(JSON.parse(controllerFrames[0].data.toString()).type, "relay.error");
    assert.equal(JSON.parse(controllerFrames[1].data.toString()).type, "relay.closed");
  } finally {
    await closeRemoteP2PTestHarness(sequenceHarness);
  }

  const stateSequenceHarness = await createRemoteP2PTestHarness();
  try {
    const controllerStartPromise = readRemoteJson(
      stateSequenceHarness.controller,
    );
    const deviceStartPromise = readRemoteJson(stateSequenceHarness.device);
    sendRemoteHarnessHellos(stateSequenceHarness);
    const [start] = await Promise.all([
      controllerStartPromise,
      deviceStartPromise,
    ]);
    const offerPromise = readRemoteJson(stateSequenceHarness.device);
    stateSequenceHarness.controller.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.signal",
        sessionId: stateSequenceHarness.created.sessionId,
        attemptId: start.attemptId,
        sequence: 0,
        signalType: "offer",
        description: { type: "offer", sdp: "v=0\r\n" },
      }),
    );
    await offerPromise;
    const answerPromise = readRemoteJson(stateSequenceHarness.controller);
    stateSequenceHarness.device.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.signal",
        sessionId: stateSequenceHarness.created.sessionId,
        attemptId: start.attemptId,
        sequence: 0,
        signalType: "answer",
        description: { type: "answer", sdp: "v=0\r\n" },
      }),
    );
    await answerPromise;
    const controllerFramesPromise = readRemoteMessages(
      stateSequenceHarness.controller,
      2,
    );
    stateSequenceHarness.controller.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "relay.p2p.state",
        sessionId: stateSequenceHarness.created.sessionId,
        attemptId: start.attemptId,
        sequence: 2,
        state: "ready",
      }),
    );
    const controllerFrames = await controllerFramesPromise;
    assert.equal(
      JSON.parse(controllerFrames[0].data.toString()).type,
      "relay.error",
    );
    assert.equal(
      JSON.parse(controllerFrames[1].data.toString()).type,
      "relay.closed",
    );
  } finally {
    await closeRemoteP2PTestHarness(stateSequenceHarness);
  }

  const binaryHarness = await createRemoteP2PTestHarness();
  try {
    await completeRemoteHarnessP2P(binaryHarness);
    const controllerFramesPromise = readRemoteMessages(
      binaryHarness.controller,
      2,
    );
    binaryHarness.controller.send(Buffer.from([1, 2, 3]));
    const controllerFrames = await controllerFramesPromise;
    assert.equal(JSON.parse(controllerFrames[0].data.toString()).type, "relay.error");
    assert.equal(JSON.parse(controllerFrames[1].data.toString()).type, "relay.closed");
    assert.equal(
      binaryHarness.service.getSession(binaryHarness.created.sessionId)?.code,
      "RELAY_FRAME_INVALID",
    );
  } finally {
    await closeRemoteP2PTestHarness(binaryHarness);
  }
});
