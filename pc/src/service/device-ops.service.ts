import { randomBytes, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";

import {
  DEVICE_OPS_MAX_FRAME_BYTES,
  DEVICE_OPS_PROTOCOL_VERSION,
  isDeviceOpsRecord,
  normalizeDeviceOpsWsUrl,
  parseDeviceOpsArtifactFrame,
  parseDeviceOpsClose,
  parseDeviceOpsHello,
  parseDeviceOpsResponse,
  safeDeviceOpsSecretEqual,
  type DeviceOpsArtifact,
  type DeviceOpsCreateInput,
  type DeviceOpsHello,
  type DeviceOpsOpenSessionCommand,
  type DeviceOpsOperation,
  type DeviceOpsRequest,
  type DeviceOpsTerminalStatus,
} from "../device-ops-protocol.js";
import { MqttService } from "./mqtt.service.js";

const DEVICE_OPS_SESSION_TTL_MS = 10 * 60 * 1000;
const DEVICE_OPS_CONNECT_TIMEOUT_MS = 15_000;
const DEVICE_OPS_TASK_RETENTION_MS = 10 * 60 * 1000;
const DEVICE_OPS_MAX_TASKS = 200;
const DEVICE_OPS_MAX_SESSION_TASKS = 20;
const DEVICE_OPS_MAX_UNBOUND_SOCKETS = 32;
const DEVICE_OPS_MAX_STORED_ARTIFACT_BYTES = 32 * 1024 * 1024;

/** Status exposed by the temporary PC operations task API. */
export type DeviceOpsTaskStatus = "EXECUTING" | DeviceOpsTerminalStatus;

/** Public task representation returned through the PC response envelope. */
export interface DeviceOpsTaskView {
  taskId: string;
  sessionId: string;
  clientId: string;
  operation: DeviceOpsOperation;
  status: DeviceOpsTaskStatus;
  code: string | null;
  message: string | null;
  data: unknown;
  artifact: (DeviceOpsArtifact["header"] & { contentBase64: string }) | null;
  createTimeUtc: number;
  expiresAtUtc: number;
  startedAtUtc: number | null;
  finishedAtUtc: number | null;
}

/** Injectable dependencies for the PC operations gateway. */
export interface DeviceOpsServiceOptions {
  publishOpenSession?: (
    deviceId: string,
    command: DeviceOpsOpenSessionCommand,
  ) => Promise<void>;
  wsUrl?: string | null;
  now?: () => number;
  createId?: () => string;
  createNonce?: () => string;
}

/** Stable gateway error with an HTTP status for controller mapping. */
export class DeviceOpsGatewayError extends Error {
  /**
   * Create a gateway error.
   *
   * @param httpStatus HTTP status that represents this gateway failure.
   * @param message Safe public failure message.
   */
  constructor(
    readonly httpStatus: 409 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Internal task state retained only for bounded polling. */
interface StoredDeviceOpsTask {
  taskId: string;
  sessionId: string;
  clientId: string;
  operation: DeviceOpsOperation;
  params: Record<string, unknown>;
  timeoutMs: number;
  status: DeviceOpsTaskStatus;
  code: string | null;
  message: string | null;
  data: unknown;
  artifact: DeviceOpsArtifact | null;
  createTimeUtc: number;
  expiresAtUtc: number;
  startedAtUtc: number | null;
  finishedAtUtc: number | null;
  request: DeviceOpsRequest | null;
  sentOn: WebSocket | null;
  timeout: NodeJS.Timeout | null;
}

/** One reusable, device-initiated operations WSS session. */
interface StoredDeviceOpsSession {
  command: DeviceOpsOpenSessionCommand;
  socket: WebSocket | null;
  hello: DeviceOpsHello | null;
  taskIds: Set<string>;
  expiryTimer: NodeJS.Timeout;
}

/**
 * Convert one incoming WebSocket text frame to a bounded UTF-8 string.
 *
 * @param data Raw ws frame payload.
 * @param isBinary Whether ws marked this frame as binary.
 * @returns The bounded UTF-8 JSON text.
 */
function readTextFrame(data: RawData, isBinary: boolean): string {
  if (isBinary) throw new Error("Expected a JSON text frame");
  const text =
    typeof data === "string"
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data).toString("utf8");
  if (Buffer.byteLength(text, "utf8") > DEVICE_OPS_MAX_FRAME_BYTES) {
    throw new Error("Device operations JSON frame exceeded 64 KiB");
  }
  return text;
}

/**
 * Return whether a task is in a terminal state.
 *
 * @param status Current task status.
 * @returns Whether no further device result may mutate the task.
 */
function isTerminalStatus(status: DeviceOpsTaskStatus): boolean {
  return status !== "EXECUTING";
}

/** Manage asynchronous HTTP tasks over reusable device-initiated WSS sessions. */
export class DeviceOpsService {
  private static instance: DeviceOpsService | undefined;
  private readonly sessionsByDevice = new Map<
    string,
    StoredDeviceOpsSession
  >();
  private readonly sessionsById = new Map<string, StoredDeviceOpsSession>();
  private readonly tasks = new Map<string, StoredDeviceOpsTask>();
  private readonly unboundSockets = new Set<WebSocket>();
  private readonly publishOpenSession: (
    deviceId: string,
    command: DeviceOpsOpenSessionCommand,
  ) => Promise<void>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createNonce: () => string;
  private storedArtifactBytes = 0;

  /**
   * Create a temporary operations gateway.
   *
   * @param options Optional test and transport dependencies.
   */
  constructor(private readonly options: DeviceOpsServiceOptions = {}) {
    this.publishOpenSession =
      options.publishOpenSession ||
      ((deviceId, command) =>
        MqttService.getInstance().publishOpsOpenSession(deviceId, command));
    this.now = options.now || Date.now;
    this.createId = options.createId || randomUUID;
    this.createNonce =
      options.createNonce || (() => randomBytes(32).toString("base64url"));
  }

  /**
   * Return the process-wide PC operations gateway.
   *
   * @returns The singleton device operations service.
   */
  static getInstance(): DeviceOpsService {
    if (!this.instance) this.instance = new DeviceOpsService();
    return this.instance;
  }

  /**
   * Resolve and validate the phone-reachable WSS URL.
   *
   * @returns The normalized WSS URL configured for MQTT OPEN_SESSION.
   * @throws DeviceOpsGatewayError when the optional gateway is disabled.
   */
  private getWsUrl(): string {
    const configured =
      this.options.wsUrl === undefined
        ? process.env.DEVICE_OPS_WS_URL
        : this.options.wsUrl;
    if (!configured) {
      throw new DeviceOpsGatewayError(
        503,
        "Device operations gateway is disabled on this PC server",
      );
    }
    try {
      return normalizeDeviceOpsWsUrl(configured);
    } catch {
      throw new DeviceOpsGatewayError(
        503,
        "Device operations gateway configuration is invalid",
      );
    }
  }

  /**
   * Remove expired terminal task records and enforce the task count bound.
   *
   * @returns Nothing.
   */
  private cleanupTasks(): void {
    const cutoff = this.now() - DEVICE_OPS_TASK_RETENTION_MS;
    for (const [taskId, task] of this.tasks) {
      if (
        task.finishedAtUtc !== null &&
        task.finishedAtUtc < cutoff
      ) {
        if (task.artifact) {
          this.storedArtifactBytes -= task.artifact.content.byteLength;
        }
        this.tasks.delete(taskId);
      }
    }
    if (this.tasks.size < DEVICE_OPS_MAX_TASKS) return;
    const terminal = [...this.tasks.values()]
      .filter((task) => task.finishedAtUtc !== null)
      .sort(
        (left, right) =>
          (left.finishedAtUtc || 0) - (right.finishedAtUtc || 0),
      );
    while (this.tasks.size >= DEVICE_OPS_MAX_TASKS && terminal.length > 0) {
      const task = terminal.shift();
      if (!task) break;
      if (task.artifact) {
        this.storedArtifactBytes -= task.artifact.content.byteLength;
      }
      this.tasks.delete(task.taskId);
    }
  }

  /**
   * Build a new ten-minute session command for one device.
   *
   * @param clientId Target device identifier.
   * @returns The indexed in-memory session.
   */
  private createSession(clientId: string): StoredDeviceOpsSession {
    const now = this.now();
    const command: DeviceOpsOpenSessionCommand = {
      protocolVersion: DEVICE_OPS_PROTOCOL_VERSION,
      type: "OPEN_SESSION",
      sessionId: this.createId(),
      deviceId: clientId,
      wsUrl: this.getWsUrl(),
      nonce: this.createNonce(),
      issuedAt: now,
      expiresAt: now + DEVICE_OPS_SESSION_TTL_MS,
    };
    const session = {} as StoredDeviceOpsSession;
    session.command = command;
    session.socket = null;
    session.hello = null;
    session.taskIds = new Set();
    session.expiryTimer = setTimeout(
      () => this.expireSession(session, "OPS_SESSION_EXPIRED"),
      DEVICE_OPS_SESSION_TTL_MS,
    );
    session.expiryTimer.unref();
    this.sessionsByDevice.set(clientId, session);
    this.sessionsById.set(command.sessionId, session);
    return session;
  }

  /**
   * Return the active session for a device or create one safely.
   *
   * @param clientId Target device identifier.
   * @param timeoutMs Requested operation execution timeout.
   * @returns The sole active session for the device.
   */
  private sessionFor(
    clientId: string,
    timeoutMs: number,
  ): StoredDeviceOpsSession {
    const existing = this.sessionsByDevice.get(clientId);
    if (existing && existing.command.expiresAt <= this.now()) {
      this.expireSession(existing, "OPS_SESSION_EXPIRED");
    }
    const active = this.sessionsByDevice.get(clientId);
    if (active) {
      if (
        active.command.expiresAt - this.now() <=
        DEVICE_OPS_CONNECT_TIMEOUT_MS + timeoutMs
      ) {
        throw new DeviceOpsGatewayError(
          409,
          "The current device operations session is about to expire; retry shortly",
        );
      }
      if (active.taskIds.size >= DEVICE_OPS_MAX_SESSION_TASKS) {
        throw new DeviceOpsGatewayError(
          409,
          "The device operations session has too many active requests",
        );
      }
      return active;
    }
    return this.createSession(clientId);
  }

  /**
   * Expire a session and all requests still awaiting a terminal result.
   *
   * @param session Session to remove from both indexes.
   * @param code Stable reason used for tasks and the WebSocket close frame.
   * @returns Nothing.
   */
  private expireSession(
    session: StoredDeviceOpsSession,
    code: string,
  ): void {
    if (this.sessionsById.get(session.command.sessionId) !== session) return;
    clearTimeout(session.expiryTimer);
    this.sessionsById.delete(session.command.sessionId);
    if (this.sessionsByDevice.get(session.command.deviceId) === session) {
      this.sessionsByDevice.delete(session.command.deviceId);
    }
    for (const taskId of session.taskIds) {
      const task = this.tasks.get(taskId);
      if (task && !isTerminalStatus(task.status)) {
        this.finishTask(
          task,
          "TIMEOUT",
          code,
          "Device operations session ended before a terminal result",
          {},
        );
      }
    }
    session.taskIds.clear();
    if (session.socket?.readyState === WebSocket.OPEN) {
      session.socket.close(1000, code.slice(0, 100));
    } else {
      session.socket?.terminate();
    }
    session.socket = null;
  }

  /**
   * Mark an operation task terminal and release its timeout.
   *
   * @param task Task to finish once.
   * @param status Terminal protocol status.
   * @param code Stable machine-readable outcome code.
   * @param message Safe human-readable outcome message.
   * @param data Bounded structured result data.
   * @returns Nothing.
   */
  private finishTask(
    task: StoredDeviceOpsTask,
    status: DeviceOpsTerminalStatus,
    code: string,
    message: string,
    data: unknown,
  ): void {
    if (isTerminalStatus(task.status)) return;
    if (task.timeout) clearTimeout(task.timeout);
    task.timeout = null;
    task.status = status;
    task.code = code;
    task.message = message;
    task.data = data;
    task.finishedAtUtc = this.now();
    this.sessionsById.get(task.sessionId)?.taskIds.delete(task.taskId);
  }

  /**
   * Arm or replace a task timeout at an absolute deadline.
   *
   * @param task Pending task whose timer is replaced.
   * @param expiresAtUtc Absolute epoch-millisecond deadline.
   * @returns Nothing.
   */
  private armTaskTimeout(
    task: StoredDeviceOpsTask,
    expiresAtUtc: number,
  ): void {
    if (task.timeout) clearTimeout(task.timeout);
    task.expiresAtUtc = expiresAtUtc;
    task.timeout = setTimeout(
      () =>
        this.finishTask(
          task,
          "TIMEOUT",
          "OPS_TASK_TIMEOUT",
          "Device operation timed out",
          {},
        ),
      Math.max(1, expiresAtUtc - this.now()),
    );
    task.timeout.unref();
  }

  /**
   * Return the operation names advertised by a device hello.
   *
   * @param session Bound device session.
   * @returns Valid string operation names from the capability payload.
   */
  private advertisedOperations(session: StoredDeviceOpsSession): string[] {
    const operations = session.hello?.capabilities.operations;
    return Array.isArray(operations)
      ? operations.filter((value): value is string => typeof value === "string")
      : [];
  }

  /**
   * Send one pending request on the current device socket.
   *
   * @param session Bound device session.
   * @param task Pending operation task.
   * @returns Nothing.
   */
  private sendTask(
    session: StoredDeviceOpsSession,
    task: StoredDeviceOpsTask,
  ): void {
    const socket = session.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !session.hello ||
      isTerminalStatus(task.status) ||
      task.sentOn === socket
    ) {
      return;
    }
    if (!this.advertisedOperations(session).includes(task.operation)) {
      this.finishTask(
        task,
        "REJECTED",
        "OPERATION_NOT_SUPPORTED",
        "The connected device did not advertise this operation",
        {},
      );
      return;
    }
    if (!task.request) {
      const createdAt = this.now();
      const expiresAt = Math.min(
        createdAt + task.timeoutMs,
        session.command.expiresAt,
      );
      task.request = {
        protocolVersion: DEVICE_OPS_PROTOCOL_VERSION,
        type: "request",
        sessionId: session.command.sessionId,
        requestId: task.taskId,
        operation: task.operation,
        params: task.params,
        createdAt,
        expiresAt,
      };
      task.startedAtUtc = createdAt;
      this.armTaskTimeout(task, expiresAt);
    }
    const payload = JSON.stringify(task.request);
    if (Buffer.byteLength(payload, "utf8") > DEVICE_OPS_MAX_FRAME_BYTES) {
      this.finishTask(
        task,
        "REJECTED",
        "OPS_REQUEST_TOO_LARGE",
        "Device operation request exceeded the frame limit",
        {},
      );
      return;
    }
    task.sentOn = socket;
    socket.send(payload, (error) => {
      if (error && !isTerminalStatus(task.status)) {
        this.finishTask(
          task,
          "FAILURE",
          "OPS_REQUEST_SEND_FAILED",
          "The device request could not be delivered",
          {},
        );
      }
    });
  }

  /**
   * Send every pending operation associated with a connected session.
   *
   * @param session Newly bound device session.
   * @returns Nothing.
   */
  private flushSession(session: StoredDeviceOpsSession): void {
    for (const taskId of session.taskIds) {
      const task = this.tasks.get(taskId);
      if (task) this.sendTask(session, task);
    }
  }

  /**
   * Evict old terminal screenshots until another bounded artifact fits.
   *
   * @param sizeBytes Incoming artifact byte length.
   * @returns Whether enough bounded memory is available.
   */
  private makeArtifactRoom(sizeBytes: number): boolean {
    if (sizeBytes > DEVICE_OPS_MAX_STORED_ARTIFACT_BYTES) return false;
    if (
      this.storedArtifactBytes + sizeBytes <=
      DEVICE_OPS_MAX_STORED_ARTIFACT_BYTES
    ) {
      return true;
    }
    const candidates = [...this.tasks.values()]
      .filter((task) => task.artifact && task.finishedAtUtc !== null)
      .sort(
        (left, right) =>
          (left.finishedAtUtc || 0) - (right.finishedAtUtc || 0),
      );
    for (const task of candidates) {
      if (!task.artifact) continue;
      this.storedArtifactBytes -= task.artifact.content.byteLength;
      task.artifact = null;
      if (
        this.storedArtifactBytes + sizeBytes <=
        DEVICE_OPS_MAX_STORED_ARTIFACT_BYTES
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Correlate and retain one device screenshot artifact.
   *
   * @param session Authenticated session that delivered the binary frame.
   * @param frame Binary artifact frame.
   * @returns Nothing.
   */
  private handleArtifact(
    session: StoredDeviceOpsSession,
    frame: Buffer,
  ): void {
    const artifact = parseDeviceOpsArtifactFrame(frame);
    const task = this.tasks.get(artifact.header.requestId);
    if (
      artifact.header.sessionId !== session.command.sessionId ||
      !task ||
      task.sessionId !== session.command.sessionId ||
      task.clientId !== session.command.deviceId ||
      task.operation !== "device.screen.capture"
    ) {
      throw new Error("Device operations artifact correlation failed");
    }
    if (isTerminalStatus(task.status)) return;
    if (task.artifact) {
      if (
        task.artifact.header.artifactId === artifact.header.artifactId &&
        task.artifact.header.sha256 === artifact.header.sha256
      ) {
        return;
      }
      throw new Error("A second screenshot artifact was rejected");
    }
    if (!this.makeArtifactRoom(artifact.content.byteLength)) {
      this.finishTask(
        task,
        "FAILURE",
        "OPS_ARTIFACT_CAPACITY_EXCEEDED",
        "The temporary PC screenshot capacity is full",
        {},
      );
      return;
    }
    task.artifact = artifact;
    this.storedArtifactBytes += artifact.content.byteLength;
  }

  /**
   * Correlate a terminal device response with its exact pending request.
   *
   * @param session Authenticated session that delivered the JSON frame.
   * @param value Parsed but untrusted response JSON.
   * @returns Nothing.
   */
  private handleResponse(
    session: StoredDeviceOpsSession,
    value: unknown,
  ): void {
    const response = parseDeviceOpsResponse(value);
    const task = this.tasks.get(response.requestId);
    if (
      response.sessionId !== session.command.sessionId ||
      !task ||
      task.sessionId !== session.command.sessionId ||
      task.clientId !== session.command.deviceId ||
      task.operation !== response.operation
    ) {
      throw new Error("Device operations response correlation failed");
    }
    if (isTerminalStatus(task.status)) return;
    if (
      task.operation === "device.screen.capture" &&
      response.status === "SUCCESS" &&
      !task.artifact
    ) {
      this.finishTask(
        task,
        "FAILURE",
        "OPS_ARTIFACT_MISSING",
        "The device reported screenshot success without an artifact",
        {},
      );
      return;
    }
    if (
      task.operation === "device.screen.capture" &&
      response.status === "SUCCESS" &&
      task.artifact
    ) {
      const metadata = response.data;
      const header = task.artifact.header;
      if (
        !isDeviceOpsRecord(metadata) ||
        metadata.artifactId !== header.artifactId ||
        metadata.mimeType !== header.mimeType ||
        metadata.sizeBytes !== header.sizeBytes ||
        metadata.sha256 !== header.sha256 ||
        metadata.width !== header.width ||
        metadata.height !== header.height ||
        metadata.capturedAt !== header.capturedAt
      ) {
        this.finishTask(
          task,
          "FAILURE",
          "OPS_ARTIFACT_METADATA_MISMATCH",
          "The screenshot response did not match its binary artifact",
          {},
        );
        return;
      }
    }
    this.finishTask(
      task,
      response.status,
      response.code,
      response.message,
      response.data,
    );
  }

  /**
   * Bind a validated hello to its exact session, device, and nonce.
   *
   * @param socket Newly authenticated transport socket.
   * @param value Parsed but untrusted hello JSON.
   * @returns The exactly correlated active session.
   */
  private bindHello(socket: WebSocket, value: unknown): StoredDeviceOpsSession {
    const hello = parseDeviceOpsHello(value);
    const session = this.sessionsById.get(hello.sessionId);
    const now = this.now();
    if (
      !session ||
      this.sessionsByDevice.get(hello.deviceId) !== session ||
      session.command.deviceId !== hello.deviceId ||
      session.command.expiresAt <= now ||
      hello.timestamp < session.command.issuedAt - 60_000 ||
      hello.timestamp > session.command.expiresAt + 60_000 ||
      !safeDeviceOpsSecretEqual(hello.nonce, session.command.nonce)
    ) {
      throw new Error("Device operations hello correlation failed");
    }
    if (
      session.socket &&
      session.socket !== socket &&
      session.socket.readyState === WebSocket.OPEN
    ) {
      throw new Error("A device operations session is already connected");
    }
    session.socket = socket;
    session.hello = hello;
    this.flushSession(session);
    return session;
  }

  /**
   * Create an asynchronous device operation and publish its OPEN_SESSION command.
   *
   * @param input Validated allowlisted operation input.
   * @returns The immediately pollable EXECUTING task view after MQTT PUBACK.
   */
  async createOperation(input: DeviceOpsCreateInput): Promise<DeviceOpsTaskView> {
    this.cleanupTasks();
    if (this.tasks.size >= DEVICE_OPS_MAX_TASKS) {
      throw new DeviceOpsGatewayError(
        503,
        "The temporary device operations task capacity is full",
      );
    }
    const session = this.sessionFor(input.clientId, input.timeoutMs);
    const now = this.now();
    const task: StoredDeviceOpsTask = {
      taskId: this.createId(),
      sessionId: session.command.sessionId,
      clientId: input.clientId,
      operation: input.operation,
      params: input.params,
      timeoutMs: input.timeoutMs,
      status: "EXECUTING",
      code: null,
      message: null,
      data: {},
      artifact: null,
      createTimeUtc: now,
      expiresAtUtc: now + DEVICE_OPS_CONNECT_TIMEOUT_MS + input.timeoutMs,
      startedAtUtc: null,
      finishedAtUtc: null,
      request: null,
      sentOn: null,
      timeout: null,
    };
    this.tasks.set(task.taskId, task);
    session.taskIds.add(task.taskId);
    this.armTaskTimeout(task, task.expiresAtUtc);
    const accepted = this.view(task);
    try {
      await this.publishOpenSession(input.clientId, session.command);
    } catch {
      this.finishTask(
        task,
        "FAILURE",
        "OPS_OPEN_SESSION_PUBLISH_FAILED",
        "Failed to publish the device operations session",
        {},
      );
      throw new DeviceOpsGatewayError(
        502,
        "Failed to publish the device operations session",
      );
    }
    this.sendTask(session, task);
    return accepted;
  }

  /**
   * Return a bounded operations task for polling.
   *
   * @param taskId Task identifier returned by createOperation.
   * @returns The task view, or null after it is missing or expired from retention.
   */
  getTask(taskId: string): DeviceOpsTaskView | null {
    this.cleanupTasks();
    const task = this.tasks.get(taskId);
    return task ? this.view(task) : null;
  }

  /**
   * Convert internal task state to a detached public representation.
   *
   * @param task Stored task state.
   * @returns A poll-safe detached task view.
   */
  private view(task: StoredDeviceOpsTask): DeviceOpsTaskView {
    const artifact = task.artifact
      ? {
          ...task.artifact.header,
          contentBase64: task.artifact.content.toString("base64"),
        }
      : null;
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      clientId: task.clientId,
      operation: task.operation,
      status: task.status,
      code: task.code,
      message: task.message,
      data: task.data,
      artifact,
      createTimeUtc: task.createTimeUtc,
      expiresAtUtc: task.expiresAtUtc,
      startedAtUtc: task.startedAtUtc,
      finishedAtUtc: task.finishedAtUtc,
    };
  }

  /**
   * Attach a device-authenticated WebSocket and require hello as its first frame.
   *
   * @param socket WebSocket accepted by the device-only WSS endpoint.
   * @returns Nothing.
   */
  acceptDeviceSocket(socket: WebSocket): void {
    if (this.unboundSockets.size >= DEVICE_OPS_MAX_UNBOUND_SOCKETS) {
      socket.close(1013, "OPS_CONNECTION_LIMIT");
      return;
    }
    this.unboundSockets.add(socket);
    let session: StoredDeviceOpsSession | null = null;
    const helloTimer = setTimeout(
      () => socket.close(1008, "OPS_HELLO_TIMEOUT"),
      5_000,
    );
    helloTimer.unref();
    socket.on("message", (data, isBinary) => {
      try {
        if (!session) {
          const value: unknown = JSON.parse(readTextFrame(data, isBinary));
          session = this.bindHello(socket, value);
          this.unboundSockets.delete(socket);
          clearTimeout(helloTimer);
          return;
        }
        if (isBinary) {
          const frame = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as Buffer | ArrayBuffer);
          this.handleArtifact(session, frame);
          return;
        }
        const value: unknown = JSON.parse(readTextFrame(data, false));
        if (isDeviceOpsRecord(value) && value.type === "close") {
          const close = parseDeviceOpsClose(value);
          if (close.sessionId !== session.command.sessionId) {
            throw new Error("Device operations close correlation failed");
          }
          this.expireSession(session, close.code);
          return;
        }
        this.handleResponse(session, value);
      } catch {
        socket.close(1008, "OPS_FRAME_INVALID");
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.unboundSockets.delete(socket);
      if (session?.socket === socket) {
        session.socket = null;
        session.hello = null;
        for (const taskId of session.taskIds) {
          const task = this.tasks.get(taskId);
          if (task?.sentOn === socket && !isTerminalStatus(task.status)) {
            this.finishTask(
              task,
              "FAILURE",
              "OPS_CONNECTION_LOST",
              "The device connection closed before a terminal result; execution state is unknown",
              {},
            );
          }
        }
      }
    });
    socket.on("error", () => undefined);
  }

  /**
   * Close timers and sockets owned by an isolated gateway instance.
   *
   * @returns Nothing.
   */
  dispose(): void {
    for (const task of this.tasks.values()) {
      if (task.timeout) clearTimeout(task.timeout);
    }
    for (const session of this.sessionsById.values()) {
      clearTimeout(session.expiryTimer);
      session.socket?.terminate();
    }
    for (const socket of this.unboundSockets) socket.terminate();
    this.tasks.clear();
    this.sessionsById.clear();
    this.sessionsByDevice.clear();
    this.unboundSockets.clear();
    this.storedArtifactBytes = 0;
  }
}
