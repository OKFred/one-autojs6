import { randomBytes, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";

import {
  REMOTE_CONTROL_MAX_CONTROLLER_BINARY_BYTES,
  REMOTE_CONTROL_MAX_DEVICE_BINARY_BYTES,
  REMOTE_CONTROL_MAX_JSON_BYTES,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  REMOTE_CONTROL_PROTOCOL_VERSION_V1,
  REMOTE_CONTROL_PROTOCOL_VERSION_V2,
  hashRemoteControlTicket,
  matchesRemoteControlTicket,
  normalizeRemoteControlRelayUrl,
  parseRemoteControlHello,
  parseRemoteControlP2PSignal,
  parseRemoteControlP2PState,
  parseRemoteControlSessionEvent,
  parseRemoteControlStunUrls,
  parseRemoteControlTransportState,
  type RemoteControlCreateInput,
  type RemoteControlIceServer,
  type RemoteControlOpenSessionCommand,
  type RemoteControlPeerRole,
  type RemoteControlP2PSelectedPair,
  type RemoteControlProtocolVersion,
  type RemoteControlSessionEvent,
  type RemoteControlTransportPreference,
} from "../remote-control-protocol.js";
import { isDeviceOpsRecord } from "../device-ops-protocol.js";
import { MqttService } from "./mqtt.service.js";
import {
  extractRemoteControlIceCandidateAddress,
  normalizeRemoteControlRouteAddress,
} from "./remote-control-route-probe.service.js";

const REMOTE_CONTROL_MAX_SESSIONS = 100;
const REMOTE_CONTROL_RETENTION_MS = 10 * 60 * 1000;
const REMOTE_CONTROL_HELLO_TIMEOUT_MS = 5_000;
const REMOTE_CONTROL_MAX_UNBOUND_SOCKETS = 32;
const REMOTE_CONTROL_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const REMOTE_CONTROL_MAX_SESSION_RELAY_BYTES = 512 * 1024 * 1024;
const REMOTE_CONTROL_P2P_NEGOTIATION_MS = 10_000;

/** Async task status exposed by the remote-control session API. */
export type RemoteControlTaskStatus =
  | "EXECUTING"
  | "FAILURE"
  | "TIMEOUT"
  | "CANCELLED";

/** Remote-control lease state exposed without either one-time ticket. */
export type RemoteControlSessionState =
  | "WAITING_PEERS"
  | "WAITING_DEVICE"
  | "WAITING_CONTROLLER"
  | "SELECTING_TRANSPORT"
  | "RECOVERING_TRANSPORT"
  | "ACTIVE"
  | "CLOSED"
  | "EXPIRED"
  | "FAILED";

/** Optional P2P negotiation state; relay remains the safe default. */
export type RemoteControlP2PStatus =
  | "DISABLED"
  | "AVAILABLE"
  | "NEGOTIATING"
  | "ACTIVE"
  | "FALLBACK";

/** Public, ticket-free representation of one temporary control lease. */
export interface RemoteControlSessionView {
  taskId: string;
  status: RemoteControlTaskStatus;
  sessionId: string;
  clientId: string;
  sessionState: RemoteControlSessionState;
  controllerConnected: boolean;
  deviceConnected: boolean;
  transportPreference: RemoteControlTransportPreference;
  selectedTransport: "relay" | "p2p" | null;
  p2pAllowed: boolean;
  p2pStatus: RemoteControlP2PStatus;
  p2pAttemptId: string | null;
  p2pNegotiationDurationMs: number | null;
  p2pFailureCode: string | null;
  p2pSelectedPair: RemoteControlP2PSelectedPair | null;
  createTimeUtc: number;
  expiresAtUtc: number;
  finishedAtUtc: number | null;
  code: string | null;
  message: string | null;
  lastDeviceEventState: RemoteControlSessionEvent["state"] | null;
  lastDeviceEventCode: string | null;
  lastDeviceEventAtUtc: number | null;
  controllerToDeviceBytes: number;
  deviceToControllerBytes: number;
}

/** Create response that reveals the browser ticket exactly once. */
export interface RemoteControlSessionCreated extends RemoteControlSessionView {
  relayWsUrl: string;
  browserTicket: string;
}

/** Injectable relay dependencies used by focused protocol tests. */
export interface RemoteControlServiceOptions {
  publishOpenSession?: (
    deviceId: string,
    command: RemoteControlOpenSessionCommand,
  ) => Promise<void>;
  relayWsUrl?: string | null;
  allowP2P?: boolean;
  stunUrls?: readonly string[];
  negotiationMs?: number;
  now?: () => number;
  createId?: () => string;
  createTicket?: () => string;
  createAttemptId?: () => string;
}

/** Stable relay failure with a controller-safe HTTP status. */
export class RemoteControlGatewayError extends Error {
  /**
   * Create a typed control-plane failure.
   *
   * @param httpStatus HTTP status returned through the standard envelope.
   * @param message Safe public diagnostic.
   */
  constructor(
    readonly httpStatus: 409 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** In-memory state for one device-exclusive remote-control lease. */
interface StoredRemoteControlSession {
  taskId: string;
  sessionId: string;
  clientId: string;
  status: RemoteControlTaskStatus;
  sessionState: RemoteControlSessionState;
  transportPreference: RemoteControlTransportPreference;
  selectedTransport: "relay" | "p2p" | null;
  p2pAllowed: boolean;
  p2pStatus: RemoteControlP2PStatus;
  p2pReadyRoles: Set<RemoteControlPeerRole>;
  p2pLastSequence: Record<RemoteControlPeerRole, number>;
  p2pOfferSeen: boolean;
  p2pAnswerSeen: boolean;
  p2pAttemptId: string | null;
  p2pNegotiationStartedAtUtc: number | null;
  p2pNegotiationDurationMs: number | null;
  p2pFailureCode: string | null;
  p2pSelectedPair: RemoteControlP2PSelectedPair | null;
  deviceCandidateAddresses: Set<string>;
  iceServers: readonly RemoteControlIceServer[];
  controllerTicketHash: string;
  deviceTicketHash: string;
  controllerTicketUsed: boolean;
  deviceTicketUsed: boolean;
  controllerSocket: WebSocket | null;
  deviceSocket: WebSocket | null;
  controllerProtocolVersion: RemoteControlProtocolVersion | null;
  deviceProtocolVersion: RemoteControlProtocolVersion | null;
  createTimeUtc: number;
  expiresAtUtc: number;
  finishedAtUtc: number | null;
  code: string | null;
  message: string | null;
  lastDeviceEventState: RemoteControlSessionEvent["state"] | null;
  lastDeviceEventCode: string | null;
  lastDeviceEventAtUtc: number | null;
  controllerToDeviceBytes: number;
  deviceToControllerBytes: number;
  expiryTimer: NodeJS.Timeout;
  negotiationTimer: NodeJS.Timeout | null;
}

/**
 * Convert one raw WebSocket frame into bounded JSON text.
 *
 * @param data Raw ws frame payload.
 * @param isBinary Whether ws classified the frame as binary.
 * @returns Bounded UTF-8 text.
 */
function readRemoteControlText(data: RawData, isBinary: boolean): string {
  if (isBinary) throw new Error("Expected relay JSON text");
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : Buffer.from(data as Buffer | ArrayBuffer).toString("utf8");
  if (Buffer.byteLength(text, "utf8") > REMOTE_CONTROL_MAX_JSON_BYTES) {
    throw new Error("Relay JSON frame exceeded 64 KiB");
  }
  return text;
}

/**
 * Convert one raw WebSocket binary frame into a stable Buffer view.
 *
 * @param data Raw ws frame payload.
 * @returns Binary data suitable for immediate ordered forwarding.
 */
function readRemoteControlBinary(data: RawData): Buffer {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.from(data as Buffer | ArrayBuffer);
}

/**
 * Return whether a session task has reached a terminal state.
 *
 * @param session Session state to inspect.
 * @returns Whether the control lease can no longer accept peers or frames.
 */
function isRemoteControlTerminal(session: StoredRemoteControlSession): boolean {
  return session.status !== "EXECUTING";
}

/** Manage bounded server rendezvous and binary relay for isolated peers. */
export class RemoteControlService {
  private static instance: RemoteControlService | undefined;
  private readonly sessions = new Map<string, StoredRemoteControlSession>();
  private readonly activeSessionByDevice = new Map<
    string,
    StoredRemoteControlSession
  >();
  private readonly unboundSockets = new Set<WebSocket>();
  private readonly publishOpenSession: (
    deviceId: string,
    command: RemoteControlOpenSessionCommand,
  ) => Promise<void>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createTicket: () => string;
  private readonly createAttemptId: () => string;
  private readonly negotiationMs: number;

  /**
   * Create one isolated in-memory relay service.
   *
   * @param options Optional transport, clock, and identifier dependencies.
   */
  constructor(private readonly options: RemoteControlServiceOptions = {}) {
    this.publishOpenSession =
      options.publishOpenSession ||
      ((deviceId, command) =>
        MqttService.getInstance().publishRemoteOpenSession(deviceId, command));
    this.now = options.now || Date.now;
    this.createId = options.createId || randomUUID;
    this.createTicket =
      options.createTicket || (() => randomBytes(32).toString("base64url"));
    this.createAttemptId = options.createAttemptId || randomUUID;
    this.negotiationMs =
      options.negotiationMs ?? REMOTE_CONTROL_P2P_NEGOTIATION_MS;
    if (
      !Number.isSafeInteger(this.negotiationMs) ||
      this.negotiationMs < 1 ||
      this.negotiationMs > REMOTE_CONTROL_P2P_NEGOTIATION_MS
    ) {
      throw new Error("Remote-control negotiation timeout is invalid");
    }
  }

  /**
   * Return the process-wide remote-control relay service.
   *
   * @returns Singleton relay service.
   */
  static getInstance(): RemoteControlService {
    if (!this.instance) {
      const service = new RemoteControlService();
      this.instance = service;
      MqttService.getInstance().setRemoteSessionEventHandler(
        (topicDeviceId, payload) =>
          service.handleDeviceSessionEvent(topicDeviceId, payload),
      );
    }
    return this.instance;
  }

  /**
   * Resolve the explicitly configured public relay URL.
   *
   * @returns Phone- and browser-reachable relay URL.
   */
  private getRelayWsUrl(): string {
    const value =
      this.options.relayWsUrl === undefined
        ? process.env.REMOTE_CONTROL_RELAY_WS_URL
        : this.options.relayWsUrl;
    if (!value) {
      throw new RemoteControlGatewayError(
        503,
        "Remote-control relay is disabled on this PC server",
      );
    }
    try {
      return normalizeRemoteControlRelayUrl(value);
    } catch {
      throw new RemoteControlGatewayError(
        503,
        "Remote-control relay configuration is invalid",
      );
    }
  }

  /**
   * Return whether optional P2P signaling is explicitly enabled.
   *
   * @returns P2P signaling policy for newly created leases.
   */
  private isP2PEnabled(): boolean {
    return (
      this.options.allowP2P ??
      process.env.REMOTE_CONTROL_ALLOW_P2P_NEGOTIATION === "true"
    );
  }

  /**
   * Resolve the immutable STUN-only ICE configuration for a new lease.
   *
   * @returns Strict ICE server list shared with both v2 peers.
   */
  private getIceServers(): readonly RemoteControlIceServer[] {
    const configured =
      this.options.stunUrls === undefined
        ? parseRemoteControlStunUrls(
            process.env.REMOTE_CONTROL_STUN_URLS,
            true,
          )
        : parseRemoteControlStunUrls(this.options.stunUrls.join(","), true);
    return [{ urls: [...configured] }];
  }

  /**
   * Remove expired terminal records and enforce the session count bound.
   *
   * @returns Nothing.
   */
  private cleanup(): void {
    const cutoff = this.now() - REMOTE_CONTROL_RETENTION_MS;
    for (const [sessionId, session] of this.sessions) {
      if (
        session.finishedAtUtc !== null &&
        session.finishedAtUtc < cutoff
      ) {
        this.sessions.delete(sessionId);
      }
    }
    if (this.sessions.size < REMOTE_CONTROL_MAX_SESSIONS) return;
    const terminal = [...this.sessions.values()]
      .filter((session) => session.finishedAtUtc !== null)
      .sort(
        (left, right) =>
          (left.finishedAtUtc || 0) - (right.finishedAtUtc || 0),
      );
    while (
      this.sessions.size >= REMOTE_CONTROL_MAX_SESSIONS &&
      terminal.length > 0
    ) {
      const session = terminal.shift();
      if (session) this.sessions.delete(session.sessionId);
    }
  }

  /**
   * Send one bounded relay control-plane JSON frame.
   *
   * @param socket Open destination socket.
   * @param value Non-secret structured control message.
   * @returns Nothing.
   */
  private sendJson(socket: WebSocket | null, value: unknown): void {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload, "utf8") <= REMOTE_CONTROL_MAX_JSON_BYTES) {
      socket.send(payload);
    }
  }

  /**
   * Build the common non-secret relay ready frame.
   *
   * @param session Paired active lease.
   * @returns Ready frame shared by both peers.
   */
  private readyFrame(
    session: StoredRemoteControlSession,
    protocolVersion: RemoteControlProtocolVersion,
    transport: "relay" | "p2p",
    reasonCode?: string,
  ) {
    const common = {
      protocolVersion,
      type: "relay.ready",
      sessionId: session.sessionId,
      transport,
      expiresAt: session.expiresAtUtc,
    } as const;
    return protocolVersion === REMOTE_CONTROL_PROTOCOL_VERSION_V2 && reasonCode
      ? { ...common, reasonCode }
      : common;
  }

  /**
   * Send a final transport selection to each peer using its negotiated version.
   *
   * @param session Fully paired lease.
   * @param transport Selected data transport.
   * @param reasonCode Optional safe fallback reason disclosed only to v2 peers.
   * @returns Nothing.
   */
  private sendReady(
    session: StoredRemoteControlSession,
    transport: "relay" | "p2p",
    reasonCode?: string,
  ): void {
    if (session.controllerProtocolVersion) {
      this.sendJson(
        session.controllerSocket,
        this.readyFrame(
          session,
          session.controllerProtocolVersion,
          transport,
          reasonCode,
        ),
      );
    }
    if (session.deviceProtocolVersion) {
      this.sendJson(
        session.deviceSocket,
        this.readyFrame(
          session,
          session.deviceProtocolVersion,
          transport,
          reasonCode,
        ),
      );
    }
  }

  /**
   * Close a lease, release its device lock, and notify connected peers.
   *
   * @param session Lease being made terminal.
   * @param state Terminal session state.
   * @param status Terminal async task status.
   * @param code Stable close reason.
   * @param message Safe close diagnostic.
   * @returns Nothing.
   */
  private finish(
    session: StoredRemoteControlSession,
    state: "CLOSED" | "EXPIRED" | "FAILED",
    status: Exclude<RemoteControlTaskStatus, "EXECUTING">,
    code: string,
    message: string,
  ): void {
    if (isRemoteControlTerminal(session)) return;
    session.status = status;
    session.sessionState = state;
    session.code = code;
    session.message = message;
    session.finishedAtUtc = this.now();
    clearTimeout(session.expiryTimer);
    if (session.negotiationTimer) clearTimeout(session.negotiationTimer);
    session.negotiationTimer = null;
    if (this.activeSessionByDevice.get(session.clientId) === session) {
      this.activeSessionByDevice.delete(session.clientId);
    }
    const sockets = [
      {
        socket: session.controllerSocket,
        protocolVersion: session.controllerProtocolVersion,
      },
      {
        socket: session.deviceSocket,
        protocolVersion: session.deviceProtocolVersion,
      },
    ];
    session.controllerSocket = null;
    session.deviceSocket = null;
    session.deviceCandidateAddresses.clear();
    for (const { socket, protocolVersion } of sockets) {
      if (socket?.readyState === WebSocket.OPEN) {
        this.sendJson(socket, {
          protocolVersion:
            protocolVersion || REMOTE_CONTROL_PROTOCOL_VERSION_V1,
          type: "relay.closed",
          sessionId: session.sessionId,
          code,
          message,
        });
        socket.close(1000, code.slice(0, 100));
      } else {
        socket?.terminate();
      }
    }
  }

  /**
   * Update the waiting state or activate a fully paired relay.
   *
   * @param session Lease whose peer bindings changed.
   * @returns Nothing.
   */
  private updatePairingState(session: StoredRemoteControlSession): void {
    if (isRemoteControlTerminal(session)) return;
    if (session.controllerSocket && session.deviceSocket) {
      const bothV2 =
        session.controllerProtocolVersion ===
          REMOTE_CONTROL_PROTOCOL_VERSION_V2 &&
        session.deviceProtocolVersion === REMOTE_CONTROL_PROTOCOL_VERSION_V2;
      if (session.p2pAllowed && bothV2) {
        this.beginP2PNegotiation(session);
      } else {
        this.completeInitialRelaySelection(
          session,
          session.p2pAllowed && !bothV2 ? "P2P_PEER_LEGACY" : undefined,
        );
      }
      return;
    }
    session.selectedTransport = null;
    session.sessionState = session.controllerSocket
      ? "WAITING_DEVICE"
      : session.deviceSocket
        ? "WAITING_CONTROLLER"
        : "WAITING_PEERS";
  }

  /**
   * Record the elapsed P2P negotiation duration without retaining SDP or IPs.
   *
   * @param session Lease whose current negotiation has ended.
   * @returns Nothing.
   */
  private finishP2PNegotiationTiming(
    session: StoredRemoteControlSession,
  ): void {
    if (session.p2pNegotiationStartedAtUtc === null) return;
    session.p2pNegotiationDurationMs = Math.max(
      0,
      this.now() - session.p2pNegotiationStartedAtUtc,
    );
    session.p2pNegotiationStartedAtUtc = null;
  }

  /**
   * Finish initial transport selection on the always-available relay.
   *
   * @param session Fully paired lease.
   * @param reasonCode Optional P2P fallback reason.
   * @returns Nothing.
   */
  private completeInitialRelaySelection(
    session: StoredRemoteControlSession,
    reasonCode?: string,
  ): void {
    if (isRemoteControlTerminal(session)) return;
    if (session.negotiationTimer) clearTimeout(session.negotiationTimer);
    session.negotiationTimer = null;
    this.finishP2PNegotiationTiming(session);
    session.sessionState = "ACTIVE";
    session.selectedTransport = "relay";
    session.p2pReadyRoles.clear();
    if (reasonCode) {
      session.p2pStatus = "FALLBACK";
      session.p2pFailureCode = reasonCode;
    }
    this.sendReady(session, "relay", reasonCode);
  }

  /**
   * Begin the bounded v2 ICE and DataChannel selection phase.
   *
   * @param session Fully paired v2 lease.
   * @returns Nothing.
   */
  private beginP2PNegotiation(session: StoredRemoteControlSession): void {
    if (isRemoteControlTerminal(session)) return;
    const attemptId = this.createAttemptId();
    const startedAt = this.now();
    session.sessionState = "SELECTING_TRANSPORT";
    session.selectedTransport = null;
    session.p2pStatus = "NEGOTIATING";
    session.p2pReadyRoles.clear();
    session.p2pLastSequence = { controller: -1, device: -1 };
    session.p2pOfferSeen = false;
    session.p2pAnswerSeen = false;
    session.p2pAttemptId = attemptId;
    session.p2pNegotiationStartedAtUtc = startedAt;
    session.p2pNegotiationDurationMs = null;
    session.p2pFailureCode = null;
    session.p2pSelectedPair = null;
    const start = {
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION_V2,
      type: "relay.p2p.start",
      sessionId: session.sessionId,
      attemptId,
      deadlineAt: startedAt + this.negotiationMs,
      iceServers: session.iceServers.map((server) => ({
        urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
      })),
    } as const;
    this.sendJson(session.controllerSocket, start);
    this.sendJson(session.deviceSocket, start);
    session.negotiationTimer = setTimeout(
      () =>
        this.completeInitialRelaySelection(
          session,
          "P2P_NEGOTIATION_TIMEOUT",
        ),
      this.negotiationMs,
    );
    session.negotiationTimer.unref();
  }

  /**
   * Forward one strictly parsed optional P2P signaling message.
   *
   * @param session Active paired lease.
   * @param role Origin peer role.
   * @param value Parsed but untrusted JSON value.
   * @returns Nothing.
   */
  private handleP2PSignal(
    session: StoredRemoteControlSession,
    role: RemoteControlPeerRole,
    value: unknown,
  ): void {
    const signal = parseRemoteControlP2PSignal(value);
    if (
      signal.sessionId !== session.sessionId ||
      signal.attemptId !== session.p2pAttemptId
    ) {
      throw new Error("P2P signal correlation failed");
    }
    const selecting =
      session.sessionState === "SELECTING_TRANSPORT" &&
      session.p2pStatus === "NEGOTIATING";
    if (
      !session.p2pAllowed ||
      !selecting ||
      session.p2pReadyRoles.has(role)
    ) {
      throw new Error("P2P signaling is not enabled for this lease");
    }
    if (
      signal.sequence !== session.p2pLastSequence[role] + 1 ||
      (signal.signalType === "offer" && role !== "controller") ||
      (signal.signalType === "answer" && role !== "device") ||
      (signal.signalType === "offer" && session.p2pOfferSeen) ||
      (signal.signalType === "answer" &&
        (!session.p2pOfferSeen || session.p2pAnswerSeen)) ||
      (signal.signalType === "ice-candidate" &&
        ((role === "controller" && !session.p2pOfferSeen) ||
          (role === "device" && !session.p2pAnswerSeen)))
    ) {
      throw new Error("P2P signal correlation failed");
    }
    const target =
      role === "controller" ? session.deviceSocket : session.controllerSocket;
    if (target?.readyState !== WebSocket.OPEN) {
      throw new Error("P2P peer is unavailable");
    }
    session.p2pLastSequence[role] = signal.sequence;
    if (signal.signalType === "offer") session.p2pOfferSeen = true;
    if (signal.signalType === "answer") session.p2pAnswerSeen = true;
    if (role === "device" && signal.signalType === "ice-candidate") {
      const address = extractRemoteControlIceCandidateAddress(
        signal.candidate?.candidate || "",
      );
      if (address) session.deviceCandidateAddresses.add(address);
    }
    this.sendJson(target, signal);
  }

  /**
   * Freeze WSS binary forwarding while the device rebuilds its relay source.
   *
   * @param session Active P2P lease.
   * @param reasonCode Stable sanitized recovery reason.
   * @returns Nothing.
   */
  private beginRelayRecovery(
    session: StoredRemoteControlSession,
    reasonCode: string,
  ): void {
    if (isRemoteControlTerminal(session)) return;
    if (session.negotiationTimer) clearTimeout(session.negotiationTimer);
    session.negotiationTimer = null;
    session.sessionState = "RECOVERING_TRANSPORT";
    session.selectedTransport = null;
    session.p2pStatus = "FALLBACK";
    session.p2pFailureCode = reasonCode;
    const frame = {
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION_V2,
      type: "relay.transport",
      sessionId: session.sessionId,
      transport: "relay",
      phase: "recovering",
      reasonCode,
    } as const;
    this.sendJson(session.controllerSocket, frame);
    this.sendJson(session.deviceSocket, frame);
    session.negotiationTimer = setTimeout(
      () =>
        this.finish(
          session,
          "FAILED",
          "FAILURE",
          "P2P_RECOVERY_TIMEOUT",
          "Remote-control relay recovery timed out",
        ),
      this.negotiationMs,
    );
    session.negotiationTimer.unref();
  }

  /**
   * Process one optional P2P readiness or failure report.
   *
   * @param session Active paired lease.
   * @param role Reporting peer role.
   * @param value Parsed but untrusted JSON value.
   * @returns Nothing.
   */
  private handleP2PState(
    session: StoredRemoteControlSession,
    role: RemoteControlPeerRole,
    value: unknown,
  ): void {
    if (!session.p2pAllowed) {
      throw new Error("P2P state is not enabled for this lease");
    }
    const state = parseRemoteControlP2PState(value);
    if (
      state.sessionId !== session.sessionId ||
      state.attemptId !== session.p2pAttemptId
    ) {
      throw new Error("P2P state correlation failed");
    }
    if (
      state.sequence !== session.p2pLastSequence[role] + 1 ||
      (state.state === "ready" && session.p2pReadyRoles.has(role))
    ) {
      throw new Error("P2P state correlation failed");
    }
    session.p2pLastSequence[role] = state.sequence;
    if (state.state === "failed") {
      const reasonCode = state.reasonCode || "P2P_PEER_FAILED";
      if (session.sessionState === "SELECTING_TRANSPORT") {
        this.completeInitialRelaySelection(session, reasonCode);
        return;
      }
      if (
        session.sessionState === "ACTIVE" &&
        session.selectedTransport === "p2p"
      ) {
        this.beginRelayRecovery(session, reasonCode);
        return;
      }
      if (session.sessionState === "RECOVERING_TRANSPORT") return;
      if (
        session.sessionState === "ACTIVE" &&
        session.selectedTransport === "relay" &&
        session.p2pStatus === "FALLBACK"
      ) {
        return;
      }
      throw new Error("P2P failure arrived outside an active P2P attempt");
    }
    if (
      session.sessionState === "RECOVERING_TRANSPORT" ||
      (session.sessionState === "ACTIVE" &&
        (session.selectedTransport === "p2p" ||
          (session.selectedTransport === "relay" &&
            session.p2pStatus === "FALLBACK")))
    ) {
      return;
    }
    if (
      session.sessionState !== "SELECTING_TRANSPORT" ||
      session.p2pStatus !== "NEGOTIATING" ||
      !session.p2pOfferSeen ||
      !session.p2pAnswerSeen
    ) {
      throw new Error("P2P ready arrived outside negotiation");
    }
    session.p2pReadyRoles.add(role);
    if (
      state.selectedPair &&
      (role === "controller" || session.p2pSelectedPair === null)
    ) {
      session.p2pSelectedPair = { ...state.selectedPair };
    }
    if (session.p2pReadyRoles.size < 2) return;
    if (session.negotiationTimer) clearTimeout(session.negotiationTimer);
    session.negotiationTimer = null;
    this.finishP2PNegotiationTiming(session);
    session.p2pStatus = "ACTIVE";
    session.selectedTransport = "p2p";
    session.sessionState = "ACTIVE";
    this.sendReady(session, "p2p");
  }

  /**
   * Complete a device-confirmed relay recovery and reopen WSS binary forwarding.
   *
   * @param session Recovering P2P lease.
   * @param role Reporting peer role.
   * @param value Parsed but untrusted JSON value.
   * @returns Nothing.
   */
  private handleTransportState(
    session: StoredRemoteControlSession,
    role: RemoteControlPeerRole,
    value: unknown,
  ): void {
    const state = parseRemoteControlTransportState(value);
    if (
      role !== "device" ||
      state.sessionId !== session.sessionId ||
      session.sessionState !== "RECOVERING_TRANSPORT"
    ) {
      throw new Error("Relay recovery state correlation failed");
    }
    if (session.negotiationTimer) clearTimeout(session.negotiationTimer);
    session.negotiationTimer = null;
    const frame = {
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION_V2,
      type: "relay.transport",
      sessionId: session.sessionId,
      transport: "relay",
      phase: "ready",
      reasonCode: session.p2pFailureCode || "P2P_RECOVERED_TO_RELAY",
    } as const;
    this.sendJson(session.controllerSocket, frame);
    this.sendJson(session.deviceSocket, frame);
    session.selectedTransport = "relay";
    session.sessionState = "ACTIVE";
  }

  /**
   * Forward one bounded binary scrcpy frame in its fixed role direction.
   *
   * @param session Active paired lease.
   * @param role Origin peer role.
   * @param data Raw binary frame.
   * @returns Nothing.
   */
  private relayBinary(
    session: StoredRemoteControlSession,
    role: RemoteControlPeerRole,
    data: RawData,
  ): void {
    if (
      session.sessionState !== "ACTIVE" ||
      session.selectedTransport !== "relay" ||
      isRemoteControlTerminal(session)
    ) {
      throw new Error("WSS binary forwarding is not selected");
    }
    const frame = readRemoteControlBinary(data);
    const maximum =
      role === "controller"
        ? REMOTE_CONTROL_MAX_CONTROLLER_BINARY_BYTES
        : REMOTE_CONTROL_MAX_DEVICE_BINARY_BYTES;
    if (frame.byteLength < 1 || frame.byteLength > maximum) {
      throw new Error("Relay binary frame exceeded its role limit");
    }
    const relayedBytes =
      session.controllerToDeviceBytes +
      session.deviceToControllerBytes +
      frame.byteLength;
    if (relayedBytes > REMOTE_CONTROL_MAX_SESSION_RELAY_BYTES) {
      this.finish(
        session,
        "FAILED",
        "FAILURE",
        "RELAY_BYTE_BUDGET_EXCEEDED",
        "Remote-control relay byte budget was exceeded",
      );
      return;
    }
    const target =
      role === "controller" ? session.deviceSocket : session.controllerSocket;
    if (
      target?.readyState !== WebSocket.OPEN ||
      target.bufferedAmount > REMOTE_CONTROL_MAX_BUFFERED_BYTES
    ) {
      this.finish(
        session,
        "FAILED",
        "FAILURE",
        "RELAY_BACKPRESSURE",
        "Remote-control peer could not keep up with the relay",
      );
      return;
    }
    if (role === "controller") {
      session.controllerToDeviceBytes += frame.byteLength;
    } else {
      session.deviceToControllerBytes += frame.byteLength;
    }
    target.send(frame, { binary: true }, (error) => {
      if (error) {
        this.finish(
          session,
          "FAILED",
          "FAILURE",
          "RELAY_SEND_FAILED",
          "Remote-control relay delivery failed",
        );
      }
    });
  }

  /**
   * Bind one hello to an exact lease, role, credential, and one-time ticket.
   *
   * @param socket Newly connected outbound peer.
   * @param credential Handshake credential class determined by the WSS endpoint.
   * @param protocolVersion WebSocket-negotiated application protocol version.
   * @param value Parsed but untrusted hello value.
   * @returns Exact bound session and peer role.
   */
  private bindHello(
    socket: WebSocket,
    credential: "browser" | "device",
    protocolVersion: RemoteControlProtocolVersion,
    value: unknown,
  ): { session: StoredRemoteControlSession; role: RemoteControlPeerRole } {
    const hello = parseRemoteControlHello(value, protocolVersion);
    const session = this.sessions.get(hello.sessionId);
    const now = this.now();
    if (
      !session ||
      isRemoteControlTerminal(session) ||
      session.expiresAtUtc <= now ||
      hello.timestamp < session.createTimeUtc - 60_000 ||
      hello.timestamp > session.expiresAtUtc + 60_000
    ) {
      throw new Error("Relay hello session correlation failed");
    }
    if (hello.role === "controller") {
      if (
        credential !== "browser" ||
        session.controllerTicketUsed ||
        session.controllerSocket ||
        !matchesRemoteControlTicket(hello.ticket, session.controllerTicketHash)
      ) {
        throw new Error("Relay controller ticket correlation failed");
      }
      session.controllerTicketUsed = true;
      session.controllerSocket = socket;
      session.controllerProtocolVersion = protocolVersion;
    } else {
      if (
        credential !== "device" ||
        hello.deviceId !== session.clientId ||
        session.deviceTicketUsed ||
        session.deviceSocket ||
        !matchesRemoteControlTicket(hello.ticket, session.deviceTicketHash)
      ) {
        throw new Error("Relay device ticket correlation failed");
      }
      session.deviceTicketUsed = true;
      session.deviceSocket = socket;
      session.deviceProtocolVersion = protocolVersion;
    }
    this.updatePairingState(session);
    return { session, role: hello.role };
  }

  /**
   * Create one device-exclusive asynchronous remote-control lease.
   *
   * @param input Strict validated session request.
   * @returns Session state and the one-time browser ticket after MQTT PUBACK.
   */
  async createSession(
    input: RemoteControlCreateInput,
  ): Promise<RemoteControlSessionCreated> {
    this.cleanup();
    if (this.sessions.size >= REMOTE_CONTROL_MAX_SESSIONS) {
      throw new RemoteControlGatewayError(
        503,
        "Remote-control session capacity is full",
      );
    }
    const active = this.activeSessionByDevice.get(input.clientId);
    if (active && !isRemoteControlTerminal(active)) {
      throw new RemoteControlGatewayError(
        409,
        "The device already has an active remote-control lease",
      );
    }
    const relayWsUrl = this.getRelayWsUrl();
    const now = this.now();
    const browserTicket = this.createTicket();
    const deviceTicket = this.createTicket();
    const p2pAllowed =
      input.transportPreference === "p2p-preferred" && this.isP2PEnabled();
    let iceServers: readonly RemoteControlIceServer[] = [];
    if (p2pAllowed) {
      try {
        iceServers = this.getIceServers();
      } catch {
        throw new RemoteControlGatewayError(
          503,
          "Remote-control P2P STUN configuration is invalid",
        );
      }
    }
    const session = {} as StoredRemoteControlSession;
    session.taskId = this.createId();
    session.sessionId = this.createId();
    session.clientId = input.clientId;
    session.status = "EXECUTING";
    session.sessionState = "WAITING_PEERS";
    session.transportPreference = input.transportPreference;
    session.selectedTransport = null;
    session.p2pAllowed = p2pAllowed;
    session.p2pStatus = p2pAllowed ? "AVAILABLE" : "DISABLED";
    session.p2pReadyRoles = new Set();
    session.p2pLastSequence = { controller: -1, device: -1 };
    session.p2pOfferSeen = false;
    session.p2pAnswerSeen = false;
    session.p2pAttemptId = null;
    session.p2pNegotiationStartedAtUtc = null;
    session.p2pNegotiationDurationMs = null;
    session.p2pFailureCode = null;
    session.p2pSelectedPair = null;
    session.deviceCandidateAddresses = new Set();
    session.iceServers = iceServers;
    session.controllerTicketHash = hashRemoteControlTicket(browserTicket);
    session.deviceTicketHash = hashRemoteControlTicket(deviceTicket);
    session.controllerTicketUsed = false;
    session.deviceTicketUsed = false;
    session.controllerSocket = null;
    session.deviceSocket = null;
    session.controllerProtocolVersion = null;
    session.deviceProtocolVersion = null;
    session.createTimeUtc = now;
    session.expiresAtUtc = now + input.ttlMs;
    session.finishedAtUtc = null;
    session.code = null;
    session.message = null;
    session.lastDeviceEventState = null;
    session.lastDeviceEventCode = null;
    session.lastDeviceEventAtUtc = null;
    session.controllerToDeviceBytes = 0;
    session.deviceToControllerBytes = 0;
    session.negotiationTimer = null;
    session.expiryTimer = setTimeout(
      () =>
        this.finish(
          session,
          "EXPIRED",
          "TIMEOUT",
          "REMOTE_SESSION_EXPIRED",
          "Remote-control lease expired",
        ),
      input.ttlMs,
    );
    session.expiryTimer.unref();
    this.sessions.set(session.sessionId, session);
    this.activeSessionByDevice.set(input.clientId, session);
    const command: RemoteControlOpenSessionCommand = {
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      type: "OPEN_REMOTE_SESSION",
      sessionId: session.sessionId,
      deviceId: input.clientId,
      relayWsUrl,
      deviceTicket,
      issuedAt: now,
      expiresAt: session.expiresAtUtc,
    };
    const accepted: RemoteControlSessionCreated = {
      ...this.view(session),
      relayWsUrl,
      browserTicket,
    };
    try {
      await this.publishOpenSession(input.clientId, command);
    } catch {
      this.finish(
        session,
        "FAILED",
        "FAILURE",
        "REMOTE_OPEN_SESSION_PUBLISH_FAILED",
        "Failed to publish the remote-control invitation",
      );
      throw new RemoteControlGatewayError(
        502,
        "Failed to publish the remote-control invitation",
      );
    }
    return accepted;
  }

  /**
   * Consume one authenticated MQTT lifecycle event after strict topic and payload correlation.
   *
   * @param topicDeviceId Device identifier isolated by the subscribed MQTT topic.
   * @param value Untrusted decoded MQTT JSON payload.
   * @returns Nothing; malformed, stale, or unrelated events are ignored.
   */
  handleDeviceSessionEvent(topicDeviceId: string, value: unknown): void {
    let event: RemoteControlSessionEvent;
    try {
      event = parseRemoteControlSessionEvent(value);
    } catch {
      return;
    }
    const session = this.sessions.get(event.sessionId);
    if (
      !session ||
      isRemoteControlTerminal(session) ||
      event.deviceId !== topicDeviceId ||
      event.deviceId !== session.clientId ||
      event.timestamp < session.createTimeUtc - 60_000 ||
      event.timestamp > session.expiresAtUtc + 60_000 ||
      (session.lastDeviceEventAtUtc !== null &&
        event.timestamp < session.lastDeviceEventAtUtc)
    ) {
      return;
    }
    session.lastDeviceEventState = event.state;
    session.lastDeviceEventCode = event.code;
    session.lastDeviceEventAtUtc = event.timestamp;
    if (event.state === "REJECTED") {
      this.finish(
        session,
        "FAILED",
        "FAILURE",
        event.code,
        "The device rejected the remote-control invitation",
      );
      return;
    }
    if (event.state === "CLOSED") {
      this.finish(
        session,
        "FAILED",
        "FAILURE",
        event.code,
        "The device closed the remote-control session",
      );
    }
  }

  /**
   * Return one retained session without revealing either ticket.
   *
   * @param sessionId Session identifier returned during creation.
   * @returns Safe session state, or null when missing or evicted.
   */
  getSession(sessionId: string): RemoteControlSessionView | null {
    this.cleanup();
    const session = this.sessions.get(sessionId);
    return session ? this.view(session) : null;
  }

  /**
   * Authorize a route target only when the active phone signaled that ICE address.
   *
   * @param sessionId Remote-control lease owning the transient candidate set.
   * @param targetAddress Browser-observed remote candidate address.
   * @returns Canonical allow-listed address, or null when probing is forbidden.
   */
  authorizeRouteProbeTarget(
    sessionId: string,
    targetAddress: unknown,
  ): string | null {
    this.cleanup();
    const session = this.sessions.get(sessionId);
    const address = normalizeRemoteControlRouteAddress(targetAddress);
    if (
      !session ||
      isRemoteControlTerminal(session) ||
      !session.controllerSocket ||
      !session.deviceSocket ||
      !address ||
      !session.deviceCandidateAddresses.has(address)
    ) {
      return null;
    }
    return address;
  }

  /**
   * Idempotently close one retained remote-control lease.
   *
   * @param sessionId Session identifier to close.
   * @returns Safe terminal state, or null when the session is unknown.
   */
  closeSession(sessionId: string): RemoteControlSessionView | null {
    this.cleanup();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    this.finish(
      session,
      "CLOSED",
      "CANCELLED",
      "REMOTE_SESSION_CLOSED",
      "Remote-control lease was closed by the controller",
    );
    return this.view(session);
  }

  /**
   * Accept one WSS peer and require an exact ticket-bearing hello first.
   *
   * @param socket WebSocket accepted by the relay endpoint.
   * @param credential Browser-anonymous or device-authenticated handshake class.
   * @param protocolVersion WebSocket-negotiated application protocol version.
   * @returns Nothing.
   */
  acceptSocket(
    socket: WebSocket,
    credential: "browser" | "device",
    protocolVersion: RemoteControlProtocolVersion,
  ): void {
    if (this.unboundSockets.size >= REMOTE_CONTROL_MAX_UNBOUND_SOCKETS) {
      socket.close(1013, "RELAY_CONNECTION_LIMIT");
      return;
    }
    this.unboundSockets.add(socket);
    let binding: {
      session: StoredRemoteControlSession;
      role: RemoteControlPeerRole;
    } | null = null;
    const helloTimer = setTimeout(
      () => socket.close(1008, "RELAY_HELLO_TIMEOUT"),
      REMOTE_CONTROL_HELLO_TIMEOUT_MS,
    );
    helloTimer.unref();
    socket.on("message", (data, isBinary) => {
      try {
        if (!binding) {
          const value: unknown = JSON.parse(
            readRemoteControlText(data, isBinary),
          );
          binding = this.bindHello(
            socket,
            credential,
            protocolVersion,
            value,
          );
          this.unboundSockets.delete(socket);
          clearTimeout(helloTimer);
          return;
        }
        if (isBinary) {
          this.relayBinary(binding.session, binding.role, data);
          return;
        }
        const value: unknown = JSON.parse(readRemoteControlText(data, false));
        if (!isDeviceOpsRecord(value)) throw new Error("Invalid relay frame");
        if (value.type === "relay.p2p.signal") {
          this.handleP2PSignal(binding.session, binding.role, value);
          return;
        }
        if (value.type === "relay.p2p.state") {
          this.handleP2PState(binding.session, binding.role, value);
          return;
        }
        if (value.type === "relay.transport.state") {
          this.handleTransportState(binding.session, binding.role, value);
          return;
        }
        throw new Error("Relay accepts only binary scrcpy frames after ready");
      } catch {
        if (binding && !isRemoteControlTerminal(binding.session)) {
          this.sendJson(socket, {
            protocolVersion,
            type: "relay.error",
            sessionId: binding.session.sessionId,
            code: "RELAY_FRAME_INVALID",
            message: "The relay accepts only bounded scrcpy frames and controlled signaling",
          });
          this.finish(
            binding.session,
            "FAILED",
            "FAILURE",
            "RELAY_FRAME_INVALID",
            "A remote-control peer sent an invalid relay frame",
          );
        } else {
          socket.close(1008, "RELAY_HELLO_INVALID");
        }
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.unboundSockets.delete(socket);
      if (!binding || isRemoteControlTerminal(binding.session)) return;
      const boundSocket =
        binding.role === "controller"
          ? binding.session.controllerSocket
          : binding.session.deviceSocket;
      if (boundSocket === socket) {
        this.finish(
          binding.session,
          "FAILED",
          "FAILURE",
          "REMOTE_PEER_DISCONNECTED",
          "A remote-control peer disconnected; the lease was not replayed",
        );
      }
    });
    socket.on("error", () => undefined);
  }

  /**
   * Convert stored state into a detached ticket-free API view.
   *
   * @param session Stored relay lease.
   * @returns Safe public view.
   */
  private view(session: StoredRemoteControlSession): RemoteControlSessionView {
    return {
      taskId: session.taskId,
      status: session.status,
      sessionId: session.sessionId,
      clientId: session.clientId,
      sessionState: session.sessionState,
      controllerConnected:
        session.controllerSocket?.readyState === WebSocket.OPEN,
      deviceConnected: session.deviceSocket?.readyState === WebSocket.OPEN,
      transportPreference: session.transportPreference,
      selectedTransport: session.selectedTransport,
      p2pAllowed: session.p2pAllowed,
      p2pStatus: session.p2pStatus,
      p2pAttemptId: session.p2pAttemptId,
      p2pNegotiationDurationMs: session.p2pNegotiationDurationMs,
      p2pFailureCode: session.p2pFailureCode,
      p2pSelectedPair: session.p2pSelectedPair
        ? { ...session.p2pSelectedPair }
        : null,
      createTimeUtc: session.createTimeUtc,
      expiresAtUtc: session.expiresAtUtc,
      finishedAtUtc: session.finishedAtUtc,
      code: session.code,
      message: session.message,
      lastDeviceEventState: session.lastDeviceEventState,
      lastDeviceEventCode: session.lastDeviceEventCode,
      lastDeviceEventAtUtc: session.lastDeviceEventAtUtc,
      controllerToDeviceBytes: session.controllerToDeviceBytes,
      deviceToControllerBytes: session.deviceToControllerBytes,
    };
  }

  /**
   * Release timers and sockets owned by an isolated test service.
   *
   * @returns Nothing.
   */
  dispose(): void {
    for (const session of this.sessions.values()) {
      clearTimeout(session.expiryTimer);
      if (session.negotiationTimer) clearTimeout(session.negotiationTimer);
      session.controllerSocket?.terminate();
      session.deviceSocket?.terminate();
    }
    for (const socket of this.unboundSockets) socket.terminate();
    this.sessions.clear();
    this.activeSessionByDevice.clear();
    this.unboundSockets.clear();
  }
}
