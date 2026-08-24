import WebSocket, { type RawData } from "ws";

import { DeviceOpsExecutor } from "./ops-executor.js";
import {
  DeviceOpsFailure,
  OPS_MAX_FRAME_BYTES,
  OPS_PROTOCOL_VERSION,
  encodeDeviceOpsArtifactFrame,
  isDeviceOpsArtifact,
  parseDeviceOpsOpenSessionCommand,
  parseDeviceOpsRequest,
  type DeviceOpsOpenSessionCommand,
  type DeviceOpsRequest,
  type DeviceOpsResponse,
} from "./ops-protocol.js";

/** Refuse a screenshot when prior WSS output is already queued. */
const OPS_SCREENSHOT_MAX_BUFFERED_BYTES = 1024 * 1024;

/** Status event emitted over the non-secret MQTT management channel. */
export interface DeviceOpsSessionEvent {
  protocolVersion: 1;
  sessionId: string;
  deviceId: string;
  status: "CONNECTING" | "CONNECTED" | "CLOSED" | "REJECTED";
  code: string;
  message: string;
  timestamp: number;
}

/** Device WSS session manager dependencies. */
export interface DeviceOpsSessionManagerOptions {
  deviceId: string;
  reportToken: string;
  allowedWsOrigins: string[];
  executor: DeviceOpsExecutor;
  isDeploymentBlocked: () => boolean;
  publishEvent: (event: DeviceOpsSessionEvent) => Promise<void>;
  now?: () => number;
}

/** Active short-lived operations session. */
interface ActiveSession {
  command: DeviceOpsOpenSessionCommand;
  socket: WebSocket | null;
  closed: boolean;
  connectedAt: number | null;
  lastActivityAt: number;
  readInFlight: number;
  writeInFlight: number;
  screenshotInFlight: boolean;
  responses: Map<string, DeviceOpsResponse>;
  idleTimer: NodeJS.Timeout | null;
  expiryTimer: NodeJS.Timeout | null;
}

/** Convert a WebSocket frame to UTF-8 text without accepting binary operations. */
function frameText(data: RawData, isBinary: boolean): string {
  if (isBinary) throw new Error("Binary ops frames are not supported");
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/** Return true for operations that mutate device state. */
function mutating(request: DeviceOpsRequest): boolean {
  return (
    request.operation.startsWith("device.audio.") &&
    request.operation !== "device.audio.get"
  );
}

/** Manage at most one temporary WSS operations session for a device. */
export class DeviceOpsSessionManager {
  private readonly now: () => number;
  private active: ActiveSession | null = null;

  /** Create a device operations session manager. */
  constructor(private readonly options: DeviceOpsSessionManagerOptions) {
    this.now = options.now || Date.now;
  }

  /** Return whether an operations session is currently active. */
  isActive(): boolean {
    return Boolean(this.active && !this.active.closed);
  }

  /** Publish a session event without leaking credentials or operation data. */
  private event(
    command: DeviceOpsOpenSessionCommand,
    status: DeviceOpsSessionEvent["status"],
    code: string,
    message: string,
  ): Promise<void> {
    return this.options.publishEvent({
      protocolVersion: OPS_PROTOCOL_VERSION,
      sessionId: command.sessionId,
      deviceId: this.options.deviceId,
      status,
      code,
      message,
      timestamp: this.now(),
    });
  }

  /** Close the active session and report a stable reason. */
  async close(code: string, message: string): Promise<void> {
    const session = this.active;
    if (!session || session.closed) return;
    session.closed = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    if (session.socket?.readyState === WebSocket.OPEN) {
      session.socket.send(
        JSON.stringify({
          protocolVersion: OPS_PROTOCOL_VERSION,
          type: "close",
          sessionId: session.command.sessionId,
          code,
          message,
          timestamp: this.now(),
        }),
      );
      session.socket.close(1000, code.slice(0, 100));
    } else {
      session.socket?.terminate();
    }
    await this.event(session.command, "CLOSED", code, message).catch(
      () => undefined,
    );
    if (this.active === session) this.active = null;
  }

  /** Reset the two-minute device-side idle timer. */
  private resetIdle(session: ActiveSession): void {
    session.lastActivityAt = this.now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (this.active === session) {
        void this.close(
          "OPS_IDLE_TIMEOUT",
          "Operations session was idle for two minutes",
        );
      }
    }, 120_000);
  }

  /** Send a structured response when the socket remains active. */
  private send(session: ActiveSession, response: DeviceOpsResponse): void {
    if (session.socket?.readyState !== WebSocket.OPEN || session.closed) return;
    const payload = JSON.stringify(response);
    if (Buffer.byteLength(payload, "utf8") > OPS_MAX_FRAME_BYTES) {
      const reduced: DeviceOpsResponse = {
        ...response,
        status: "FAILURE",
        code: "OPS_RESPONSE_TOO_LARGE",
        message: "Operation result exceeded the 64 KiB frame limit",
        data: {},
      };
      session.socket.send(JSON.stringify(reduced));
      return;
    }
    session.socket.send(payload);
  }

  /** Send one ephemeral screenshot before its terminal JSON response. */
  private async executeAndTransfer(
    session: ActiveSession,
    request: DeviceOpsRequest,
  ): Promise<unknown> {
    const socket = session.socket;
    if (
      request.operation === "device.screen.capture" &&
      (socket?.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > OPS_SCREENSHOT_MAX_BUFFERED_BYTES)
    ) {
      throw new DeviceOpsFailure(
        "SCREENSHOT_TRANSFER_BUSY",
        "Operations channel is busy",
      );
    }
    const data = await this.options.executor.execute(
      request.operation,
      request.params,
    );
    if (!isDeviceOpsArtifact(data)) return data;
    if (
      request.operation !== "device.screen.capture" ||
      session.closed ||
      this.active !== session ||
      request.expiresAt <= this.now()
    ) {
      throw new DeviceOpsFailure(
        "SCREENSHOT_TRANSFER_FAILED",
        "Screenshot transfer could not be completed",
      );
    }
    if (
      socket?.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > OPS_SCREENSHOT_MAX_BUFFERED_BYTES
    ) {
      throw new DeviceOpsFailure(
        "SCREENSHOT_TRANSFER_BUSY",
        "Operations channel is busy",
      );
    }
    const frame = encodeDeviceOpsArtifactFrame(request, data);
    await new Promise<void>((resolve, reject) => {
      socket.send(frame, { binary: true }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }).catch(() => {
      throw new DeviceOpsFailure(
        "SCREENSHOT_TRANSFER_FAILED",
        "Screenshot transfer failed",
      );
    });
    return {
      artifactId: data.artifactId,
      mimeType: data.mimeType,
      sizeBytes: data.sizeBytes,
      sha256: data.sha256,
      width: data.width,
      height: data.height,
      capturedAt: data.capturedAt,
    };
  }

  /** Execute one validated request with timeout, concurrency and idempotency. */
  private async handleRequest(
    session: ActiveSession,
    raw: unknown,
  ): Promise<void> {
    let request: DeviceOpsRequest;
    try {
      request = parseDeviceOpsRequest(raw, session.command.sessionId);
    } catch {
      session.socket?.close(1008, "OPS_REQUEST_INVALID");
      return;
    }
    this.resetIdle(session);
    const duplicate = session.responses.get(request.requestId);
    if (duplicate) {
      this.send(session, duplicate);
      return;
    }
    const startedAt = this.now();
    const isWrite = mutating(request);
    let response: DeviceOpsResponse;
    if (request.expiresAt <= startedAt) {
      response = this.response(
        request,
        startedAt,
        "TIMEOUT",
        "OPS_REQUEST_EXPIRED",
        "Operation request expired",
        {},
      );
    } else if (this.options.isDeploymentBlocked()) {
      response = this.response(
        request,
        startedAt,
        "REJECTED",
        "DEPLOYMENT_DRAINING",
        "Device deployment is draining",
        {},
      );
    } else if (
      (request.operation === "device.screen.capture" &&
        session.screenshotInFlight) ||
      (isWrite && session.writeInFlight >= 1) ||
      (!isWrite && session.readInFlight >= 4)
    ) {
      response = this.response(
        request,
        startedAt,
        "REJECTED",
        "OPS_CONCURRENCY_LIMIT",
        "Operations concurrency limit reached",
        {},
      );
    } else {
      if (isWrite) session.writeInFlight += 1;
      else session.readInFlight += 1;
      if (request.operation === "device.screen.capture") {
        session.screenshotInFlight = true;
      }
      try {
        const timeoutMs = Math.max(
          1,
          Math.min(15_000, request.expiresAt - this.now()),
        );
        let timeout: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new DeviceOpsFailure(
                  "OPS_OPERATION_TIMEOUT",
                  "Operation timed out",
                  "TIMEOUT",
                ),
              ),
            timeoutMs,
          );
        });
        const data = await Promise.race([
          this.executeAndTransfer(session, request),
          timeoutPromise,
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
        response = this.response(
          request,
          startedAt,
          "SUCCESS",
          "OPS_OPERATION_SUCCEEDED",
          "Operation completed",
          data,
        );
      } catch (error) {
        const failure =
          error instanceof DeviceOpsFailure
            ? error
            : new DeviceOpsFailure(
                "OPS_OPERATION_FAILED",
                error instanceof Error ? error.message : String(error),
              );
        response = this.response(
          request,
          startedAt,
          failure.status,
          failure.code,
          failure.message,
          {},
        );
      } finally {
        if (isWrite) session.writeInFlight -= 1;
        else session.readInFlight -= 1;
        if (request.operation === "device.screen.capture") {
          session.screenshotInFlight = false;
        }
      }
    }
    session.responses.set(request.requestId, response);
    if (session.responses.size > 200) {
      const oldest = session.responses.keys().next().value as
        | string
        | undefined;
      if (oldest) session.responses.delete(oldest);
    }
    this.send(session, response);
  }

  /** Build one operation result envelope. */
  private response(
    request: DeviceOpsRequest,
    startedAt: number,
    status: DeviceOpsResponse["status"],
    code: string,
    message: string,
    data: unknown,
  ): DeviceOpsResponse {
    const finishedAt = this.now();
    return {
      protocolVersion: OPS_PROTOCOL_VERSION,
      type: "response",
      sessionId: request.sessionId,
      requestId: request.requestId,
      operation: request.operation,
      status,
      code,
      message,
      data,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
    };
  }

  /** Establish the device-initiated WSS connection. */
  private connect(session: ActiveSession): void {
    if (session.closed || session.command.expiresAt <= this.now()) return;
    const socket = new WebSocket(session.command.wsUrl, ["autojs6-ops-v1"], {
      headers: { Authorization: `Device ${this.options.reportToken}` },
      maxPayload: OPS_MAX_FRAME_BYTES,
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
    });
    session.socket = socket;
    socket.on("open", () => {
      if (session.closed) return socket.close();
      session.connectedAt = this.now();
      this.resetIdle(session);
      socket.send(
        JSON.stringify({
          protocolVersion: OPS_PROTOCOL_VERSION,
          type: "hello",
          role: "device",
          sessionId: session.command.sessionId,
          deviceId: this.options.deviceId,
          nonce: session.command.nonce,
          capabilities: this.options.executor.getCapabilities(),
          timestamp: this.now(),
        }),
      );
      void this.event(
        session.command,
        "CONNECTED",
        "OPS_WSS_CONNECTED",
        "Device connected to operations session",
      );
    });
    socket.on("message", (data, isBinary) => {
      try {
        const text = frameText(data, isBinary);
        if (Buffer.byteLength(text, "utf8") > OPS_MAX_FRAME_BYTES) {
          socket.close(1009, "OPS_FRAME_TOO_LARGE");
          return;
        }
        const value: unknown = JSON.parse(text);
        void this.handleRequest(session, value);
      } catch {
        socket.close(1008, "OPS_FRAME_INVALID");
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (session.closed || this.active !== session) return;
      const reconnectDeadline = Math.min(
        session.command.expiresAt,
        (session.connectedAt || this.now()) + 30_000,
      );
      if (this.now() + 1_000 < reconnectDeadline) {
        setTimeout(() => this.connect(session), 1_000);
      } else {
        void this.close(
          "OPS_WSS_DISCONNECTED",
          "Operations WSS connection ended",
        );
      }
    });
  }

  /** Accept an unknown MQTT open-session command. */
  async handleOpenCommand(value: unknown): Promise<void> {
    let command: DeviceOpsOpenSessionCommand;
    try {
      command = parseDeviceOpsOpenSessionCommand(value);
    } catch {
      return;
    }
    if (command.deviceId !== this.options.deviceId) {
      await this.event(
        command,
        "REJECTED",
        "DEVICE_MISMATCH",
        "Operations session targets another device",
      );
      return;
    }
    if (command.expiresAt <= this.now()) {
      await this.event(
        command,
        "REJECTED",
        "OPS_SESSION_EXPIRED",
        "Operations session expired before processing",
      );
      return;
    }
    if (this.options.isDeploymentBlocked()) {
      await this.event(
        command,
        "REJECTED",
        "DEPLOYMENT_DRAINING",
        "Device deployment is draining",
      );
      return;
    }
    const origin = new URL(command.wsUrl).origin;
    if (!this.options.allowedWsOrigins.includes(origin)) {
      await this.event(
        command,
        "REJECTED",
        "OPS_ORIGIN_NOT_ALLOWED",
        "Operations WSS origin is not allowlisted",
      );
      return;
    }
    if (this.active && !this.active.closed) {
      if (this.active.command.sessionId === command.sessionId) return;
      await this.event(
        command,
        "REJECTED",
        "OPS_SESSION_BUSY",
        "Another operations session is active",
      );
      return;
    }
    const session: ActiveSession = {
      command,
      socket: null,
      closed: false,
      connectedAt: null,
      lastActivityAt: this.now(),
      readInFlight: 0,
      writeInFlight: 0,
      screenshotInFlight: false,
      responses: new Map(),
      idleTimer: null,
      expiryTimer: null,
    };
    session.expiryTimer = setTimeout(
      () =>
        void this.close("OPS_SESSION_EXPIRED", "Operations session expired"),
      Math.max(1, command.expiresAt - this.now()),
    );
    this.active = session;
    await this.event(
      command,
      "CONNECTING",
      "OPS_WSS_CONNECTING",
      "Device is connecting to operations session",
    );
    this.connect(session);
  }
}
