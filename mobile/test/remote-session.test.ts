import assert from "node:assert/strict";
import http, { type IncomingMessage, type Server } from "node:http";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { RemoteSessionPeer } from "../src/remote-session-peer.js";
import type {
  RtcSidecarCallbacks,
  RtcSidecarTransport,
} from "../src/rtc-sidecar-client.js";
import {
  REMOTE_BROWSER_FRAME_MAX_BYTES,
  REMOTE_DEVICE_FRAME_MAX_BYTES,
  REMOTE_SESSION_SUBPROTOCOL,
  REMOTE_SESSION_SUBPROTOCOL_V2,
  parseLocalScrcpyUrl,
  parseRemoteRelayControl,
  parseRemoteRelayOrigin,
  parseRemoteRelayUrl,
  parseRemoteSessionOpenCommand,
  type RemoteSessionEvent,
  type RemoteSessionOpenCommand,
} from "../src/remote-session-protocol.js";

/** Deferred value used to coordinate loopback WebSocket assertions. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Create a deferred promise for event-driven test setup.
 *
 * @returns Deferred promise and its settlement callbacks.
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Listen on an ephemeral IPv4-loopback port.
 *
 * @param server HTTP server backing a WebSocket endpoint.
 * @returns Selected TCP port.
 */
async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Loopback test server did not expose a TCP port");
  }
  return address.port;
}

/**
 * Await one complete WebSocket message.
 *
 * @param socket WebSocket expected to receive a message.
 * @returns Message bytes and binary marker.
 */
function nextMessage(
  socket: WebSocket,
): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (data: RawData, isBinary: boolean) => {
      socket.off("error", reject);
      resolve({
        data: Array.isArray(data)
          ? Buffer.concat(data.map((part) => Buffer.from(part)))
          : Buffer.from(data),
        isBinary,
      });
    });
  });
}

/**
 * Await a fixed number of complete WebSocket messages without listener gaps.
 *
 * @param socket WebSocket expected to receive messages.
 * @param count Positive number of messages to collect.
 * @returns Complete messages in arrival order.
 */
function nextMessages(
  socket: WebSocket,
  count: number,
): Promise<Array<{ data: Buffer; isBinary: boolean }>> {
  return new Promise((resolve, reject) => {
    const messages: Array<{ data: Buffer; isBinary: boolean }> = [];
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    const onMessage = (data: RawData, isBinary: boolean) => {
      messages.push({
        data: Array.isArray(data)
          ? Buffer.concat(data.map((part) => Buffer.from(part)))
          : Buffer.from(data),
        isBinary,
      });
      if (messages.length === count) {
        socket.off("error", onError);
        socket.off("message", onMessage);
        resolve(messages);
      }
    };
    socket.once("error", onError);
    socket.on("message", onMessage);
  });
}

/**
 * Wait until a synchronous assertion becomes true.
 *
 * @param predicate Condition polled by the test.
 * @param label Diagnostic label used on timeout.
 * @returns Completion once the condition is true.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Terminate clients and close a WebSocket plus HTTP server pair.
 *
 * @param webSocketServer WebSocket server to drain.
 * @param server HTTP server to close.
 * @returns Completion after both listeners are closed.
 */
async function closeServers(
  webSocketServer: WebSocketServer,
  server: Server,
): Promise<void> {
  for (const client of webSocketServer.clients) client.terminate();
  await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
  if (server.listening) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const now = Date.now();
const baseCommand: RemoteSessionOpenCommand = {
  protocolVersion: 1,
  type: "OPEN_REMOTE_SESSION",
  sessionId: "session_12345678",
  deviceId: "phone-001",
  relayWsUrl: "wss://relay.example.test/api/remote/ws",
  deviceTicket: "A".repeat(32),
  issuedAt: now,
  expiresAt: now + 60_000,
  transportPreference: "relay",
};

assert.deepEqual(
  parseRemoteSessionOpenCommand({
    ...baseCommand,
    transportPreference: undefined,
  }).transportPreference,
  "relay",
);
assert.equal(
  parseRemoteRelayUrl("wss://relay.example.test/api/remote/ws"),
  "wss://relay.example.test/api/remote/ws",
);
assert.equal(
  parseRemoteRelayOrigin("wss://relay.example.test"),
  "wss://relay.example.test",
);
assert.equal(
  parseLocalScrcpyUrl("ws://127.0.0.1:8886/"),
  "ws://127.0.0.1:8886/",
);
assert.throws(() =>
  parseRemoteRelayUrl("ws://relay.example.test/api/remote/ws"),
);
assert.throws(() =>
  parseRemoteRelayUrl("ws://localhost:39001/api/remote/ws"),
);
assert.throws(() =>
  parseRemoteRelayUrl("wss://relay.example.test/api/remote/ws?ticket=secret"),
);
assert.throws(() => parseRemoteRelayOrigin("wss://relay.example.test/path"));
assert.throws(() => parseLocalScrcpyUrl("ws://192.0.2.10:8886/"));
assert.throws(() => parseLocalScrcpyUrl("ws://127.0.0.1:8886/control"));
assert.throws(() =>
  parseRemoteSessionOpenCommand({
    ...baseCommand,
    localScrcpyUrl: "ws://attacker.example.test/",
  }),
);
assert.throws(() =>
  parseRemoteSessionOpenCommand({
    ...baseCommand,
    deviceTicket: "too-short",
  }),
);
assert.throws(() =>
  parseRemoteRelayControl(
    {
      protocolVersion: 1,
      type: "relay.closed",
      sessionId: baseCommand.sessionId,
      code: "REMOTE_CLOSED",
      message: "closed",
      timestamp: now,
    },
    baseCommand.sessionId,
  ),
);
assert.deepEqual(
  parseRemoteRelayControl(
    {
      protocolVersion: 1,
      type: "relay.closed",
      sessionId: baseCommand.sessionId,
      code: "REMOTE_CLOSED",
      message: "closed",
    },
    baseCommand.sessionId,
  ),
  {
    protocolVersion: 1,
    type: "relay.closed",
    sessionId: baseCommand.sessionId,
    code: "REMOTE_CLOSED",
    message: "closed",
  },
);
assert.deepEqual(
  parseRemoteRelayControl(
    {
      protocolVersion: 2,
      type: "relay.p2p.start",
      sessionId: baseCommand.sessionId,
      attemptId: "attempt_12345678",
      deadlineAt: now + 10_000,
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    },
    baseCommand.sessionId,
    2,
  ).type,
  "relay.p2p.start",
);
assert.throws(() =>
  parseRemoteRelayControl(
    {
      protocolVersion: 2,
      type: "relay.p2p.start",
      sessionId: baseCommand.sessionId,
      attemptId: "attempt_12345678",
      deadlineAt: now + 10_000,
      iceServers: [
        {
          urls: "turn:turn.example.test:3478",
          username: "must-not-reach-sidecar",
        },
      ],
    },
    baseCommand.sessionId,
    2,
  ),
);
assert.equal(REMOTE_BROWSER_FRAME_MAX_BYTES, 64 * 1024);
assert.equal(REMOTE_DEVICE_FRAME_MAX_BYTES, 4 * 1024 * 1024);

const relayHttp = http.createServer();
const relayConnection = deferred<{
  socket: WebSocket;
  request: IncomingMessage;
}>();
let relayConnections = 0;
const relaySockets: WebSocket[] = [];
const relayServer = new WebSocketServer({
  server: relayHttp,
  path: "/api/remote/ws",
  perMessageDeflate: false,
  handleProtocols: (protocols) =>
    protocols.has(REMOTE_SESSION_SUBPROTOCOL)
      ? REMOTE_SESSION_SUBPROTOCOL
      : false,
});
relayServer.on("connection", (socket, request) => {
  relayConnections += 1;
  relaySockets.push(socket);
  relayConnection.resolve({ socket, request });
});
const relayPort = await listenLoopback(relayHttp);

const localHttp = http.createServer();
const localConnection = deferred<WebSocket>();
const firstLocalMessage = deferred<{ data: Buffer; isBinary: boolean }>();
let localConnections = 0;
const localServer = new WebSocketServer({
  server: localHttp,
  path: "/",
  perMessageDeflate: false,
});
localServer.on("connection", (socket) => {
  localConnections += 1;
  if (localConnections === 1) {
    void nextMessage(socket).then(
      (message) => firstLocalMessage.resolve(message),
      (error: unknown) => firstLocalMessage.reject(error),
    );
  }
  localConnection.resolve(socket);
});
const localPort = await listenLoopback(localHttp);

const events: RemoteSessionEvent[] = [];
let inactiveCalls = 0;
const reportToken = "device-report-token-123456";
const relayOrigin = `ws://127.0.0.1:${relayPort}`;
const peer = new RemoteSessionPeer({
  deviceId: baseCommand.deviceId,
  reportToken,
  allowedRelayOrigins: [relayOrigin],
  localScrcpyUrl: `ws://127.0.0.1:${localPort}/`,
  isDeploymentBlocked: () => false,
  onInactive: () => {
    inactiveCalls += 1;
  },
  publishEvent: async (event) => {
    events.push(event);
  },
});

const command: RemoteSessionOpenCommand = {
  ...baseCommand,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  relayWsUrl: `${relayOrigin}/api/remote/ws`,
};
await peer.handleOpenCommand(command);
const { socket: relaySocket, request: relayRequest } =
  await relayConnection.promise;
const helloMessage = await nextMessage(relaySocket);
assert.equal(helloMessage.isBinary, false);
const hello = JSON.parse(helloMessage.data.toString("utf8")) as Record<
  string,
  unknown
>;
assert.equal(relayRequest.headers.authorization, `Device ${reportToken}`);
assert.match(
  String(relayRequest.headers["sec-websocket-protocol"]),
  /autojs6-remote-v2.*autojs6-remote-v1/,
);
assert.equal(relaySocket.protocol, REMOTE_SESSION_SUBPROTOCOL);
assert.equal(relayRequest.url, "/api/remote/ws");
assert.equal(JSON.stringify(relayRequest.headers).includes(command.deviceTicket), false);
assert.equal(String(relayRequest.url).includes(command.deviceTicket), false);
assert.equal(hello.type, "relay.hello");
assert.equal(hello.role, "device");
assert.equal(hello.sessionId, command.sessionId);
assert.equal(hello.deviceId, command.deviceId);
assert.equal(hello.ticket, command.deviceTicket);
assert.equal(localConnections, 0);

const preReadyEventCount = events.length;
await peer.handleOpenCommand(command);
assert.equal(events.length, preReadyEventCount);
assert.equal(relayConnections, 1);

await new Promise<void>((resolve) => setTimeout(resolve, 5_100));
assert.equal(peer.isActive(), true);
assert.equal(localConnections, 0);
assert.equal(events.length, preReadyEventCount);
assert.equal(
  events.some((event) => event.state === "CLOSED" || event.state === "REJECTED"),
  false,
);

const relayPreReadyControl = Buffer.from([10, 11, 12]);
relaySocket.send(relayPreReadyControl, { binary: true });
await new Promise<void>((resolve) => setTimeout(resolve, 20));
assert.equal(peer.isActive(), true);
assert.equal(localConnections, 0);

relaySocket.send(
  JSON.stringify({
    protocolVersion: 1,
    type: "relay.ready",
    sessionId: command.sessionId,
    transport: "relay",
    expiresAt: command.expiresAt,
  }),
);
const localSocket = await localConnection.promise;
assert.deepEqual(await firstLocalMessage.promise, {
  data: relayPreReadyControl,
  isBinary: true,
});
await waitFor(
  () => events.some((event) => event.state === "CONNECTED"),
  "CONNECTED lifecycle event",
);
assert.equal(peer.isActive(), true);
assert.deepEqual(
  events.map((event) => event.state),
  ["CONNECTING", "CONNECTED"],
);
assert.deepEqual(Object.keys(events[0]).sort(), [
  "code",
  "deviceId",
  "eventId",
  "message",
  "protocolVersion",
  "sessionId",
  "state",
  "timestamp",
  "type",
]);
assert.equal(
  events.some((event) =>
    JSON.stringify(event).includes(command.deviceTicket),
  ),
  false,
);

const connectedEventCount = events.length;
await peer.handleOpenCommand(command);
assert.equal(events.length, connectedEventCount);
assert.equal(relayConnections, 1);

const localControl = nextMessage(localSocket);
relaySocket.send(Buffer.from([1, 2, 3]), { binary: true });
assert.deepEqual(await localControl, {
  data: Buffer.from([1, 2, 3]),
  isBinary: true,
});

const relayedDeviceFrame = nextMessage(relaySocket);
localSocket.send(Buffer.from([4, 5, 6, 7]), { binary: true });
assert.deepEqual(await relayedDeviceFrame, {
  data: Buffer.from([4, 5, 6, 7]),
  isBinary: true,
});

let relaySocketClosed = false;
let relayClosedAfterSpecificEvent = false;
relaySocket.once("close", () => {
  relaySocketClosed = true;
  relayClosedAfterSpecificEvent = events.some(
    (event) =>
      event.state === "CLOSED" &&
      event.code === "LOCAL_SCRCPY_TEXT_REJECTED",
  );
});
localSocket.send("unexpected text");
await waitFor(() => !peer.isActive(), "local text-frame rejection");
await waitFor(
  () =>
    events.some(
      (event) =>
        event.state === "CLOSED" &&
        event.code === "LOCAL_SCRCPY_TEXT_REJECTED",
    ),
  "CLOSED lifecycle event",
);
await waitFor(() => relaySocketClosed, "relay socket close");
assert.equal(relayClosedAfterSpecificEvent, true);
assert.equal(inactiveCalls, 1);

const terminalEventCount = events.length;
await peer.handleOpenCommand(command);
await new Promise<void>((resolve) => setTimeout(resolve, 50));
assert.equal(events.length, terminalEventCount);
assert.equal(relayConnections, 1);

await peer.handleOpenCommand({
  ...command,
  sessionId: "session_origin_bad",
  relayWsUrl: "wss://other.example.test/api/remote/ws",
});
await waitFor(
  () =>
    events.some(
      (event) =>
        event.sessionId === "session_origin_bad" &&
        event.code === "REMOTE_RELAY_ORIGIN_NOT_ALLOWED",
    ),
  "origin rejection event",
);

const busyEvents: RemoteSessionEvent[] = [];
const busyPeer = new RemoteSessionPeer({
  deviceId: baseCommand.deviceId,
  reportToken,
  allowedRelayOrigins: [relayOrigin],
  localScrcpyUrl: `ws://127.0.0.1:${localPort}/`,
  isDeploymentBlocked: () => false,
  isDeviceControlBusy: () => true,
  publishEvent: async (event) => {
    busyEvents.push(event);
  },
});
await busyPeer.handleOpenCommand({
  ...command,
  sessionId: "session_device_busy",
  deviceTicket: "B".repeat(32),
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
});
assert.equal(relayConnections, 1);
assert.equal(busyEvents.length, 1);
assert.equal(busyEvents[0].state, "REJECTED");
assert.equal(busyEvents[0].code, "DEVICE_CONTROL_BUSY");

const stalledEvents: RemoteSessionEvent[] = [];
const stalledPeer = new RemoteSessionPeer({
  deviceId: baseCommand.deviceId,
  reportToken,
  allowedRelayOrigins: [relayOrigin],
  localScrcpyUrl: `ws://127.0.0.1:${localPort}/`,
  isDeploymentBlocked: () => false,
  publishEvent: (event) => {
    stalledEvents.push(event);
    return event.state === "CLOSED"
      ? new Promise<void>(() => undefined)
      : Promise.resolve();
  },
});
await stalledPeer.handleOpenCommand({
  ...command,
  sessionId: "session_stalled_event",
  deviceTicket: "C".repeat(32),
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
});
await waitFor(() => relayConnections === 2, "stalled-event relay connection");
const stalledSocketClosed = new Promise<void>((resolve) => {
  relaySockets[1].once("close", () => resolve());
});
const closeStartedAt = Date.now();
await stalledPeer.close("BOUNDED_CLOSE_TEST", "Bounded close event test");
const closeElapsedMs = Date.now() - closeStartedAt;
await stalledSocketClosed;
assert.equal(
  stalledEvents.some(
    (event) =>
      event.state === "CLOSED" && event.code === "BOUNDED_CLOSE_TEST",
  ),
  true,
);
assert.equal(closeElapsedMs >= 200, true);
assert.equal(closeElapsedMs < 1_000, true);
assert.equal(stalledPeer.isActive(), false);

const p2pRelayHttp = http.createServer();
const p2pRelayConnection = deferred<{
  socket: WebSocket;
  request: IncomingMessage;
}>();
const p2pRelaySockets: WebSocket[] = [];
const p2pRelayHelloMessages: Array<
  Promise<{ data: Buffer; isBinary: boolean }>
> = [];
const p2pRelayServer = new WebSocketServer({
  server: p2pRelayHttp,
  path: "/api/remote/ws",
  perMessageDeflate: false,
  handleProtocols: (protocols) =>
    protocols.has(REMOTE_SESSION_SUBPROTOCOL_V2)
      ? REMOTE_SESSION_SUBPROTOCOL_V2
      : false,
});
p2pRelayServer.on("connection", (socket, request) => {
  p2pRelaySockets.push(socket);
  p2pRelayHelloMessages.push(nextMessage(socket));
  p2pRelayConnection.resolve({ socket, request });
});
const p2pRelayPort = await listenLoopback(p2pRelayHttp);

const p2pLocalHttp = http.createServer();
const p2pLocalSockets: WebSocket[] = [];
const firstP2PLocalMessage = deferred<{ data: Buffer; isBinary: boolean }>();
const directFallbackLocalMessage = deferred<{
  data: Buffer;
  isBinary: boolean;
}>();
const p2pLocalServer = new WebSocketServer({
  server: p2pLocalHttp,
  path: "/",
  perMessageDeflate: false,
});
p2pLocalServer.on("connection", (socket) => {
  p2pLocalSockets.push(socket);
  if (p2pLocalSockets.length === 1) {
    void nextMessage(socket).then(
      (message) => firstP2PLocalMessage.resolve(message),
      (error: unknown) => firstP2PLocalMessage.reject(error),
    );
  } else if (p2pLocalSockets.length === 3) {
    void nextMessage(socket).then(
      (message) => directFallbackLocalMessage.resolve(message),
      (error: unknown) => directFallbackLocalMessage.reject(error),
    );
  }
});
const p2pLocalPort = await listenLoopback(p2pLocalHttp);

let sidecarCallbacks: RtcSidecarCallbacks | null = null;
let sidecarClosed = false;
let sidecarIceServers: unknown = null;
const sidecarDeviceFrames: Buffer[] = [];
const fakeSidecar: RtcSidecarTransport = {
  start: (iceServers) => {
    sidecarIceServers = iceServers;
  },
  setRemoteDescription: (description) => {
    assert.equal(description.type, "offer");
    assert.equal(description.sdp, "v=0\r\n");
    sidecarCallbacks?.onIceCandidate({
      candidate: "candidate:device",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    sidecarCallbacks?.onLocalDescription({ type: "answer", sdp: "v=0\r\n" });
  },
  addIceCandidate: (candidate) => {
    assert.equal(candidate.candidate, "candidate:browser");
  },
  sendBinary: (content) => {
    sidecarDeviceFrames.push(Buffer.from(content));
  },
  close: () => {
    sidecarClosed = true;
  },
};
const p2pEvents: RemoteSessionEvent[] = [];
const p2pPeer = new RemoteSessionPeer({
  deviceId: baseCommand.deviceId,
  reportToken,
  allowedRelayOrigins: [`ws://127.0.0.1:${p2pRelayPort}`],
  localScrcpyUrl: `ws://127.0.0.1:${p2pLocalPort}/`,
  isDeploymentBlocked: () => false,
  publishEvent: async (event) => {
    p2pEvents.push(event);
  },
  createRtcSidecar: (callbacks) => {
    sidecarCallbacks = callbacks;
    return fakeSidecar;
  },
});
const p2pCommand: RemoteSessionOpenCommand = {
  ...baseCommand,
  sessionId: "session_p2p_12345678",
  relayWsUrl: `ws://127.0.0.1:${p2pRelayPort}/api/remote/ws`,
  deviceTicket: "D".repeat(32),
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  transportPreference: "p2p-preferred",
};
await p2pPeer.handleOpenCommand(p2pCommand);
const { socket: p2pRelaySocket, request: p2pRelayRequest } =
  await p2pRelayConnection.promise;
const p2pHelloMessage = await p2pRelayHelloMessages[0];
const p2pHello = JSON.parse(p2pHelloMessage.data.toString("utf8")) as Record<
  string,
  unknown
>;
assert.equal(p2pRelaySocket.protocol, REMOTE_SESSION_SUBPROTOCOL_V2);
assert.equal(p2pHello.protocolVersion, 2);
assert.equal(p2pHello.ticket, p2pCommand.deviceTicket);
assert.match(
  String(p2pRelayRequest.headers["sec-websocket-protocol"]),
  /autojs6-remote-v2.*autojs6-remote-v1/,
);
assert.equal(p2pLocalSockets.length, 0);

const attemptId = "attempt_12345678";
p2pRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.p2p.start",
    sessionId: p2pCommand.sessionId,
    attemptId,
    deadlineAt: Date.now() + 10_000,
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  }),
);
await waitFor(() => sidecarCallbacks !== null, "P2P sidecar creation");
assert.deepEqual(sidecarIceServers, [
  { urls: "stun:stun.cloudflare.com:3478" },
]);

const answerAndCandidatePromise = nextMessages(p2pRelaySocket, 2);
p2pRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.p2p.signal",
    sessionId: p2pCommand.sessionId,
    attemptId,
    sequence: 0,
    signalType: "offer",
    description: { type: "offer", sdp: "v=0\r\n" },
  }),
);
const [answerMessage, candidateMessage] = await answerAndCandidatePromise;
const answerFrame = JSON.parse(answerMessage.data.toString("utf8")) as Record<
  string,
  unknown
>;
assert.equal(answerFrame.type, "relay.p2p.signal");
assert.equal(answerFrame.signalType, "answer");
assert.equal(answerFrame.sequence, 0);
const candidateFrame = JSON.parse(
  candidateMessage.data.toString("utf8"),
) as Record<string, unknown>;
assert.equal(candidateFrame.signalType, "ice-candidate");
assert.equal(candidateFrame.sequence, 1);

p2pRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.p2p.signal",
    sessionId: p2pCommand.sessionId,
    attemptId,
    sequence: 1,
    signalType: "ice-candidate",
    candidate: {
      candidate: "candidate:browser",
      sdpMid: "0",
      sdpMLineIndex: 0,
    },
  }),
);
const readyStatePromise = nextMessage(p2pRelaySocket);
sidecarCallbacks?.onState({
  state: "ready",
  selectedPair: {
    localCandidateType: "host",
    remoteCandidateType: "srflx",
    protocol: "udp",
  },
});
const readyState = JSON.parse(
  (await readyStatePromise).data.toString("utf8"),
) as Record<string, unknown>;
assert.equal(readyState.type, "relay.p2p.state");
assert.equal(readyState.state, "ready");
assert.equal(readyState.sequence, 2);
assert.equal(
  JSON.stringify(readyState).includes("candidate:device"),
  false,
);

const p2pPreReadyControl = Buffer.from([12, 11, 10]);
sidecarCallbacks?.onBinary(p2pPreReadyControl);
await new Promise<void>((resolve) => setTimeout(resolve, 20));
assert.equal(p2pPeer.isActive(), true);
assert.equal(p2pLocalSockets.length, 0);

p2pRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.ready",
    sessionId: p2pCommand.sessionId,
    transport: "p2p",
    expiresAt: p2pCommand.expiresAt,
  }),
);
await waitFor(() => p2pLocalSockets.length === 1, "P2P local scrcpy bridge");
const firstP2PLocalSocket = p2pLocalSockets[0];
assert.deepEqual(await firstP2PLocalMessage.promise, {
  data: p2pPreReadyControl,
  isBinary: true,
});
await waitFor(
  () => p2pEvents.some((event) => event.code === "REMOTE_P2P_BRIDGED"),
  "P2P connected event",
);

const p2pLocalControl = nextMessage(firstP2PLocalSocket);
sidecarCallbacks?.onBinary(Buffer.from([9, 8, 7]));
assert.deepEqual(await p2pLocalControl, {
  data: Buffer.from([9, 8, 7]),
  isBinary: true,
});
firstP2PLocalSocket.send(Buffer.from([6, 5, 4]), { binary: true });
await waitFor(() => sidecarDeviceFrames.length === 1, "P2P device frame");
assert.deepEqual(sidecarDeviceFrames[0], Buffer.from([6, 5, 4]));

const failedStatePromise = nextMessage(p2pRelaySocket);
sidecarCallbacks?.onIceCandidate({
  candidate: "candidate:late-after-ready",
  sdpMid: "0",
  sdpMLineIndex: 0,
});
sidecarCallbacks?.onState({ state: "failed", reasonCode: "RTC_TEST_FAILURE" });
const failedState = JSON.parse(
  (await failedStatePromise).data.toString("utf8"),
) as Record<string, unknown>;
assert.equal(failedState.type, "relay.p2p.state");
assert.equal(failedState.state, "failed");
assert.equal(failedState.sequence, 3);
assert.equal(failedState.reasonCode, "RTC_TEST_FAILURE");
assert.equal(sidecarClosed, true);

p2pRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.p2p.signal",
    sessionId: p2pCommand.sessionId,
    attemptId,
    sequence: 2,
    signalType: "ice-candidate",
    candidate: { candidate: "candidate:late" },
  }),
);
await new Promise<void>((resolve) => setTimeout(resolve, 20));
assert.equal(p2pPeer.isActive(), true);

const recoveryAckPromise = nextMessage(p2pRelaySocket);
p2pRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.transport",
    sessionId: p2pCommand.sessionId,
    transport: "relay",
    phase: "recovering",
    reasonCode: "RTC_TEST_FAILURE",
  }),
);
await waitFor(() => p2pLocalSockets.length === 2, "replacement local scrcpy bridge");
const replacementLocalSocket = p2pLocalSockets[1];
const recoveryAck = JSON.parse(
  (await recoveryAckPromise).data.toString("utf8"),
) as Record<string, unknown>;
assert.equal(recoveryAck.type, "relay.transport.state");
assert.equal(recoveryAck.state, "ready");

replacementLocalSocket.send(Buffer.from([3, 2, 1]), { binary: true });
const recoveredDeviceFramePromise = nextMessage(p2pRelaySocket);
p2pRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.transport",
    sessionId: p2pCommand.sessionId,
    transport: "relay",
    phase: "ready",
    reasonCode: "RTC_TEST_FAILURE",
  }),
);
assert.deepEqual(await recoveredDeviceFramePromise, {
  data: Buffer.from([3, 2, 1]),
  isBinary: true,
});
const recoveredControlPromise = nextMessage(replacementLocalSocket);
p2pRelaySocket.send(Buffer.from([1, 3, 5]), { binary: true });
assert.deepEqual(await recoveredControlPromise, {
  data: Buffer.from([1, 3, 5]),
  isBinary: true,
});

await p2pPeer.close("TEST_COMPLETE", "P2P remote test completed");

let raceCallbacks: RtcSidecarCallbacks | null = null;
let raceSidecarClosed = false;
const raceEvents: RemoteSessionEvent[] = [];
const racePeer = new RemoteSessionPeer({
  deviceId: baseCommand.deviceId,
  reportToken,
  allowedRelayOrigins: [`ws://127.0.0.1:${p2pRelayPort}`],
  localScrcpyUrl: `ws://127.0.0.1:${p2pLocalPort}/`,
  isDeploymentBlocked: () => false,
  publishEvent: async (event) => {
    raceEvents.push(event);
  },
  createRtcSidecar: (callbacks) => {
    raceCallbacks = callbacks;
    return {
      start: () => undefined,
      setRemoteDescription: () =>
        callbacks.onLocalDescription({ type: "answer", sdp: "v=0\r\n" }),
      addIceCandidate: () => undefined,
      sendBinary: () => undefined,
      close: () => {
        raceSidecarClosed = true;
      },
    };
  },
});
const raceCommand: RemoteSessionOpenCommand = {
  ...p2pCommand,
  sessionId: "session_race_12345678",
  deviceTicket: "E".repeat(32),
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};
await racePeer.handleOpenCommand(raceCommand);
await waitFor(() => p2pRelaySockets.length === 2, "ready-failure race relay");
const raceRelaySocket = p2pRelaySockets[1];
await p2pRelayHelloMessages[1];
const raceAttemptId = "attempt_race_12345678";
raceRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.p2p.start",
    sessionId: raceCommand.sessionId,
    attemptId: raceAttemptId,
    deadlineAt: Date.now() + 10_000,
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  }),
);
await waitFor(() => raceCallbacks !== null, "ready-failure race sidecar");
const raceAnswerPromise = nextMessage(raceRelaySocket);
raceRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.p2p.signal",
    sessionId: raceCommand.sessionId,
    attemptId: raceAttemptId,
    sequence: 0,
    signalType: "offer",
    description: { type: "offer", sdp: "v=0\r\n" },
  }),
);
assert.equal(
  JSON.parse((await raceAnswerPromise).data.toString("utf8")).signalType,
  "answer",
);
const raceReadyPromise = nextMessage(raceRelaySocket);
raceCallbacks?.onState({ state: "ready" });
const raceReady = JSON.parse(
  (await raceReadyPromise).data.toString("utf8"),
) as Record<string, unknown>;
assert.equal(raceReady.state, "ready");
assert.equal(raceReady.sequence, 1);
const raceFailedPromise = nextMessage(raceRelaySocket);
raceCallbacks?.onState({
  state: "failed",
  reasonCode: "RTC_FAILED_BEFORE_SELECTION",
});
const raceFailed = JSON.parse(
  (await raceFailedPromise).data.toString("utf8"),
) as Record<string, unknown>;
assert.equal(raceFailed.state, "failed");
assert.equal(raceFailed.sequence, 2);
assert.equal(raceFailed.reasonCode, "RTC_FAILED_BEFORE_SELECTION");
assert.equal(raceSidecarClosed, true);
const raceRelayPreReadyControl = Buffer.from([7, 0, 7]);
raceRelaySocket.send(raceRelayPreReadyControl, { binary: true });
raceRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.ready",
    sessionId: raceCommand.sessionId,
    transport: "relay",
    expiresAt: raceCommand.expiresAt,
    reasonCode: "RTC_FAILED_BEFORE_SELECTION",
  }),
);
await waitFor(
  () => p2pLocalSockets.length === 3,
  "ready-failure race relay fallback",
);
await waitFor(
  () => raceEvents.some((event) => event.code === "REMOTE_RELAY_BRIDGED"),
  "ready-failure fallback connected event",
);
assert.deepEqual(await directFallbackLocalMessage.promise, {
  data: raceRelayPreReadyControl,
  isBinary: true,
});
await racePeer.close("TEST_COMPLETE", "P2P selection race test completed");

let staleReadyCallbacks: RtcSidecarCallbacks | null = null;
let staleReadySidecarClosed = false;
const staleReadyEvents: RemoteSessionEvent[] = [];
const staleReadyPeer = new RemoteSessionPeer({
  deviceId: baseCommand.deviceId,
  reportToken,
  allowedRelayOrigins: [`ws://127.0.0.1:${p2pRelayPort}`],
  localScrcpyUrl: `ws://127.0.0.1:${p2pLocalPort}/`,
  isDeploymentBlocked: () => false,
  publishEvent: async (event) => {
    staleReadyEvents.push(event);
  },
  createRtcSidecar: (callbacks) => {
    staleReadyCallbacks = callbacks;
    return {
      start: () => undefined,
      setRemoteDescription: () =>
        callbacks.onLocalDescription({ type: "answer", sdp: "v=0\r\n" }),
      addIceCandidate: () => undefined,
      sendBinary: () => undefined,
      close: () => {
        staleReadySidecarClosed = true;
      },
    };
  },
});
const staleReadyCommand: RemoteSessionOpenCommand = {
  ...p2pCommand,
  sessionId: "session_stale_ready_12345678",
  deviceTicket: "F".repeat(32),
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};
await staleReadyPeer.handleOpenCommand(staleReadyCommand);
await waitFor(() => p2pRelaySockets.length === 3, "stale-ready race relay");
const staleReadyRelaySocket = p2pRelaySockets[2];
await p2pRelayHelloMessages[2];
const staleReadyAttemptId = "attempt_stale_ready_12345678";
staleReadyRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.p2p.start",
    sessionId: staleReadyCommand.sessionId,
    attemptId: staleReadyAttemptId,
    deadlineAt: Date.now() + 10_000,
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  }),
);
await waitFor(() => staleReadyCallbacks !== null, "stale-ready sidecar");
const staleReadyAnswerPromise = nextMessage(staleReadyRelaySocket);
staleReadyRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.p2p.signal",
    sessionId: staleReadyCommand.sessionId,
    attemptId: staleReadyAttemptId,
    sequence: 0,
    signalType: "offer",
    description: { type: "offer", sdp: "v=0\r\n" },
  }),
);
assert.equal(
  JSON.parse((await staleReadyAnswerPromise).data.toString("utf8")).signalType,
  "answer",
);
const staleReadyStatePromise = nextMessage(staleReadyRelaySocket);
staleReadyCallbacks?.onState({ state: "ready" });
const staleReadyState = JSON.parse(
  (await staleReadyStatePromise).data.toString("utf8"),
) as Record<string, unknown>;
assert.equal(staleReadyState.state, "ready");
assert.equal(staleReadyState.sequence, 1);
const staleFailedStatePromise = nextMessage(staleReadyRelaySocket);
staleReadyCallbacks?.onState({ state: "disconnected" });
const staleFailedState = JSON.parse(
  (await staleFailedStatePromise).data.toString("utf8"),
) as Record<string, unknown>;
assert.equal(staleFailedState.state, "failed");
assert.equal(staleFailedState.sequence, 2);
assert.equal(staleFailedState.reasonCode, "RTC_DISCONNECTED_TIMEOUT");
assert.equal(staleReadySidecarClosed, true);

staleReadyRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.ready",
    sessionId: staleReadyCommand.sessionId,
    transport: "p2p",
    expiresAt: staleReadyCommand.expiresAt,
  }),
);
await new Promise<void>((resolve) => setTimeout(resolve, 20));
assert.equal(staleReadyPeer.isActive(), true);
assert.equal(p2pLocalSockets.length, 3);

const staleRecoveryAckPromise = nextMessage(staleReadyRelaySocket);
staleReadyRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.transport",
    sessionId: staleReadyCommand.sessionId,
    transport: "relay",
    phase: "recovering",
    reasonCode: "RTC_DISCONNECTED_TIMEOUT",
  }),
);
await waitFor(
  () => p2pLocalSockets.length === 4,
  "stale-ready relay recovery bridge",
);
const staleReadyLocalSocket = p2pLocalSockets[3];
const staleRecoveryAck = JSON.parse(
  (await staleRecoveryAckPromise).data.toString("utf8"),
) as Record<string, unknown>;
assert.equal(staleRecoveryAck.type, "relay.transport.state");
assert.equal(staleRecoveryAck.state, "ready");

const staleRecoveredDeviceFramePromise = nextMessage(staleReadyRelaySocket);
staleReadyLocalSocket.send(Buffer.from([4, 2, 4, 2]), { binary: true });
staleReadyRelaySocket.send(
  JSON.stringify({
    protocolVersion: 2,
    type: "relay.transport",
    sessionId: staleReadyCommand.sessionId,
    transport: "relay",
    phase: "ready",
    reasonCode: "RTC_DISCONNECTED_TIMEOUT",
  }),
);
assert.deepEqual(await staleRecoveredDeviceFramePromise, {
  data: Buffer.from([4, 2, 4, 2]),
  isBinary: true,
});
const staleRecoveredControlPromise = nextMessage(staleReadyLocalSocket);
staleReadyRelaySocket.send(Buffer.from([2, 4, 2, 4]), { binary: true });
assert.deepEqual(await staleRecoveredControlPromise, {
  data: Buffer.from([2, 4, 2, 4]),
  isBinary: true,
});
await waitFor(
  () =>
    staleReadyEvents.some(
      (event) =>
        event.state === "CONNECTED" && event.code === "REMOTE_RELAY_BRIDGED",
    ),
  "stale-ready relay connected event",
);
await staleReadyPeer.close(
  "TEST_COMPLETE",
  "Stale P2P ready recovery test completed",
);

await closeServers(p2pLocalServer, p2pLocalHttp);
await closeServers(p2pRelayServer, p2pRelayHttp);

await peer.close("TEST_COMPLETE", "Remote relay test completed");
await closeServers(localServer, localHttp);
await closeServers(relayServer, relayHttp);

console.log("remote session protocol and relay peer tests passed");
