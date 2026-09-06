import { isRecord } from "./protocol.js";

/** Legacy remote-control relay protocol version. */
export const REMOTE_SESSION_PROTOCOL_VERSION_V1 = 1 as const;

/** P2P-capable remote-control relay protocol version. */
export const REMOTE_SESSION_PROTOCOL_VERSION_V2 = 2 as const;

/** MQTT and lifecycle protocol alias retained for compatibility. */
export const REMOTE_SESSION_PROTOCOL_VERSION =
  REMOTE_SESSION_PROTOCOL_VERSION_V1;

/** Negotiated remote-control relay protocol version. */
export type RemoteSessionProtocolVersion =
  | typeof REMOTE_SESSION_PROTOCOL_VERSION_V1
  | typeof REMOTE_SESSION_PROTOCOL_VERSION_V2;

/** Legacy WebSocket subprotocol shared by relay-only peers. */
export const REMOTE_SESSION_SUBPROTOCOL_V1 = "autojs6-remote-v1";

/** P2P-capable WebSocket subprotocol shared by current peers. */
export const REMOTE_SESSION_SUBPROTOCOL_V2 = "autojs6-remote-v2";

/** Legacy subprotocol alias retained for existing callers and tests. */
export const REMOTE_SESSION_SUBPROTOCOL = REMOTE_SESSION_SUBPROTOCOL_V1;

/** Subprotocol preference order offered by a current mobile client. */
export const REMOTE_SESSION_SUBPROTOCOLS = [
  REMOTE_SESSION_SUBPROTOCOL_V2,
  REMOTE_SESSION_SUBPROTOCOL_V1,
] as const;

/** Fixed public relay path; tickets are never placed in this URL. */
export const REMOTE_SESSION_RELAY_PATH = "/api/remote/ws";

/** Smallest accepted remote-control lease. */
export const REMOTE_SESSION_MIN_TTL_MS = 30_000;

/** Largest accepted remote-control lease. */
export const REMOTE_SESSION_MAX_TTL_MS = 30 * 60 * 1000;

/** Maximum control frame relayed from a browser to scrcpy. */
export const REMOTE_BROWSER_FRAME_MAX_BYTES = 64 * 1024;

/** Maximum video/device frame relayed from scrcpy to a browser. */
export const REMOTE_DEVICE_FRAME_MAX_BYTES = 4 * 1024 * 1024;

/** Default loopback endpoint exposed by the ws-scrcpy Android server. */
export const DEFAULT_LOCAL_SCRCPY_URL = "ws://127.0.0.1:8886/";

/** MQTT invitation for one device-initiated remote-control lease. */
export interface RemoteSessionOpenCommand {
  protocolVersion: 1;
  type: "OPEN_REMOTE_SESSION";
  sessionId: string;
  deviceId: string;
  relayWsUrl: string;
  deviceTicket: string;
  issuedAt: number;
  expiresAt: number;
  transportPreference: "relay" | "p2p-preferred";
}

/** First JSON message sent by a device after the relay WSS upgrade. */
export interface RemoteRelayHello {
  protocolVersion: RemoteSessionProtocolVersion;
  type: "relay.hello";
  role: "device";
  sessionId: string;
  deviceId: string;
  ticket: string;
  timestamp: number;
}

/** One STUN-only ICE server disclosed by the trusted relay service. */
export interface RemoteRelayIceServer {
  urls: string | string[];
}

/** Server instruction to begin one bounded P2P negotiation attempt. */
export interface RemoteRelayP2PStart {
  protocolVersion: 2;
  type: "relay.p2p.start";
  sessionId: string;
  attemptId: string;
  deadlineAt: number;
  iceServers: RemoteRelayIceServer[];
}

/** Strictly bounded WebRTC description or candidate relay message. */
export interface RemoteRelayP2PSignal {
  protocolVersion: 2;
  type: "relay.p2p.signal";
  sessionId: string;
  attemptId: string;
  sequence: number;
  signalType: "offer" | "answer" | "ice-candidate";
  description?: { type: "offer" | "answer"; sdp: string };
  candidate?: {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
  };
}

/** Sanitized ICE candidate pair supplied only for diagnostics. */
export interface RemoteRelaySelectedPair {
  localCandidateType: "host" | "srflx" | "prflx" | "relay";
  remoteCandidateType: "host" | "srflx" | "prflx" | "relay";
  protocol: "udp" | "tcp";
}

/** Device report for one P2P negotiation or active transport failure. */
export interface RemoteRelayP2PState {
  protocolVersion: 2;
  type: "relay.p2p.state";
  sessionId: string;
  attemptId: string;
  sequence: number;
  state: "ready" | "failed";
  reasonCode?: string;
  selectedPair?: RemoteRelaySelectedPair;
}

/** Relay response selecting the initial data transport. */
export type RemoteRelayReady =
  | {
      protocolVersion: 1;
      type: "relay.ready";
      sessionId: string;
      transport: "relay";
      expiresAt: number;
    }
  | {
      protocolVersion: 2;
      type: "relay.ready";
      sessionId: string;
      transport: "relay" | "p2p";
      expiresAt: number;
      reasonCode?: string;
    };

/** Server instruction for the single supported P2P-to-relay recovery. */
export interface RemoteRelayTransport {
  protocolVersion: 2;
  type: "relay.transport";
  sessionId: string;
  transport: "relay";
  phase: "recovering" | "ready";
  reasonCode: string;
}

/** Device acknowledgement that the replacement relay path is locally ready. */
export interface RemoteRelayTransportState {
  protocolVersion: 2;
  type: "relay.transport.state";
  sessionId: string;
  transport: "relay";
  state: "ready";
}

/** Terminal relay control message. */
export interface RemoteRelayTerminal {
  protocolVersion: RemoteSessionProtocolVersion;
  type: "relay.error" | "relay.closed";
  sessionId: string;
  code: string;
  message: string;
}

/** Server-to-device text control frame accepted by the relay peer. */
export type RemoteRelayControl =
  | RemoteRelayReady
  | RemoteRelayP2PStart
  | RemoteRelayP2PSignal
  | RemoteRelayTransport
  | RemoteRelayTerminal;

/** Sanitized lifecycle event published for audit and diagnostics. */
export interface RemoteSessionEvent {
  protocolVersion: 1;
  type: "REMOTE_SESSION_EVENT";
  eventId: string;
  sessionId: string;
  deviceId: string;
  state: "CONNECTING" | "CONNECTED" | "CLOSED" | "REJECTED";
  code: string;
  message: string;
  timestamp: number;
}

/**
 * Check whether a value is a bounded relay identifier.
 *
 * @param value Unknown identifier candidate.
 * @returns Whether the value is safe to use in the remote-session protocol.
 */
function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value);
}

/**
 * Check whether a value is a bounded machine-readable reason code.
 *
 * @param value Unknown reason candidate.
 * @returns Whether the reason can be retained in sanitized diagnostics.
 */
function validReasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9_]{1,100}$/.test(value);
}

/**
 * Reject undeclared keys from a security-sensitive protocol object.
 *
 * @param value Object whose keys are inspected.
 * @param keys Exact accepted keys.
 * @returns Nothing.
 */
function requireOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Remote session object contains unsupported fields");
  }
}

/**
 * Normalize and validate a public relay URL.
 *
 * @param value Unknown relay URL candidate.
 * @returns Canonical credential-free relay URL.
 */
export function parseRemoteRelayUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("relayWsUrl must be a string");
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("relayWsUrl must use WSS except for a loopback demo");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== REMOTE_SESSION_RELAY_PATH
  ) {
    throw new Error("relayWsUrl must use the fixed credential-free relay path");
  }
  return url.toString();
}

/**
 * Normalize an explicitly configured relay origin allowlist entry.
 *
 * @param value Unknown origin candidate.
 * @returns Canonical WSS origin, or an IPv4-loopback WS origin for ADB demos.
 */
export function parseRemoteRelayOrigin(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new Error("Remote relay origin must be a trimmed string");
  }
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("Remote relay origin must use WSS except on IPv4 loopback");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.origin !== value
  ) {
    throw new Error("Remote relay allowlist entries must be exact origins");
  }
  return url.origin;
}

/**
 * Normalize a configured loopback-only ws-scrcpy endpoint.
 *
 * @param value Unknown local endpoint candidate.
 * @returns Canonical loopback WebSocket URL with a bounded explicit port.
 */
export function parseLocalScrcpyUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("localScrcpyUrl must be a string");
  const url = new URL(value);
  const port = Number(url.port);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("localScrcpyUrl must be a credential-free loopback WebSocket");
  }
  return url.toString();
}

/**
 * Parse an unknown MQTT remote-control invitation.
 *
 * @param value Untrusted MQTT message value.
 * @returns Strict normalized one-time relay invitation.
 */
export function parseRemoteSessionOpenCommand(
  value: unknown,
): RemoteSessionOpenCommand {
  if (!isRecord(value)) throw new Error("Remote session command must be an object");
  requireOnlyKeys(value, [
    "protocolVersion",
    "type",
    "sessionId",
    "deviceId",
    "relayWsUrl",
    "deviceTicket",
    "issuedAt",
    "expiresAt",
    "transportPreference",
  ]);
  if (
    value.protocolVersion !== REMOTE_SESSION_PROTOCOL_VERSION ||
    value.type !== "OPEN_REMOTE_SESSION" ||
    !validIdentifier(value.sessionId) ||
    typeof value.deviceId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(value.deviceId) ||
    typeof value.deviceTicket !== "string" ||
    !/^[A-Za-z0-9_-]{32,100}$/.test(value.deviceTicket) ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.issuedAt as number) < 0 ||
    (value.expiresAt as number) < 0
  ) {
    throw new Error("Invalid remote session command envelope");
  }
  const ttl = (value.expiresAt as number) - (value.issuedAt as number);
  if (ttl < REMOTE_SESSION_MIN_TTL_MS || ttl > REMOTE_SESSION_MAX_TTL_MS) {
    throw new Error("Remote session lease must be between 30 seconds and 30 minutes");
  }
  if (
    value.transportPreference !== undefined &&
    value.transportPreference !== "relay" &&
    value.transportPreference !== "p2p-preferred"
  ) {
    throw new Error("Unsupported remote session transport preference");
  }
  return {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    type: "OPEN_REMOTE_SESSION",
    sessionId: value.sessionId,
    deviceId: value.deviceId,
    relayWsUrl: parseRemoteRelayUrl(value.relayWsUrl),
    deviceTicket: value.deviceTicket,
    issuedAt: value.issuedAt as number,
    expiresAt: value.expiresAt as number,
    transportPreference:
      value.transportPreference === "p2p-preferred" ? "p2p-preferred" : "relay",
  };
}

/**
 * Parse one STUN-only server descriptor.
 *
 * @param value Untrusted ICE server descriptor.
 * @returns Strict normalized STUN server.
 */
function parseIceServer(value: unknown): RemoteRelayIceServer {
  if (!isRecord(value)) throw new Error("ICE server must be an object");
  requireOnlyKeys(value, ["urls"]);
  const rawUrls = typeof value.urls === "string" ? [value.urls] : value.urls;
  if (
    !Array.isArray(rawUrls) ||
    rawUrls.length < 1 ||
    rawUrls.length > 4 ||
    rawUrls.some(
      (url) =>
        typeof url !== "string" ||
        url.length < 6 ||
        url.length > 2048 ||
        !/^stuns?:[^\s?#]+$/i.test(url),
    )
  ) {
    throw new Error("Only bounded STUN ICE URLs are supported");
  }
  const urls = rawUrls as string[];
  return { urls: typeof value.urls === "string" ? urls[0] : [...urls] };
}

/**
 * Parse a server-to-device P2P signal.
 *
 * @param value Untrusted signaling frame.
 * @param expectedSessionId Session identifier bound to the relay socket.
 * @returns Strict bounded offer or ICE candidate.
 */
function parseP2PSignal(
  value: Record<string, unknown>,
  expectedSessionId: string,
): RemoteRelayP2PSignal {
  requireOnlyKeys(value, [
    "protocolVersion",
    "type",
    "sessionId",
    "attemptId",
    "sequence",
    "signalType",
    "description",
    "candidate",
  ]);
  if (
    value.protocolVersion !== REMOTE_SESSION_PROTOCOL_VERSION_V2 ||
    value.sessionId !== expectedSessionId ||
    !validIdentifier(value.attemptId) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.sequence as number) > 1_000_000 ||
    (value.signalType !== "offer" && value.signalType !== "ice-candidate")
  ) {
    throw new Error("Invalid device P2P signal");
  }
  if (value.signalType === "offer") {
    if (!isRecord(value.description) || value.candidate !== undefined) {
      throw new Error("P2P offer is required");
    }
    requireOnlyKeys(value.description, ["type", "sdp"]);
    if (
      value.description.type !== "offer" ||
      typeof value.description.sdp !== "string" ||
      value.description.sdp.length < 1 ||
      Buffer.byteLength(value.description.sdp, "utf8") > 48 * 1024
    ) {
      throw new Error("Invalid P2P offer");
    }
    return {
      protocolVersion: 2,
      type: "relay.p2p.signal",
      sessionId: expectedSessionId,
      attemptId: value.attemptId,
      sequence: value.sequence as number,
      signalType: "offer",
      description: { type: "offer", sdp: value.description.sdp },
    };
  }
  if (!isRecord(value.candidate) || value.description !== undefined) {
    throw new Error("P2P ICE candidate is required");
  }
  requireOnlyKeys(value.candidate, ["candidate", "sdpMid", "sdpMLineIndex"]);
  if (
    typeof value.candidate.candidate !== "string" ||
    value.candidate.candidate.length > 4096 ||
    (value.candidate.sdpMid !== undefined &&
      (typeof value.candidate.sdpMid !== "string" || value.candidate.sdpMid.length > 256)) ||
    (value.candidate.sdpMLineIndex !== undefined &&
      (!Number.isInteger(value.candidate.sdpMLineIndex) ||
        (value.candidate.sdpMLineIndex as number) < 0 ||
        (value.candidate.sdpMLineIndex as number) > 1024))
  ) {
    throw new Error("Invalid P2P ICE candidate");
  }
  return {
    protocolVersion: 2,
    type: "relay.p2p.signal",
    sessionId: expectedSessionId,
    attemptId: value.attemptId,
    sequence: value.sequence as number,
    signalType: "ice-candidate",
    candidate: {
      candidate: value.candidate.candidate,
      ...(value.candidate.sdpMid === undefined
        ? {}
        : { sdpMid: value.candidate.sdpMid as string }),
      ...(value.candidate.sdpMLineIndex === undefined
        ? {}
        : { sdpMLineIndex: value.candidate.sdpMLineIndex as number }),
    },
  };
}

/**
 * Parse the bounded server-to-device text control protocol.
 *
 * @param value Untrusted parsed relay text frame.
 * @param expectedSessionId Session identifier bound to the current socket.
 * @param expectedVersion WebSocket-negotiated protocol version.
 * @returns Strict relay control message.
 */
export function parseRemoteRelayControl(
  value: unknown,
  expectedSessionId: string,
  expectedVersion: RemoteSessionProtocolVersion = 1,
): RemoteRelayControl {
  if (!isRecord(value)) throw new Error("Relay control frame must be an object");
  if (value.type === "relay.ready") {
    requireOnlyKeys(value, [
      "protocolVersion",
      "type",
      "sessionId",
      "transport",
      "expiresAt",
      "reasonCode",
    ]);
    if (
      value.protocolVersion !== expectedVersion ||
      value.sessionId !== expectedSessionId ||
      !Number.isSafeInteger(value.expiresAt) ||
      (value.reasonCode !== undefined && !validReasonCode(value.reasonCode)) ||
      (expectedVersion === 1
        ? value.transport !== "relay" || value.reasonCode !== undefined
        : value.transport !== "relay" && value.transport !== "p2p")
    ) {
      throw new Error("Invalid relay.ready frame");
    }
    return expectedVersion === 1
      ? {
          protocolVersion: 1,
          type: "relay.ready",
          sessionId: expectedSessionId,
          transport: "relay",
          expiresAt: value.expiresAt as number,
        }
      : {
          protocolVersion: 2,
          type: "relay.ready",
          sessionId: expectedSessionId,
          transport: value.transport as "relay" | "p2p",
          expiresAt: value.expiresAt as number,
          ...(value.reasonCode === undefined
            ? {}
            : { reasonCode: value.reasonCode as string }),
        };
  }
  if (value.type === "relay.p2p.start") {
    if (expectedVersion !== 2) throw new Error("P2P start requires protocol v2");
    requireOnlyKeys(value, [
      "protocolVersion",
      "type",
      "sessionId",
      "attemptId",
      "deadlineAt",
      "iceServers",
    ]);
    if (
      value.protocolVersion !== 2 ||
      value.sessionId !== expectedSessionId ||
      !validIdentifier(value.attemptId) ||
      !Number.isSafeInteger(value.deadlineAt) ||
      !Array.isArray(value.iceServers) ||
      value.iceServers.length < 1 ||
      value.iceServers.length > 4
    ) {
      throw new Error("Invalid relay.p2p.start frame");
    }
    return {
      protocolVersion: 2,
      type: "relay.p2p.start",
      sessionId: expectedSessionId,
      attemptId: value.attemptId,
      deadlineAt: value.deadlineAt as number,
      iceServers: value.iceServers.map(parseIceServer),
    };
  }
  if (value.type === "relay.p2p.signal") {
    if (expectedVersion !== 2) throw new Error("P2P signal requires protocol v2");
    return parseP2PSignal(value, expectedSessionId);
  }
  if (value.type === "relay.transport") {
    requireOnlyKeys(value, [
      "protocolVersion",
      "type",
      "sessionId",
      "transport",
      "phase",
      "reasonCode",
    ]);
    if (
      expectedVersion !== 2 ||
      value.protocolVersion !== 2 ||
      value.sessionId !== expectedSessionId ||
      value.transport !== "relay" ||
      (value.phase !== "recovering" && value.phase !== "ready") ||
      !validReasonCode(value.reasonCode)
    ) {
      throw new Error("Invalid relay.transport frame");
    }
    return {
      protocolVersion: 2,
      type: "relay.transport",
      sessionId: expectedSessionId,
      transport: "relay",
      phase: value.phase,
      reasonCode: value.reasonCode,
    };
  }
  if (value.type === "relay.error" || value.type === "relay.closed") {
    requireOnlyKeys(value, ["protocolVersion", "type", "sessionId", "code", "message"]);
    if (
      value.protocolVersion !== expectedVersion ||
      value.sessionId !== expectedSessionId ||
      !validReasonCode(value.code) ||
      typeof value.message !== "string" ||
      value.message.length < 1 ||
      value.message.length > 1000
    ) {
      throw new Error("Invalid terminal relay control frame");
    }
    return {
      protocolVersion: expectedVersion,
      type: value.type,
      sessionId: expectedSessionId,
      code: value.code,
      message: value.message,
    };
  }
  throw new Error("Unsupported relay control frame");
}
