import { isRecord } from "./protocol.js";

/** Device operations protocol version. */
export const OPS_PROTOCOL_VERSION = 1 as const;

/** Maximum accepted application frame size. */
export const OPS_MAX_FRAME_BYTES = 64 * 1024;

/** Maximum screenshot payload relayed through the temporary operations WSS. */
export const OPS_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** Maximum JSON header embedded in a binary artifact frame. */
export const OPS_MAX_ARTIFACT_HEADER_BYTES = 4 * 1024;

/** Operations exposed by the short-lived maintenance channel. */
export const DEVICE_OPS = [
  "device.ops.capabilities",
  "device.audio.get",
  "device.audio.set",
  "device.audio.mute",
  "device.audio.unmute",
  "device.storage.stat",
  "device.files.list",
  "device.foreground.get",
  "device.network.get",
  "device.screen.capture",
] as const;

/** A supported maintenance operation. */
export type DeviceOpsOperation = (typeof DEVICE_OPS)[number];

/** MQTT command asking a device to establish a temporary WSS session. */
export interface DeviceOpsOpenSessionCommand {
  protocolVersion: 1;
  type: "OPEN_SESSION";
  sessionId: string;
  deviceId: string;
  wsUrl: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

/** Structured request received through the WSS session. */
export interface DeviceOpsRequest {
  protocolVersion: 1;
  type: "request";
  sessionId: string;
  requestId: string;
  operation: DeviceOpsOperation;
  params: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

/** Terminal operation status. */
export type DeviceOpsResponseStatus =
  | "SUCCESS"
  | "FAILURE"
  | "TIMEOUT"
  | "REJECTED"
  | "CANCELLED";

/** Structured operation result sent through WSS. */
export interface DeviceOpsResponse {
  protocolVersion: 1;
  type: "response";
  sessionId: string;
  requestId: string;
  operation: DeviceOpsOperation;
  status: DeviceOpsResponseStatus;
  code: string;
  message: string;
  data: unknown;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

/** Metadata prepended to a binary artifact frame. */
export interface DeviceOpsArtifactHeader {
  protocolVersion: 1;
  type: "artifact";
  sessionId: string;
  requestId: string;
  operation: "device.screen.capture";
  artifactId: string;
  mimeType: "image/png";
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  capturedAt: number;
}

/** Ephemeral screenshot returned by the trusted operation executor. */
export interface DeviceOpsArtifact {
  kind: "artifact";
  artifactId: string;
  operation: "device.screen.capture";
  mimeType: "image/png";
  content: Buffer;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  capturedAt: number;
}

/** Return true when an executor result contains a binary artifact. */
export function isDeviceOpsArtifact(
  value: unknown,
): value is DeviceOpsArtifact {
  if (!isRecord(value)) return false;
  return (
    value.kind === "artifact" &&
    value.operation === "device.screen.capture" &&
    value.mimeType === "image/png" &&
    Buffer.isBuffer(value.content) &&
    typeof value.artifactId === "string" &&
    typeof value.sizeBytes === "number" &&
    typeof value.sha256 === "string" &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    typeof value.capturedAt === "number"
  );
}

/** Encode one artifact as a bounded binary WSS frame. */
export function encodeDeviceOpsArtifactFrame(
  request: Pick<DeviceOpsRequest, "sessionId" | "requestId">,
  artifact: DeviceOpsArtifact,
): Buffer {
  if (
    artifact.content.byteLength !== artifact.sizeBytes ||
    artifact.sizeBytes <= 0 ||
    artifact.sizeBytes > OPS_MAX_ARTIFACT_BYTES
  ) {
    throw new DeviceOpsFailure(
      "SCREENSHOT_TOO_LARGE",
      "Screenshot exceeded the operations artifact limit",
    );
  }
  const header: DeviceOpsArtifactHeader = {
    protocolVersion: OPS_PROTOCOL_VERSION,
    type: "artifact",
    sessionId: request.sessionId,
    requestId: request.requestId,
    operation: artifact.operation,
    artifactId: artifact.artifactId,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    width: artifact.width,
    height: artifact.height,
    capturedAt: artifact.capturedAt,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.byteLength > OPS_MAX_ARTIFACT_HEADER_BYTES) {
    throw new DeviceOpsFailure(
      "SCREENSHOT_FORMAT_INVALID",
      "Screenshot artifact header exceeded the operations limit",
    );
  }
  const frame = Buffer.allocUnsafe(
    4 + headerBytes.byteLength + artifact.sizeBytes,
  );
  frame.writeUInt32BE(headerBytes.byteLength, 0);
  headerBytes.copy(frame, 4);
  artifact.content.copy(frame, 4 + headerBytes.byteLength);
  return frame;
}

/** Stable application failure returned by an operation handler. */
export class DeviceOpsFailure extends Error {
  /** Create a typed operation failure. */
  constructor(
    readonly code: string,
    message: string,
    readonly status: DeviceOpsResponseStatus = "FAILURE",
  ) {
    super(message);
  }
}

/** Validate an identifier shared by MQTT and WSS envelopes. */
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value);
}

/** Parse a server request to open a temporary WSS session. */
export function parseDeviceOpsOpenSessionCommand(
  value: unknown,
): DeviceOpsOpenSessionCommand {
  if (!isRecord(value)) throw new Error("Ops command must be an object");
  if (
    value.protocolVersion !== OPS_PROTOCOL_VERSION ||
    value.type !== "OPEN_SESSION" ||
    !validId(value.sessionId) ||
    typeof value.deviceId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(value.deviceId) ||
    !validId(value.nonce) ||
    typeof value.wsUrl !== "string" ||
    typeof value.issuedAt !== "number" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.issuedAt) ||
    !Number.isFinite(value.expiresAt)
  ) {
    throw new Error("Invalid ops open-session envelope");
  }
  if (value.expiresAt <= value.issuedAt) {
    throw new Error("Ops session expiry must be later than issue time");
  }
  if (value.expiresAt - value.issuedAt > 30 * 60 * 1000) {
    throw new Error("Ops session exceeds the 30 minute maximum");
  }
  const url = new URL(value.wsUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("Ops endpoint must use WSS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Ops endpoint must not contain credentials or query data");
  }
  return {
    protocolVersion: OPS_PROTOCOL_VERSION,
    type: "OPEN_SESSION",
    sessionId: value.sessionId,
    deviceId: value.deviceId,
    wsUrl: url.toString(),
    nonce: value.nonce,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}

/** Parse and validate a WSS operation request. */
export function parseDeviceOpsRequest(
  value: unknown,
  expectedSessionId: string,
): DeviceOpsRequest {
  if (!isRecord(value)) throw new Error("Ops frame must be an object");
  if (
    value.protocolVersion !== OPS_PROTOCOL_VERSION ||
    value.type !== "request" ||
    value.sessionId !== expectedSessionId ||
    !validId(value.requestId) ||
    !DEVICE_OPS.some((operation) => operation === value.operation) ||
    !isRecord(value.params) ||
    typeof value.createdAt !== "number" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.expiresAt)
  ) {
    throw new Error("Invalid ops request envelope");
  }
  if (value.expiresAt <= value.createdAt) {
    throw new Error("Ops request expiry must be later than creation time");
  }
  if (value.expiresAt - value.createdAt > 15_000) {
    throw new Error("Ops request exceeds the 15 second maximum");
  }
  return {
    protocolVersion: OPS_PROTOCOL_VERSION,
    type: "request",
    sessionId: value.sessionId,
    requestId: value.requestId,
    operation: value.operation as DeviceOpsOperation,
    params: value.params,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}
