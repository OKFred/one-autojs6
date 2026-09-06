import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";

import {
  createRtcSidecarProcess,
  type RtcSidecarCallbacks,
  type RtcSidecarExecutable,
  type RtcSidecarTransport,
} from "./rtc-sidecar-client.js";
import {
  REMOTE_BROWSER_FRAME_MAX_BYTES,
  REMOTE_DEVICE_FRAME_MAX_BYTES,
  REMOTE_SESSION_PROTOCOL_VERSION,
  REMOTE_SESSION_SUBPROTOCOLS,
  REMOTE_SESSION_SUBPROTOCOL_V1,
  REMOTE_SESSION_SUBPROTOCOL_V2,
  parseLocalScrcpyUrl,
  parseRemoteRelayControl,
  parseRemoteRelayOrigin,
  parseRemoteSessionOpenCommand,
  type RemoteRelayHello,
  type RemoteRelayP2PSignal,
  type RemoteRelayP2PState,
  type RemoteRelaySelectedPair,
  type RemoteRelayTransportState,
  type RemoteSessionEvent,
  type RemoteSessionOpenCommand,
  type RemoteSessionProtocolVersion,
} from "./remote-session-protocol.js";

/** Invitations older than this require a newly minted device ticket. */
const REMOTE_INVITATION_MAX_AGE_MS = 30_000;

/** Loopback scrcpy must accept a connection promptly after transport selection. */
const REMOTE_LOCAL_SCRCPY_HANDSHAKE_TIMEOUT_MS = 5_000;

/** Bounded browser controls accepted while the local scrcpy socket opens. */
const REMOTE_PENDING_CONTROL_MAX_BYTES = 4 * REMOTE_BROWSER_FRAME_MAX_BYTES;

/** Stop a slow remote consumer before video buffering becomes unbounded. */
const REMOTE_RELAY_BUFFERED_MAX_BYTES = 8 * 1024 * 1024;

/** Bound video initialization frames while relay recovery is committed. */
const REMOTE_PENDING_DEVICE_MAX_BYTES = 8 * 1024 * 1024;

/** Stop a slow local scrcpy consumer before controls accumulate. */
const REMOTE_LOCAL_BUFFERED_MAX_BYTES = 4 * REMOTE_BROWSER_FRAME_MAX_BYTES;

/** Delay recovery for a transient WebRTC disconnected state. */
const REMOTE_P2P_DISCONNECTED_GRACE_MS = 3_000;

/** Briefly prefer the specific MQTT close event before WSS teardown. */
const REMOTE_CLOSE_EVENT_GRACE_MS = 250;

/** Dependencies for a device-initiated remote-control peer. */
export interface RemoteSessionPeerOptions {
  deviceId: string;
  reportToken: string;
  allowedRelayOrigins: string[];
  localScrcpyUrl: string;
  isDeploymentBlocked: () => boolean;
  isDeviceControlBusy?: () => boolean;
  onInactive?: () => void;
  publishEvent: (event: RemoteSessionEvent) => Promise<void>;
  rtcSidecarExecutable?: RtcSidecarExecutable;
  createRtcSidecar?: (callbacks: RtcSidecarCallbacks) => RtcSidecarTransport;
  now?: () => number;
}

/** One active relay lease and its selected data path. */
interface ActiveRemoteSession {
  command: Omit<RemoteSessionOpenCommand, "deviceTicket">;
  relaySocket: WebSocket | null;
  localSocket: WebSocket | null;
  sidecar: RtcSidecarTransport | null;
  protocolVersion: RemoteSessionProtocolVersion | null;
  selectedTransport: "relay" | "p2p" | null;
  paired: boolean;
  bridged: boolean;
  recovering: boolean;
  awaitingRecovery: boolean;
  connectedReported: boolean;
  closed: boolean;
  attemptId: string | null;
  incomingP2PSequence: number;
  outgoingP2PSequence: number;
  p2pReady: boolean;
  p2pReadyReported: boolean;
  p2pFailureReported: boolean;
  pendingLocalCandidates: Array<{
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
  }>;
  answerSent: boolean;
  pendingControls: Array<{
    transport: "relay" | "p2p";
    content: Buffer;
  }>;
  pendingControlBytes: number;
  pendingDeviceFrames: Buffer[];
  pendingDeviceBytes: number;
  disconnectedTimer: NodeJS.Timeout | null;
  expiryTimer: NodeJS.Timeout | null;
}

/**
 * Convert a complete WebSocket message to an owned buffer.
 *
 * @param data Complete message emitted by the `ws` client.
 * @returns Buffer that does not share mutable caller-owned storage.
 */
function messageBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((value) => Buffer.from(value)));
  }
  return Buffer.from(data);
}

/**
 * Close or terminate a socket without throwing during connection setup.
 *
 * @param socket Socket to close, if one was created.
 * @returns Nothing.
 */
function closeSocket(socket: WebSocket | null): void {
  if (!socket) return;
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1000, "REMOTE_SESSION_CLOSED");
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }
}

/**
 * Wait briefly for a best-effort audit publication without leaking a timer.
 *
 * @param delivery Audit delivery that may reject or stall.
 * @param timeoutMs Maximum delay before socket teardown continues.
 * @returns Completion after delivery settles or the deadline elapses.
 */
function waitForBestEffortDelivery(
  delivery: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void delivery.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/** Bridge a local loopback scrcpy WebSocket to relay or Pion data transport. */
export class RemoteSessionPeer {
  private readonly now: () => number;
  private readonly allowedRelayOrigins: Set<string>;
  private readonly localScrcpyUrl: string;
  private readonly consumedSessions = new Map<string, number>();
  private active: ActiveRemoteSession | null = null;

  /**
   * Create a peer with no listening socket or inbound network surface.
   *
   * @param options Trusted local dependencies and security policy.
   */
  constructor(private readonly options: RemoteSessionPeerOptions) {
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(options.deviceId)) {
      throw new Error("Invalid remote peer deviceId");
    }
    if (
      options.reportToken.length < 16 ||
      options.reportToken.length > 4096 ||
      /[^\x21-\x7e]/.test(options.reportToken)
    ) {
      throw new Error("Remote peer requires a bounded device report token");
    }
    this.now = options.now || Date.now;
    this.localScrcpyUrl = parseLocalScrcpyUrl(options.localScrcpyUrl);
    this.allowedRelayOrigins = new Set(
      options.allowedRelayOrigins.map((origin) => parseRemoteRelayOrigin(origin)),
    );
    if (this.allowedRelayOrigins.size === 0) {
      throw new Error("Remote peer requires at least one relay origin");
    }
  }

  /**
   * Return whether this device owns or is still tearing down a remote lease.
   *
   * @returns Whether a lease still occupies the device-control slot.
   */
  isActive(): boolean {
    return Boolean(this.active);
  }

  /**
   * Publish a lifecycle event that never contains a ticket, SDP, or candidate.
   *
   * @param sessionId Session correlated with the event.
   * @param state Sanitized lifecycle state.
   * @param code Stable machine-readable reason.
   * @param message Human-readable diagnostic without secret material.
   * @returns Completion of the configured audit publisher.
   */
  private event(
    sessionId: string,
    state: RemoteSessionEvent["state"],
    code: string,
    message: string,
  ): Promise<void> {
    const safeCode = /^[A-Z0-9_]{1,100}$/.test(code)
      ? code
      : "REMOTE_SESSION_EVENT";
    const safeMessage =
      message.replace(/[\r\n\t]+/g, " ").trim().slice(0, 1000) ||
      "Remote session state changed";
    return this.options.publishEvent({
      protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
      type: "REMOTE_SESSION_EVENT",
      eventId: `event_${randomUUID().replaceAll("-", "")}`,
      sessionId,
      deviceId: this.options.deviceId,
      state,
      code: safeCode,
      message: safeMessage,
      timestamp: this.now(),
    });
  }

  /**
   * Remove expired replay markers without retaining ticket material.
   *
   * @returns Nothing.
   */
  private pruneConsumedSessions(): void {
    const now = this.now();
    for (const [sessionId, expiresAt] of this.consumedSessions) {
      if (expiresAt <= now) this.consumedSessions.delete(sessionId);
    }
  }

  /**
   * Clear the transient WebRTC disconnect deadline.
   *
   * @param session Active session owning the timer.
   * @returns Nothing.
   */
  private clearDisconnectedTimer(session: ActiveRemoteSession): void {
    if (session.disconnectedTimer) clearTimeout(session.disconnectedTimer);
    session.disconnectedTimer = null;
  }

  /**
   * Detach and stop one Pion process without letting its close callback race.
   *
   * @param session Active session owning the sidecar.
   * @returns Nothing.
   */
  private closeSidecar(session: ActiveRemoteSession): void {
    const sidecar = session.sidecar;
    session.sidecar = null;
    sidecar?.close();
  }

  /**
   * Close one active lease and propagate a sanitized audit event.
   *
   * @param session Active lease to close idempotently.
   * @param code Stable machine-readable close reason.
   * @param message Non-secret close diagnostic.
   * @returns Completion of the best-effort lifecycle event attempt.
   */
  private async closeActive(
    session: ActiveRemoteSession,
    code: string,
    message: string,
  ): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    this.clearDisconnectedTimer(session);
    session.pendingControls.length = 0;
    session.pendingControlBytes = 0;
    session.pendingDeviceFrames.length = 0;
    session.pendingDeviceBytes = 0;
    this.closeSidecar(session);
    await waitForBestEffortDelivery(
      Promise.resolve().then(() =>
        this.event(session.command.sessionId, "CLOSED", code, message),
      ),
      REMOTE_CLOSE_EVENT_GRACE_MS,
    );
    closeSocket(session.localSocket);
    closeSocket(session.relaySocket);
    if (this.active === session) this.active = null;
    this.options.onInactive?.();
  }

  /**
   * Close the active lease, if any.
   *
   * @param code Stable machine-readable close reason.
   * @param message Non-secret close diagnostic.
   * @returns Completion after bounded event grace and socket teardown initiation.
   */
  async close(code: string, message: string): Promise<void> {
    const session = this.active;
    if (!session) return;
    await this.closeActive(session, code, message);
  }

  /**
   * Send one bounded JSON frame through the authenticated signaling WSS.
   *
   * @param session Active remote-control lease.
   * @param value Strict protocol object without credentials.
   * @returns Whether the frame was accepted for sending.
   */
  private sendRelayJson(
    session: ActiveRemoteSession,
    value: Record<string, unknown>,
  ): boolean {
    const relay = session.relaySocket;
    const content = JSON.stringify(value);
    const bytes = Buffer.byteLength(content, "utf8");
    if (
      !relay ||
      relay.readyState !== WebSocket.OPEN ||
      bytes > REMOTE_BROWSER_FRAME_MAX_BYTES ||
      relay.bufferedAmount + bytes > REMOTE_RELAY_BUFFERED_MAX_BYTES
    ) {
      void this.closeActive(
        session,
        "REMOTE_RELAY_SIGNALING_UNAVAILABLE",
        "Remote relay signaling channel is not writable",
      );
      return false;
    }
    relay.send(content, (error) => {
      if (error) {
        void this.closeActive(
          session,
          "REMOTE_RELAY_SIGNALING_FAILED",
          "Writing remote relay signaling failed",
        );
      }
    });
    return true;
  }

  /**
   * Send one browser control frame to the loopback scrcpy server.
   *
   * @param session Active remote-control lease.
   * @param transport Authenticated data path that delivered the control.
   * @param content Opaque binary scrcpy control message.
   * @returns Nothing.
   */
  private sendToLocal(
    session: ActiveRemoteSession,
    transport: "relay" | "p2p",
    content: Buffer,
  ): void {
    const local = session.localSocket;
    if (!session.bridged || !local || local.readyState !== WebSocket.OPEN) {
      if (
        (session.selectedTransport !== null &&
          session.selectedTransport !== transport) ||
        session.pendingControls.some(
          (pending) => pending.transport !== transport,
        )
      ) {
        void this.closeActive(
          session,
          "REMOTE_CONTROL_TRANSPORT_MISMATCH",
          "Browser controls arrived on conflicting data transports",
        );
        return;
      }
      if (
        session.pendingControlBytes + content.byteLength >
        REMOTE_PENDING_CONTROL_MAX_BYTES
      ) {
        void this.closeActive(
          session,
          "REMOTE_CONTROL_BUFFER_FULL",
          "Browser controls arrived before local scrcpy was ready",
        );
        return;
      }
      session.pendingControls.push({
        transport,
        content: Buffer.from(content),
      });
      session.pendingControlBytes += content.byteLength;
      return;
    }
    if (session.selectedTransport !== transport) {
      void this.closeActive(
        session,
        "REMOTE_CONTROL_TRANSPORT_MISMATCH",
        "Browser controls arrived on the unselected data transport",
      );
      return;
    }
    if (local.bufferedAmount + content.byteLength > REMOTE_LOCAL_BUFFERED_MAX_BYTES) {
      void this.closeActive(
        session,
        "LOCAL_SCRCPY_BACKPRESSURE",
        "Local scrcpy control channel is not writable",
      );
      return;
    }
    local.send(content, { binary: true }, (error) => {
      if (error) {
        void this.closeActive(
          session,
          "LOCAL_SCRCPY_WRITE_FAILED",
          "Writing a control frame to local scrcpy failed",
        );
      }
    });
  }

  /**
   * Send one scrcpy device frame to the WSS relay data path.
   *
   * @param session Active relay lease.
   * @param content Opaque binary scrcpy device or media message.
   * @returns Nothing.
   */
  private sendToRelay(session: ActiveRemoteSession, content: Buffer): void {
    const relay = session.relaySocket;
    if (
      session.selectedTransport !== "relay" ||
      !relay ||
      relay.readyState !== WebSocket.OPEN ||
      relay.bufferedAmount + content.byteLength > REMOTE_RELAY_BUFFERED_MAX_BYTES
    ) {
      void this.closeActive(
        session,
        "REMOTE_RELAY_BACKPRESSURE",
        "Remote relay video channel is not writable",
      );
      return;
    }
    relay.send(content, { binary: true }, (error) => {
      if (error) {
        void this.closeActive(
          session,
          "REMOTE_RELAY_WRITE_FAILED",
          "Writing a device frame to the remote relay failed",
        );
      }
    });
  }

  /**
   * Queue a device frame until relay recovery is committed by the service.
   *
   * @param session Recovering remote-control lease.
   * @param content Opaque complete scrcpy frame.
   * @returns Nothing.
   */
  private queueDeviceFrame(session: ActiveRemoteSession, content: Buffer): void {
    if (
      session.pendingDeviceBytes + content.byteLength >
      REMOTE_PENDING_DEVICE_MAX_BYTES
    ) {
      void this.closeActive(
        session,
        "REMOTE_RECOVERY_BUFFER_FULL",
        "Relay recovery video buffer exceeded its limit",
      );
      return;
    }
    session.pendingDeviceFrames.push(Buffer.from(content));
    session.pendingDeviceBytes += content.byteLength;
  }

  /**
   * Route one local scrcpy device frame over the selected transport.
   *
   * @param session Active remote-control lease.
   * @param content Opaque complete scrcpy frame.
   * @returns Nothing.
   */
  private handleLocalBinary(session: ActiveRemoteSession, content: Buffer): void {
    if (content.byteLength > REMOTE_DEVICE_FRAME_MAX_BYTES) {
      void this.closeActive(
        session,
        "REMOTE_DEVICE_FRAME_TOO_LARGE",
        "Local scrcpy frame exceeded the 4 MiB limit",
      );
      return;
    }
    if (session.recovering || session.selectedTransport === null) {
      this.queueDeviceFrame(session, content);
      return;
    }
    if (session.selectedTransport === "relay") {
      this.sendToRelay(session, content);
      return;
    }
    try {
      if (!session.sidecar) throw new Error("P2P sidecar is unavailable");
      session.sidecar.sendBinary(content);
    } catch {
      this.reportActiveP2PFailure(session, "RTC_SEND_FAILED");
    }
  }

  /**
   * Handle one browser-to-device WSS binary frame after relay selection.
   *
   * @param session Active relay lease.
   * @param content Opaque binary scrcpy control message.
   * @returns Nothing.
   */
  private handleRelayBinary(session: ActiveRemoteSession, content: Buffer): void {
    if (
      content.byteLength === 0 ||
      content.byteLength > REMOTE_BROWSER_FRAME_MAX_BYTES
    ) {
      void this.closeActive(
        session,
        "REMOTE_CONTROL_FRAME_INVALID",
        "Browser control frame must contain 1 to 65536 bytes",
      );
      return;
    }
    if (!session.paired) {
      if (
        session.protocolVersion !== null &&
        session.selectedTransport === null &&
        !session.recovering
      ) {
        this.sendToLocal(session, "relay", content);
        return;
      }
      void this.closeActive(
        session,
        "REMOTE_RELAY_SEQUENCE_INVALID",
        "Relay sent binary data outside the initial selection phase",
      );
      return;
    }
    if (session.selectedTransport !== "relay") {
      void this.closeActive(
        session,
        "REMOTE_RELAY_SEQUENCE_INVALID",
        "Relay sent binary data outside the selected relay data phase",
      );
      return;
    }
    this.sendToLocal(session, "relay", content);
  }

  /**
   * Handle one reassembled browser control from the Pion sidecar.
   *
   * @param session Active P2P lease.
   * @param sidecar Sidecar instance that emitted the frame.
   * @param content Opaque complete scrcpy control frame.
   * @returns Nothing.
   */
  private handleSidecarBinary(
    session: ActiveRemoteSession,
    sidecar: RtcSidecarTransport,
    content: Buffer,
  ): void {
    if (session.sidecar !== sidecar) {
      return;
    }
    if (
      content.byteLength === 0 ||
      content.byteLength > REMOTE_BROWSER_FRAME_MAX_BYTES
    ) {
      if (session.paired && session.selectedTransport === "p2p") {
        this.reportActiveP2PFailure(session, "RTC_CONTROL_FRAME_INVALID");
      } else {
        this.reportInitialP2PFailure(session, "RTC_CONTROL_FRAME_INVALID");
      }
      return;
    }
    if (!session.paired) {
      if (
        session.protocolVersion === 2 &&
        session.selectedTransport === null &&
        !session.recovering &&
        session.attemptId !== null &&
        session.p2pReady
      ) {
        this.sendToLocal(session, "p2p", content);
        return;
      }
      this.reportInitialP2PFailure(session, "RTC_CONTROL_SEQUENCE_INVALID");
      return;
    }
    if (session.selectedTransport !== "p2p") {
      void this.closeActive(
        session,
        "RTC_CONTROL_SEQUENCE_INVALID",
        "P2P control arrived outside the selected P2P data phase",
      );
      return;
    }
    this.sendToLocal(session, "p2p", content);
  }

  /**
   * Reserve one shared signal-or-state sequence for the device role.
   *
   * @param session Negotiating or active v2 lease.
   * @returns Reserved sequence, or `null` after closing an exhausted lease.
   */
  private takeOutgoingP2PSequence(
    session: ActiveRemoteSession,
  ): number | null {
    if (!session.attemptId || session.outgoingP2PSequence > 1_000_000) {
      void this.closeActive(
        session,
        "REMOTE_P2P_SEQUENCE_INVALID",
        "P2P signaling sequence exceeded its bounds",
      );
      return null;
    }
    const sequence = session.outgoingP2PSequence;
    session.outgoingP2PSequence += 1;
    return sequence;
  }

  /**
   * Send one answer or candidate with the shared per-device sequence.
   *
   * @param session Negotiating v2 lease.
   * @param signal Answer or local ICE candidate.
   * @returns Nothing.
   */
  private sendP2PSignal(
    session: ActiveRemoteSession,
    signal:
      | { signalType: "answer"; description: { type: "answer"; sdp: string } }
      | {
          signalType: "ice-candidate";
          candidate: {
            candidate: string;
            sdpMid?: string;
            sdpMLineIndex?: number;
          };
        },
  ): void {
    const sequence = this.takeOutgoingP2PSequence(session);
    if (sequence === null || !session.attemptId) return;
    const frame: RemoteRelayP2PSignal = {
      protocolVersion: 2,
      type: "relay.p2p.signal",
      sessionId: session.command.sessionId,
      attemptId: session.attemptId,
      sequence,
      ...signal,
    };
    this.sendRelayJson(session, frame as unknown as Record<string, unknown>);
  }

  /**
   * Report one ready-or-failed P2P state without exposing candidate addresses.
   *
   * @param session Negotiating or active P2P lease.
   * @param state Ready or failed state.
   * @param reasonCode Optional sanitized failure reason.
   * @param selectedPair Optional candidate types and protocol only.
   * @returns Nothing.
   */
  private sendP2PState(
    session: ActiveRemoteSession,
    state: "ready" | "failed",
    reasonCode?: string,
    selectedPair?: RemoteRelaySelectedPair,
  ): void {
    const sequence = this.takeOutgoingP2PSequence(session);
    if (sequence === null || !session.attemptId) return;
    const frame: RemoteRelayP2PState = {
      protocolVersion: 2,
      type: "relay.p2p.state",
      sessionId: session.command.sessionId,
      attemptId: session.attemptId,
      sequence,
      state,
      ...(reasonCode ? { reasonCode } : {}),
      ...(selectedPair ? { selectedPair } : {}),
    };
    this.sendRelayJson(session, frame as unknown as Record<string, unknown>);
  }

  /**
   * Create the configured or production Pion sidecar wrapper.
   *
   * @param callbacks Strict event callbacks for one sidecar instance.
   * @returns Unstarted sidecar transport.
   */
  private createSidecar(callbacks: RtcSidecarCallbacks): RtcSidecarTransport {
    if (this.options.createRtcSidecar) {
      return this.options.createRtcSidecar(callbacks);
    }
    if (!this.options.rtcSidecarExecutable) {
      throw new Error("RTC sidecar is absent from this release");
    }
    return createRtcSidecarProcess({
      ...this.options.rtcSidecarExecutable,
      callbacks,
    });
  }

  /**
   * Start the Pion answerer for one service-authorized attempt.
   *
   * @param session v2 lease awaiting transport selection.
   * @param attemptId One-time service negotiation identifier.
   * @param iceServers STUN-only service configuration.
   * @returns Nothing.
   */
  private startP2P(
    session: ActiveRemoteSession,
    attemptId: string,
    iceServers: Parameters<RtcSidecarTransport["start"]>[0],
  ): void {
    if (session.attemptId || session.sidecar || session.paired) {
      void this.closeActive(
        session,
        "REMOTE_P2P_START_INVALID",
        "Remote relay started P2P more than once",
      );
      return;
    }
    session.attemptId = attemptId;
    session.incomingP2PSequence = 0;
    session.outgoingP2PSequence = 0;
    session.p2pReady = false;
    session.p2pReadyReported = false;
    session.p2pFailureReported = false;
    session.pendingLocalCandidates.length = 0;
    session.answerSent = false;
    let sidecar: RtcSidecarTransport;
    const callbacks: RtcSidecarCallbacks = {
      onLocalDescription: (description) => {
        if (
          session.sidecar === sidecar &&
          !session.closed &&
          !session.p2pReadyReported &&
          !session.p2pFailureReported
        ) {
          this.sendP2PSignal(session, { signalType: "answer", description });
          session.answerSent = true;
          const pendingCandidates = session.pendingLocalCandidates.splice(0);
          for (const candidate of pendingCandidates) {
            this.sendP2PSignal(session, {
              signalType: "ice-candidate",
              candidate,
            });
          }
        }
      },
      onIceCandidate: (candidate) => {
        if (
          session.sidecar === sidecar &&
          !session.closed &&
          !session.p2pReadyReported &&
          !session.p2pFailureReported
        ) {
          if (!session.answerSent) {
            if (session.pendingLocalCandidates.length >= 128) {
              this.reportInitialP2PFailure(
                session,
                "RTC_CANDIDATE_BUFFER_FULL",
              );
              return;
            }
            session.pendingLocalCandidates.push(candidate);
          } else {
            this.sendP2PSignal(session, {
              signalType: "ice-candidate",
              candidate,
            });
          }
        }
      },
      onState: (state) => {
        if (session.sidecar === sidecar && !session.closed) {
          this.handleSidecarState(session, state);
        }
      },
      onBinary: (content) => this.handleSidecarBinary(session, sidecar, content),
    };
    try {
      sidecar = this.createSidecar(callbacks);
      session.sidecar = sidecar;
      sidecar.start(iceServers);
    } catch {
      this.reportInitialP2PFailure(session, "RTC_SIDECAR_UNAVAILABLE");
    }
  }

  /**
   * Handle a sanitized sidecar connection state.
   *
   * @param session Owning remote-control lease.
   * @param state Sanitized Pion lifecycle state.
   * @returns Nothing.
   */
  private handleSidecarState(
    session: ActiveRemoteSession,
    state: Parameters<RtcSidecarCallbacks["onState"]>[0],
  ): void {
    if (state.state === "ready") {
      this.clearDisconnectedTimer(session);
      session.p2pReady = true;
      if (
        !session.paired &&
        !session.p2pReadyReported &&
        !session.p2pFailureReported
      ) {
        session.p2pReadyReported = true;
        this.sendP2PState(session, "ready", undefined, state.selectedPair);
      }
      return;
    }
    if (state.state === "disconnected") {
      const isActiveP2P = session.selectedTransport === "p2p";
      const isReadyBeforeSelection =
        !session.paired &&
        session.p2pReadyReported &&
        !session.p2pFailureReported &&
        session.attemptId !== null;
      if ((!isActiveP2P && !isReadyBeforeSelection) || session.disconnectedTimer) {
        return;
      }
      session.disconnectedTimer = setTimeout(() => {
        session.disconnectedTimer = null;
        if (session.closed) return;
        if (session.selectedTransport === "p2p") {
          this.reportActiveP2PFailure(session, "RTC_DISCONNECTED_TIMEOUT");
        } else if (
          !session.paired &&
          session.p2pReadyReported &&
          !session.p2pFailureReported
        ) {
          this.reportInitialP2PFailure(session, "RTC_DISCONNECTED_TIMEOUT");
        }
      }, REMOTE_P2P_DISCONNECTED_GRACE_MS);
      session.disconnectedTimer.unref();
      return;
    }
    const reasonCode = state.reasonCode || "RTC_CONNECTION_FAILED";
    if (session.selectedTransport === "p2p") {
      this.reportActiveP2PFailure(session, reasonCode);
    } else if (!session.paired) {
      this.reportInitialP2PFailure(session, reasonCode);
    }
  }

  /**
   * Report negotiation failure and await the service's initial relay decision.
   *
   * @param session Negotiating v2 lease.
   * @param reasonCode Sanitized sidecar failure reason.
   * @returns Nothing.
   */
  private reportInitialP2PFailure(
    session: ActiveRemoteSession,
    reasonCode: string,
  ): void {
    if (session.p2pFailureReported || !session.attemptId) return;
    this.clearDisconnectedTimer(session);
    session.p2pFailureReported = true;
    session.p2pReady = false;
    session.pendingLocalCandidates.length = 0;
    session.pendingControls = session.pendingControls.filter(
      (pending) => pending.transport === "relay",
    );
    session.pendingControlBytes = session.pendingControls.reduce(
      (total, pending) => total + pending.content.byteLength,
      0,
    );
    this.closeSidecar(session);
    this.sendP2PState(session, "failed", reasonCode);
  }

  /**
   * Freeze an active P2P path, report failure, and await relay recovery.
   *
   * @param session Active P2P lease.
   * @param reasonCode Sanitized transport failure reason.
   * @returns Nothing.
   */
  private reportActiveP2PFailure(
    session: ActiveRemoteSession,
    reasonCode: string,
  ): void {
    if (session.recovering || session.selectedTransport !== "p2p") return;
    this.clearDisconnectedTimer(session);
    session.recovering = true;
    session.paired = false;
    session.selectedTransport = null;
    session.p2pReady = false;
    session.p2pFailureReported = true;
    session.pendingLocalCandidates.length = 0;
    this.closeSidecar(session);
    const local = session.localSocket;
    session.localSocket = null;
    session.bridged = false;
    closeSocket(local);
    session.pendingControls.length = 0;
    session.pendingControlBytes = 0;
    session.pendingDeviceFrames.length = 0;
    session.pendingDeviceBytes = 0;
    this.sendP2PState(session, "failed", reasonCode);
  }

  /**
   * Apply one strictly sequenced controller offer or candidate.
   *
   * @param session Negotiating v2 lease.
   * @param signal Strict server-forwarded controller signal.
   * @returns Nothing.
   */
  private handleP2PSignal(
    session: ActiveRemoteSession,
    signal: RemoteRelayP2PSignal,
  ): void {
    if (
      !session.sidecar &&
      session.p2pFailureReported &&
      !session.p2pReady &&
      signal.attemptId === session.attemptId &&
      signal.sequence === session.incomingP2PSequence &&
      signal.signalType !== "offer"
    ) {
      session.incomingP2PSequence += 1;
      return;
    }
    if (
      !session.sidecar ||
      signal.attemptId !== session.attemptId ||
      signal.sequence !== session.incomingP2PSequence ||
      (signal.sequence === 0 && signal.signalType !== "offer") ||
      (signal.sequence > 0 && signal.signalType === "offer")
    ) {
      void this.closeActive(
        session,
        "REMOTE_P2P_SIGNAL_INVALID",
        "Remote P2P signal was stale, duplicated, or out of order",
      );
      return;
    }
    session.incomingP2PSequence += 1;
    try {
      if (signal.signalType === "offer" && signal.description) {
        session.sidecar.setRemoteDescription({
          type: "offer",
          sdp: signal.description.sdp,
        });
      } else if (signal.signalType === "ice-candidate" && signal.candidate) {
        session.sidecar.addIceCandidate(signal.candidate);
      } else {
        throw new Error("Unsupported device signal");
      }
    } catch {
      this.reportInitialP2PFailure(session, "RTC_SIGNAL_APPLY_FAILED");
    }
  }

  /**
   * Connect to the fixed loopback-only ws-scrcpy Android server.
   *
   * @param session Lease whose transport is selected or recovering.
   * @returns Nothing.
   */
  private connectLocalScrcpy(session: ActiveRemoteSession): void {
    if (session.closed || this.active !== session || session.localSocket) return;
    const local = new WebSocket(this.localScrcpyUrl, {
      handshakeTimeout: REMOTE_LOCAL_SCRCPY_HANDSHAKE_TIMEOUT_MS,
      maxPayload: REMOTE_DEVICE_FRAME_MAX_BYTES,
      perMessageDeflate: false,
    });
    session.localSocket = local;
    local.on("open", () => {
      if (
        session.closed ||
        this.active !== session ||
        session.localSocket !== local
      ) {
        return closeSocket(local);
      }
      session.bridged = true;
      const pending = session.pendingControls.splice(0);
      session.pendingControlBytes = 0;
      for (const { transport, content } of pending) {
        this.sendToLocal(session, transport, content);
        if (session.closed) return;
      }
      if (session.recovering) {
        const state: RemoteRelayTransportState = {
          protocolVersion: 2,
          type: "relay.transport.state",
          sessionId: session.command.sessionId,
          transport: "relay",
          state: "ready",
        };
        this.sendRelayJson(session, state as unknown as Record<string, unknown>);
        return;
      }
      const p2p = session.selectedTransport === "p2p";
      if (!session.connectedReported) {
        session.connectedReported = true;
        void this.event(
          session.command.sessionId,
          "CONNECTED",
          p2p ? "REMOTE_P2P_BRIDGED" : "REMOTE_RELAY_BRIDGED",
          p2p
            ? "P2P data channel is bridged to local scrcpy"
            : "Remote relay is bridged to local scrcpy",
        ).catch(() => undefined);
      }
    });
    local.on("message", (data, isBinary) => {
      if (
        session.closed ||
        this.active !== session ||
        session.localSocket !== local
      ) {
        return;
      }
      if (!isBinary) {
        void this.closeActive(
          session,
          "LOCAL_SCRCPY_TEXT_REJECTED",
          "Local scrcpy emitted a non-binary frame",
        );
        return;
      }
      this.handleLocalBinary(session, messageBuffer(data));
    });
    local.on("error", () => {
      if (session.localSocket !== local) return;
      void this.closeActive(
        session,
        "LOCAL_SCRCPY_UNAVAILABLE",
        "The loopback ws-scrcpy Android server is unavailable",
      );
    });
    local.on("close", () => {
      if (!session.closed && session.localSocket === local) {
        void this.closeActive(
          session,
          "LOCAL_SCRCPY_CLOSED",
          "The loopback ws-scrcpy Android server closed",
        );
      }
    });
  }

  /**
   * Validate and apply the server's initial selected transport.
   *
   * @param session Active lease awaiting relay.ready.
   * @param transport Selected data transport.
   * @param expiresAt Effective lease expiry.
   * @returns Nothing.
   */
  private selectInitialTransport(
    session: ActiveRemoteSession,
    transport: "relay" | "p2p",
    expiresAt: number,
  ): void {
    const p2pUnavailable =
      transport === "p2p" && (!session.p2pReady || !session.sidecar);
    const failedAfterReady =
      session.p2pReadyReported && session.p2pFailureReported;
    if (
      session.paired ||
      session.awaitingRecovery ||
      expiresAt <= this.now() ||
      expiresAt > session.command.expiresAt ||
      (p2pUnavailable && !failedAfterReady) ||
      session.pendingControls.some(
        (pending) => pending.transport !== transport,
      )
    ) {
      void this.closeActive(
        session,
        "REMOTE_RELAY_READY_INVALID",
        "Remote relay returned an invalid transport decision",
      );
      return;
    }
    this.applyEffectiveExpiry(session, expiresAt);
    if (p2pUnavailable) {
      session.awaitingRecovery = true;
      return;
    }
    session.paired = true;
    session.selectedTransport = transport;
    if (transport === "relay") this.closeSidecar(session);
    this.connectLocalScrcpy(session);
  }

  /**
   * Apply a service-shortened lease expiry without ever extending the invite.
   *
   * @param session Active lease whose expiry may be shortened.
   * @param expiresAt Valid service-selected expiry.
   * @returns Nothing.
   */
  private applyEffectiveExpiry(
    session: ActiveRemoteSession,
    expiresAt: number,
  ): void {
    if (expiresAt >= session.command.expiresAt) return;
    session.command.expiresAt = expiresAt;
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.expiryTimer = setTimeout(
      () =>
        void this.closeActive(
          session,
          "REMOTE_SESSION_EXPIRED",
          "Remote-control lease expired",
        ),
      Math.max(1, expiresAt - this.now()),
    );
    session.expiryTimer.unref();
  }

  /**
   * Prepare or commit the one allowed P2P-to-relay recovery.
   *
   * @param session Active v2 lease.
   * @param phase Server-coordinated recovery phase.
   * @returns Nothing.
   */
  private handleTransportRecovery(
    session: ActiveRemoteSession,
    phase: "recovering" | "ready",
  ): void {
    if (phase === "recovering") {
      if (session.awaitingRecovery) {
        session.awaitingRecovery = false;
        session.recovering = true;
        this.connectLocalScrcpy(session);
        return;
      }
      if (session.selectedTransport === "p2p") {
        this.reportActiveP2PFailure(session, "RTC_PEER_RECOVERY_REQUESTED");
      }
      if (!session.recovering) {
        void this.closeActive(
          session,
          "REMOTE_RECOVERY_SEQUENCE_INVALID",
          "Relay recovery was requested outside an active P2P session",
        );
        return;
      }
      this.connectLocalScrcpy(session);
      return;
    }
    if (!session.recovering || !session.bridged || !session.localSocket) {
      void this.closeActive(
        session,
        "REMOTE_RECOVERY_SEQUENCE_INVALID",
        "Relay recovery was committed before local scrcpy was ready",
      );
      return;
    }
    session.recovering = false;
    session.paired = true;
    session.selectedTransport = "relay";
    const pending = session.pendingDeviceFrames.splice(0);
    session.pendingDeviceBytes = 0;
    for (const content of pending) this.sendToRelay(session, content);
    if (!session.connectedReported) {
      session.connectedReported = true;
      void this.event(
        session.command.sessionId,
        "CONNECTED",
        "REMOTE_RELAY_BRIDGED",
        "Remote relay is bridged to local scrcpy",
      ).catch(() => undefined);
    }
  }

  /**
   * Handle a strict server relay control frame.
   *
   * @param session Active lease.
   * @param content Complete UTF-8 relay control message.
   * @returns Nothing.
   */
  private handleRelayText(
    session: ActiveRemoteSession,
    content: Buffer,
  ): void {
    if (!session.protocolVersion) {
      void this.closeActive(
        session,
        "REMOTE_RELAY_PROTOCOL_INVALID",
        "Remote relay sent control before protocol negotiation",
      );
      return;
    }
    let control;
    try {
      control = parseRemoteRelayControl(
        JSON.parse(content.toString("utf8")) as unknown,
        session.command.sessionId,
        session.protocolVersion,
      );
    } catch {
      void this.closeActive(
        session,
        "REMOTE_RELAY_PROTOCOL_INVALID",
        "Remote relay sent an invalid text control frame",
      );
      return;
    }
    if (control.type === "relay.ready") {
      this.selectInitialTransport(session, control.transport, control.expiresAt);
      return;
    }
    if (control.type === "relay.p2p.start") {
      if (
        control.deadlineAt <= this.now() ||
        control.deadlineAt > session.command.expiresAt
      ) {
        void this.closeActive(
          session,
          "REMOTE_P2P_DEADLINE_INVALID",
          "Remote relay returned an invalid P2P deadline",
        );
        return;
      }
      this.startP2P(session, control.attemptId, control.iceServers);
      return;
    }
    if (control.type === "relay.p2p.signal") {
      this.handleP2PSignal(session, control);
      return;
    }
    if (control.type === "relay.transport") {
      this.handleTransportRecovery(session, control.phase);
      return;
    }
    void this.closeActive(session, control.code, control.message);
  }

  /**
   * Open the only public connection: an authenticated outbound relay WSS.
   *
   * @param session Fresh remote-control lease.
   * @param deviceTicket One-time ticket sent only in the first application frame.
   * @returns Nothing.
   */
  private connectRelay(
    session: ActiveRemoteSession,
    deviceTicket: string,
  ): void {
    let pendingTicket: string | null = deviceTicket;
    deviceTicket = "";
    const relay = new WebSocket(
      session.command.relayWsUrl,
      [...REMOTE_SESSION_SUBPROTOCOLS],
      {
        headers: { Authorization: `Device ${this.options.reportToken}` },
        handshakeTimeout: 15_000,
        maxPayload: REMOTE_BROWSER_FRAME_MAX_BYTES,
        perMessageDeflate: false,
      },
    );
    session.relaySocket = relay;
    relay.on("open", () => {
      if (session.closed || this.active !== session) return closeSocket(relay);
      if (session.command.expiresAt <= this.now()) {
        void this.closeActive(
          session,
          "REMOTE_SESSION_EXPIRED",
          "Remote-control lease expired before relay connection",
        );
        return;
      }
      if (!pendingTicket) {
        void this.closeActive(
          session,
          "REMOTE_RELAY_TICKET_UNAVAILABLE",
          "Remote relay ticket was unavailable before pairing",
        );
        return;
      }
      session.protocolVersion =
        relay.protocol === REMOTE_SESSION_SUBPROTOCOL_V2
          ? 2
          : relay.protocol === REMOTE_SESSION_SUBPROTOCOL_V1
            ? 1
            : null;
      if (!session.protocolVersion) {
        void this.closeActive(
          session,
          "REMOTE_RELAY_SUBPROTOCOL_INVALID",
          "Remote relay did not select a supported application protocol",
        );
        return;
      }
      const hello: RemoteRelayHello = {
        protocolVersion: session.protocolVersion,
        type: "relay.hello",
        role: "device",
        sessionId: session.command.sessionId,
        deviceId: this.options.deviceId,
        ticket: pendingTicket,
        timestamp: this.now(),
      };
      pendingTicket = null;
      relay.send(JSON.stringify(hello), (error) => {
        if (error) {
          void this.closeActive(
            session,
            "REMOTE_RELAY_HELLO_FAILED",
            "Remote relay hello could not be delivered",
          );
        }
      });
    });
    relay.on("message", (data, isBinary) => {
      if (session.closed || this.active !== session) return;
      const content = messageBuffer(data);
      if (isBinary) this.handleRelayBinary(session, content);
      else this.handleRelayText(session, content);
    });
    relay.on("error", () => {
      void this.closeActive(
        session,
        "REMOTE_RELAY_UNAVAILABLE",
        "Remote relay connection failed",
      );
    });
    relay.on("close", () => {
      pendingTicket = null;
      if (!session.closed) {
        void this.closeActive(
          session,
          "REMOTE_RELAY_CLOSED",
          "Remote relay connection closed",
        );
      }
    });
  }

  /**
   * Accept a fresh, allowlisted MQTT invitation and start one outbound lease.
   *
   * @param value Untrusted parsed MQTT command.
   * @returns Completion after acceptance or a best-effort rejection event.
   */
  async handleOpenCommand(value: unknown): Promise<void> {
    let command: RemoteSessionOpenCommand;
    try {
      command = parseRemoteSessionOpenCommand(value);
    } catch {
      return;
    }
    this.pruneConsumedSessions();
    if (this.consumedSessions.has(command.sessionId)) return;
    if (command.deviceId !== this.options.deviceId) {
      await this.event(
        command.sessionId,
        "REJECTED",
        "REMOTE_DEVICE_MISMATCH",
        "Remote-control invitation targets another device",
      ).catch(() => undefined);
      return;
    }
    const now = this.now();
    if (
      command.expiresAt <= now ||
      command.issuedAt > now + REMOTE_INVITATION_MAX_AGE_MS ||
      now - command.issuedAt > REMOTE_INVITATION_MAX_AGE_MS
    ) {
      await this.event(
        command.sessionId,
        "REJECTED",
        "REMOTE_INVITATION_EXPIRED",
        "Remote-control invitation is expired or stale",
      ).catch(() => undefined);
      return;
    }
    if (!this.allowedRelayOrigins.has(new URL(command.relayWsUrl).origin)) {
      await this.event(
        command.sessionId,
        "REJECTED",
        "REMOTE_RELAY_ORIGIN_NOT_ALLOWED",
        "Remote relay origin is not allowlisted",
      ).catch(() => undefined);
      return;
    }
    if (this.options.isDeploymentBlocked()) {
      await this.event(
        command.sessionId,
        "REJECTED",
        "DEPLOYMENT_DRAINING",
        "Device deployment is draining",
      ).catch(() => undefined);
      return;
    }
    if (this.options.isDeviceControlBusy?.()) {
      await this.event(
        command.sessionId,
        "REJECTED",
        "DEVICE_CONTROL_BUSY",
        "Another device-control workflow is active",
      ).catch(() => undefined);
      return;
    }
    if (this.active) {
      await this.event(
        command.sessionId,
        "REJECTED",
        "REMOTE_SESSION_BUSY",
        "Another remote-control lease is active",
      ).catch(() => undefined);
      return;
    }
    this.consumedSessions.set(command.sessionId, command.expiresAt);
    const { deviceTicket, ...safeCommand } = command;
    const session: ActiveRemoteSession = {
      command: safeCommand,
      relaySocket: null,
      localSocket: null,
      sidecar: null,
      protocolVersion: null,
      selectedTransport: null,
      paired: false,
      bridged: false,
      recovering: false,
      awaitingRecovery: false,
      connectedReported: false,
      closed: false,
      attemptId: null,
      incomingP2PSequence: 0,
      outgoingP2PSequence: 0,
      p2pReady: false,
      p2pReadyReported: false,
      p2pFailureReported: false,
      pendingLocalCandidates: [],
      answerSent: false,
      pendingControls: [],
      pendingControlBytes: 0,
      pendingDeviceFrames: [],
      pendingDeviceBytes: 0,
      disconnectedTimer: null,
      expiryTimer: null,
    };
    session.expiryTimer = setTimeout(
      () =>
        void this.closeActive(
          session,
          "REMOTE_SESSION_EXPIRED",
          "Remote-control lease expired",
        ),
      Math.max(1, command.expiresAt - now),
    );
    session.expiryTimer.unref();
    this.active = session;
    void this.event(
      command.sessionId,
      "CONNECTING",
      "REMOTE_RELAY_CONNECTING",
      "Device is connecting to the remote relay",
    ).catch(() => undefined);
    this.connectRelay(session, deviceTicket);
  }
}
