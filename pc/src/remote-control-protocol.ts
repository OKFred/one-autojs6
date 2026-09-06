import { createHash } from "node:crypto";

import {
  isDeviceOpsClientId,
  isDeviceOpsId,
  isDeviceOpsRecord,
  normalizeDeviceOpsWsUrl,
  safeDeviceOpsSecretEqual,
} from "./device-ops-protocol.js";

/** Legacy remote-control relay protocol version. */
export const REMOTE_CONTROL_PROTOCOL_VERSION_V1 = 1 as const;

/** P2P-capable remote-control relay protocol version. */
export const REMOTE_CONTROL_PROTOCOL_VERSION_V2 = 2 as const;

/** Legacy protocol alias retained for MQTT invitation compatibility. */
export const REMOTE_CONTROL_PROTOCOL_VERSION =
  REMOTE_CONTROL_PROTOCOL_VERSION_V1;

/** Supported remote-control relay application protocol versions. */
export type RemoteControlProtocolVersion =
  | typeof REMOTE_CONTROL_PROTOCOL_VERSION_V1
  | typeof REMOTE_CONTROL_PROTOCOL_VERSION_V2;

/** Maximum JSON control frame accepted by the relay. */
export const REMOTE_CONTROL_MAX_JSON_BYTES = 64 * 1024;

/** Maximum opaque scrcpy control frame accepted from a browser. */
export const REMOTE_CONTROL_MAX_CONTROLLER_BINARY_BYTES = 64 * 1024;

/** Maximum opaque scrcpy media frame accepted from a device. */
export const REMOTE_CONTROL_MAX_DEVICE_BINARY_BYTES = 4 * 1024 * 1024;

/** Minimum remote-control lease lifetime. */
export const REMOTE_CONTROL_MIN_TTL_MS = 30_000;

/** Default remote-control lease lifetime. */
export const REMOTE_CONTROL_DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Maximum remote-control lease lifetime. */
export const REMOTE_CONTROL_MAX_TTL_MS = 30 * 60 * 1000;

/** Browser transport preference accepted by session creation. */
export type RemoteControlTransportPreference = "relay" | "p2p-preferred";

/** Strict HTTP input for one temporary remote-control lease. */
export interface RemoteControlCreateInput {
  clientId: string;
  ttlMs: number;
  transportPreference: RemoteControlTransportPreference;
}

/** MQTT invitation asking one device to connect outbound to the relay. */
export interface RemoteControlOpenSessionCommand {
  protocolVersion: 1;
  type: "OPEN_REMOTE_SESSION";
  sessionId: string;
  deviceId: string;
  relayWsUrl: string;
  deviceTicket: string;
  issuedAt: number;
  expiresAt: number;
}

/** Role associated with one relay peer. */
export type RemoteControlPeerRole = "controller" | "device";

/** First application frame required from either outbound relay peer. */
export interface RemoteControlHello {
  protocolVersion: RemoteControlProtocolVersion;
  type: "relay.hello";
  role: RemoteControlPeerRole;
  sessionId: string;
  deviceId?: string;
  ticket: string;
  timestamp: number;
}

/** Strictly bounded WebRTC description or ICE candidate relay message. */
export interface RemoteControlP2PSignal {
  protocolVersion: 2;
  type: "relay.p2p.signal";
  sessionId: string;
  attemptId: string;
  sequence: number;
  signalType: "offer" | "answer" | "ice-candidate";
  description?: {
    type: "offer" | "answer";
    sdp: string;
  };
  candidate?: {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
  };
}

/** Sanitized ICE candidate-pair properties retained for diagnostics. */
export interface RemoteControlP2PSelectedPair {
  localCandidateType: "host" | "srflx" | "prflx" | "relay";
  remoteCandidateType: "host" | "srflx" | "prflx" | "relay";
  protocol: "udp" | "tcp";
}

/** P2P readiness or fallback report from one peer. */
export interface RemoteControlP2PState {
  protocolVersion: 2;
  type: "relay.p2p.state";
  sessionId: string;
  attemptId: string;
  sequence: number;
  state: "ready" | "failed";
  reasonCode?: string;
  selectedPair?: RemoteControlP2PSelectedPair;
}

/** Device acknowledgement that its relay recovery data path is ready. */
export interface RemoteControlTransportState {
  protocolVersion: 2;
  type: "relay.transport.state";
  sessionId: string;
  transport: "relay";
  state: "ready";
}

/** One STUN-only ICE server disclosed to both v2 peers. */
export interface RemoteControlIceServer {
  urls: string | string[];
}

/** Server instruction starting one bounded v2 P2P attempt. */
export interface RemoteControlP2PStart {
  protocolVersion: 2;
  type: "relay.p2p.start";
  sessionId: string;
  attemptId: string;
  deadlineAt: number;
  iceServers: RemoteControlIceServer[];
}

/** Final data-transport selection delivered before binary data is accepted. */
export type RemoteControlReady =
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

/** Server-controlled mid-session transition from P2P back to relay. */
export interface RemoteControlTransport {
  protocolVersion: 2;
  type: "relay.transport";
  sessionId: string;
  transport: "relay";
  phase: "recovering" | "ready";
  reasonCode: string;
}

/** Non-secret device lifecycle event published through MQTT. */
export interface RemoteControlSessionEvent {
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
 * Reject object keys outside one explicit protocol shape.
 *
 * @param value Object whose keys are inspected.
 * @param allowed Exact accepted property names.
 * @param label Protocol shape label for safe errors.
 * @returns Nothing.
 */
function requireRemoteKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} contains unknown field ${unknown}`);
}

/**
 * Return whether a value is a bounded single-line reason code.
 *
 * @param value Unknown reason-code candidate.
 * @returns Whether the value is safe for protocol diagnostics.
 */
function isRemoteReasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9_]{1,100}$/.test(value);
}

/**
 * Return whether a value is a generated one-time relay ticket.
 *
 * @param value Unknown ticket candidate.
 * @returns Whether the value has a bounded base64url-compatible shape.
 */
export function isRemoteControlTicket(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,100}$/.test(value);
}

/**
 * Hash a one-time relay ticket before retaining it in memory.
 *
 * @param ticket Raw controller or device ticket.
 * @returns Lowercase SHA-256 digest.
 */
export function hashRemoteControlTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

/**
 * Compare a presented ticket against one retained digest.
 *
 * @param ticket Raw ticket presented in a hello frame.
 * @param expectedHash Retained SHA-256 ticket digest.
 * @returns Whether the ticket matches without an equal-length timing leak.
 */
export function matchesRemoteControlTicket(
  ticket: string,
  expectedHash: string,
): boolean {
  return safeDeviceOpsSecretEqual(
    hashRemoteControlTicket(ticket),
    expectedHash,
  );
}

/**
 * Normalize the phone- and browser-reachable relay WebSocket URL.
 *
 * @param value Candidate relay URL.
 * @returns Normalized WSS URL, with loopback WS allowed for local debugging.
 */
export function normalizeRemoteControlRelayUrl(value: unknown): string {
  const normalized = normalizeDeviceOpsWsUrl(value);
  const url = new URL(normalized);
  if (url.protocol === "ws:" && url.hostname !== "127.0.0.1") {
    throw new Error(
      "Plain remote-control WS is allowed only on exact IPv4 loopback",
    );
  }
  if (url.pathname !== "/api/remote/ws") {
    throw new Error(
      "REMOTE_CONTROL_RELAY_WS_URL must use the fixed /api/remote/ws path",
    );
  }
  return normalized;
}

/**
 * Parse the comma-separated STUN-only ICE server configuration.
 *
 * @param value Candidate environment value.
 * @param required Whether at least one STUN URL must be present.
 * @returns Deduplicated immutable STUN URL list.
 */
export function parseRemoteControlStunUrls(
  value: unknown,
  required = false,
): readonly string[] {
  if (value !== undefined && typeof value !== "string") {
    throw new Error("REMOTE_CONTROL_STUN_URLS must be a comma-separated string");
  }
  const rawValues = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (rawValues.length > 4) {
    throw new Error("REMOTE_CONTROL_STUN_URLS accepts at most 4 URLs");
  }
  const normalized = new Set<string>();
  for (const candidate of rawValues) {
    if (
      candidate.length > 512 ||
      /\s/.test(candidate) ||
      candidate.includes("@") ||
      candidate.includes("/") ||
      candidate.includes("?") ||
      candidate.includes("#")
    ) {
      throw new Error("REMOTE_CONTROL_STUN_URLS contains an invalid STUN URL");
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("REMOTE_CONTROL_STUN_URLS contains an invalid STUN URL");
    }
    if (
      (parsed.protocol !== "stun:" && parsed.protocol !== "stuns:") ||
      !parsed.pathname ||
      parsed.href !== candidate
    ) {
      throw new Error(
        "REMOTE_CONTROL_STUN_URLS accepts only exact stun: or stuns: URLs",
      );
    }
    const authority = parsed.pathname;
    const bracketed = /^\[[0-9A-Fa-f:.]+\](?::([0-9]{1,5}))?$/.exec(
      authority,
    );
    const named = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(authority);
    const portText = bracketed?.[1] || named?.[2];
    if (
      (!bracketed && !named) ||
      (named &&
        (named[1].startsWith(".") ||
          named[1].endsWith(".") ||
          named[1].includes(".."))) ||
      (portText !== undefined &&
        (Number(portText) < 1 || Number(portText) > 65_535))
    ) {
      throw new Error("REMOTE_CONTROL_STUN_URLS contains an invalid STUN host");
    }
    normalized.add(candidate);
  }
  if (required && normalized.size === 0) {
    throw new Error(
      "REMOTE_CONTROL_STUN_URLS is required when P2P negotiation is enabled",
    );
  }
  return [...normalized];
}

/**
 * Parse one authenticated browser request to create a remote-control lease.
 *
 * @param value Untrusted JSON request body.
 * @returns Strict normalized session input.
 */
export function parseRemoteControlCreateInput(
  value: unknown,
): RemoteControlCreateInput {
  if (!isDeviceOpsRecord(value)) {
    throw new Error("Request body must be an object");
  }
  requireRemoteKeys(
    value,
    ["clientId", "ttlMs", "transportPreference"],
    "request",
  );
  if (!isDeviceOpsClientId(value.clientId)) {
    throw new Error("clientId has an invalid format");
  }
  const ttlMs = value.ttlMs ?? REMOTE_CONTROL_DEFAULT_TTL_MS;
  if (
    !Number.isInteger(ttlMs) ||
    (ttlMs as number) < REMOTE_CONTROL_MIN_TTL_MS ||
    (ttlMs as number) > REMOTE_CONTROL_MAX_TTL_MS
  ) {
    throw new Error("ttlMs must be an integer between 30000 and 1800000");
  }
  const transportPreference = value.transportPreference ?? "relay";
  if (
    transportPreference !== "relay" &&
    transportPreference !== "p2p-preferred"
  ) {
    throw new Error("transportPreference must be relay or p2p-preferred");
  }
  return {
    clientId: value.clientId,
    ttlMs: ttlMs as number,
    transportPreference,
  };
}

/**
 * Parse the first relay application frame from either peer.
 *
 * @param value Untrusted parsed JSON frame.
 * @param expectedVersion Optional WebSocket-negotiated application version.
 * @returns Strict hello data for ticket and lease correlation.
 */
export function parseRemoteControlHello(
  value: unknown,
  expectedVersion?: RemoteControlProtocolVersion,
): RemoteControlHello {
  if (!isDeviceOpsRecord(value)) throw new Error("Relay hello must be an object");
  requireRemoteKeys(
    value,
    [
      "protocolVersion",
      "type",
      "role",
      "sessionId",
      "deviceId",
      "ticket",
      "timestamp",
    ],
    "relay hello",
  );
  if (
    (value.protocolVersion !== REMOTE_CONTROL_PROTOCOL_VERSION_V1 &&
      value.protocolVersion !== REMOTE_CONTROL_PROTOCOL_VERSION_V2) ||
    (expectedVersion !== undefined &&
      value.protocolVersion !== expectedVersion) ||
    value.type !== "relay.hello" ||
    (value.role !== "controller" && value.role !== "device") ||
    !isDeviceOpsId(value.sessionId) ||
    !isRemoteControlTicket(value.ticket) ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp)
  ) {
    throw new Error("Invalid relay hello");
  }
  if (
    (value.role === "device" && !isDeviceOpsClientId(value.deviceId)) ||
    (value.role === "controller" && value.deviceId !== undefined)
  ) {
    throw new Error("Relay hello role fields are invalid");
  }
  return value as unknown as RemoteControlHello;
}

/**
 * Parse one optional, explicitly enabled P2P signaling message.
 *
 * @param value Untrusted parsed JSON frame.
 * @returns Strict normalized signaling message.
 */
export function parseRemoteControlP2PSignal(
  value: unknown,
): RemoteControlP2PSignal {
  if (!isDeviceOpsRecord(value)) throw new Error("P2P signal must be an object");
  requireRemoteKeys(
    value,
    [
      "protocolVersion",
      "type",
      "sessionId",
      "attemptId",
      "sequence",
      "signalType",
      "description",
      "candidate",
    ],
    "P2P signal",
  );
  if (
    value.protocolVersion !== REMOTE_CONTROL_PROTOCOL_VERSION_V2 ||
    value.type !== "relay.p2p.signal" ||
    !isDeviceOpsId(value.sessionId) ||
    !isDeviceOpsId(value.attemptId) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.sequence as number) > 1_000_000 ||
    !["offer", "answer", "ice-candidate"].includes(String(value.signalType))
  ) {
    throw new Error("Invalid P2P signal");
  }
  if (value.signalType === "offer" || value.signalType === "answer") {
    if (!isDeviceOpsRecord(value.description) || value.candidate !== undefined) {
      throw new Error("P2P description is required");
    }
    requireRemoteKeys(value.description, ["type", "sdp"], "P2P description");
    if (
      value.description.type !== value.signalType ||
      typeof value.description.sdp !== "string" ||
      Buffer.byteLength(value.description.sdp, "utf8") > 48 * 1024
    ) {
      throw new Error("Invalid P2P description");
    }
  } else {
    if (!isDeviceOpsRecord(value.candidate) || value.description !== undefined) {
      throw new Error("P2P ICE candidate is required");
    }
    requireRemoteKeys(
      value.candidate,
      ["candidate", "sdpMid", "sdpMLineIndex"],
      "P2P candidate",
    );
    if (
      typeof value.candidate.candidate !== "string" ||
      value.candidate.candidate.length < 1 ||
      value.candidate.candidate.length > 4096 ||
      (value.candidate.sdpMid !== undefined &&
        (typeof value.candidate.sdpMid !== "string" ||
          value.candidate.sdpMid.length > 256)) ||
      (value.candidate.sdpMLineIndex !== undefined &&
        (!Number.isInteger(value.candidate.sdpMLineIndex) ||
          (value.candidate.sdpMLineIndex as number) < 0 ||
          (value.candidate.sdpMLineIndex as number) > 1024))
    ) {
      throw new Error("Invalid P2P ICE candidate");
    }
  }
  return value as unknown as RemoteControlP2PSignal;
}

/**
 * Parse one optional P2P ready-or-failed state report.
 *
 * @param value Untrusted parsed JSON frame.
 * @returns Strict normalized P2P state message.
 */
export function parseRemoteControlP2PState(
  value: unknown,
): RemoteControlP2PState {
  if (!isDeviceOpsRecord(value)) throw new Error("P2P state must be an object");
  requireRemoteKeys(
    value,
    [
      "protocolVersion",
      "type",
      "sessionId",
      "attemptId",
      "sequence",
      "state",
      "reasonCode",
      "selectedPair",
    ],
    "P2P state",
  );
  if (
    value.protocolVersion !== REMOTE_CONTROL_PROTOCOL_VERSION_V2 ||
    value.type !== "relay.p2p.state" ||
    !isDeviceOpsId(value.sessionId) ||
    !isDeviceOpsId(value.attemptId) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.sequence as number) > 1_000_000 ||
    (value.state !== "ready" && value.state !== "failed") ||
    (value.reasonCode !== undefined && !isRemoteReasonCode(value.reasonCode))
  ) {
    throw new Error("Invalid P2P state");
  }
  if (value.selectedPair !== undefined) {
    if (value.state !== "ready" || !isDeviceOpsRecord(value.selectedPair)) {
      throw new Error("P2P selected pair is allowed only for ready state");
    }
    requireRemoteKeys(
      value.selectedPair,
      ["localCandidateType", "remoteCandidateType", "protocol"],
      "P2P selected pair",
    );
    const candidateTypes = ["host", "srflx", "prflx", "relay"];
    if (
      !candidateTypes.includes(String(value.selectedPair.localCandidateType)) ||
      !candidateTypes.includes(
        String(value.selectedPair.remoteCandidateType),
      ) ||
      (value.selectedPair.protocol !== "udp" &&
        value.selectedPair.protocol !== "tcp")
    ) {
      throw new Error("Invalid P2P selected pair");
    }
  }
  return value as unknown as RemoteControlP2PState;
}

/**
 * Parse the device acknowledgement for a relay recovery.
 *
 * @param value Untrusted parsed JSON frame.
 * @returns Strict relay-ready acknowledgement.
 */
export function parseRemoteControlTransportState(
  value: unknown,
): RemoteControlTransportState {
  if (!isDeviceOpsRecord(value)) {
    throw new Error("Relay transport state must be an object");
  }
  requireRemoteKeys(
    value,
    ["protocolVersion", "type", "sessionId", "transport", "state"],
    "relay transport state",
  );
  if (
    value.protocolVersion !== REMOTE_CONTROL_PROTOCOL_VERSION_V2 ||
    value.type !== "relay.transport.state" ||
    !isDeviceOpsId(value.sessionId) ||
    value.transport !== "relay" ||
    value.state !== "ready"
  ) {
    throw new Error("Invalid relay transport state");
  }
  return value as unknown as RemoteControlTransportState;
}

/**
 * Parse one device-originated non-secret relay lifecycle event.
 *
 * @param value Untrusted MQTT JSON payload.
 * @returns Strict lifecycle event for device and session correlation.
 */
export function parseRemoteControlSessionEvent(
  value: unknown,
): RemoteControlSessionEvent {
  if (!isDeviceOpsRecord(value)) {
    throw new Error("Remote session event must be an object");
  }
  requireRemoteKeys(
    value,
    [
      "protocolVersion",
      "type",
      "eventId",
      "sessionId",
      "deviceId",
      "state",
      "code",
      "message",
      "timestamp",
    ],
    "remote session event",
  );
  if (
    value.protocolVersion !== REMOTE_CONTROL_PROTOCOL_VERSION ||
    value.type !== "REMOTE_SESSION_EVENT" ||
    !isDeviceOpsId(value.eventId) ||
    !isDeviceOpsId(value.sessionId) ||
    !isDeviceOpsClientId(value.deviceId) ||
    !["CONNECTING", "CONNECTED", "CLOSED", "REJECTED"].includes(
      String(value.state),
    ) ||
    !isRemoteReasonCode(value.code) ||
    typeof value.message !== "string" ||
    value.message.length > 1000 ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp)
  ) {
    throw new Error("Invalid remote session event");
  }
  return value as unknown as RemoteControlSessionEvent;
}
