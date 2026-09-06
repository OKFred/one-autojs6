import { createHash, timingSafeEqual } from "node:crypto";

/** Device operations protocol version shared with the mobile client. */
export const DEVICE_OPS_PROTOCOL_VERSION = 1 as const;

/** Maximum JSON application frame accepted by either endpoint. */
export const DEVICE_OPS_MAX_FRAME_BYTES = 64 * 1024;

/** Maximum screenshot artifact accepted from a device. */
export const DEVICE_OPS_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** Maximum JSON header prepended to a screenshot artifact. */
export const DEVICE_OPS_MAX_ARTIFACT_HEADER_BYTES = 4 * 1024;

/** Maximum request execution time supported by the mobile protocol. */
export const DEVICE_OPS_MAX_REQUEST_TIMEOUT_MS = 15_000;

/** Minimum request execution time accepted by the PC API. */
export const DEVICE_OPS_MIN_REQUEST_TIMEOUT_MS = 1_000;

/** Operations supported by the mobile operations v1 executor. */
export const DEVICE_OPS_OPERATIONS = [
  "device.ops.capabilities",
  "device.audio.get",
  "device.audio.set",
  "device.audio.mute",
  "device.audio.unmute",
  "device.storage.stat",
  "device.files.list",
  "device.foreground.get",
  "device.ui.target-at",
  "device.network.get",
  "device.screen.brightness.get",
  "device.screen.brightness.set",
  "device.telephony.get",
  "device.alert.find",
  "device.screen.capture",
] as const;

/** Android audio streams accepted by the mobile operations v1 executor. */
export const DEVICE_OPS_AUDIO_STREAMS = [
  "voiceCall",
  "system",
  "ring",
  "media",
  "alarm",
  "notification",
  "bluetoothSco",
  "dtmf",
  "accessibility",
] as const;

/** One allowlisted mobile operations v1 operation. */
export type DeviceOpsOperation = (typeof DEVICE_OPS_OPERATIONS)[number];

/** Terminal status returned by a mobile operations request. */
export type DeviceOpsTerminalStatus =
  | "SUCCESS"
  | "FAILURE"
  | "TIMEOUT"
  | "REJECTED"
  | "CANCELLED";

/** Validated PC HTTP request for one device operation. */
export interface DeviceOpsCreateInput {
  clientId: string;
  operation: DeviceOpsOperation;
  params: Record<string, unknown>;
  timeoutMs: number;
}

/** MQTT command asking a device to establish an operations WSS session. */
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

/** Request sent to a connected device over the operations WSS. */
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

/** Initial authenticated application frame sent by the device. */
export interface DeviceOpsHello {
  protocolVersion: 1;
  type: "hello";
  role: "device";
  sessionId: string;
  deviceId: string;
  nonce: string;
  capabilities: Record<string, unknown>;
  timestamp: number;
}

/** Terminal JSON response sent by the device. */
export interface DeviceOpsResponse {
  protocolVersion: 1;
  type: "response";
  sessionId: string;
  requestId: string;
  operation: DeviceOpsOperation;
  status: DeviceOpsTerminalStatus;
  code: string;
  message: string;
  data: unknown;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

/** Device-originated session close notification. */
export interface DeviceOpsClose {
  protocolVersion: 1;
  type: "close";
  sessionId: string;
  code: string;
  message: string;
  timestamp: number;
}

/** Metadata prepended to one screenshot artifact. */
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

/** Validated screenshot artifact retained by the temporary PC gateway. */
export interface DeviceOpsArtifact {
  header: DeviceOpsArtifactHeader;
  content: Buffer;
}

/** Privacy-classified text returned for one Android UI node. */
export type DeviceUiClassifiedText =
  | { mode: "literal"; value: string; reviewed: true }
  | { mode: "parameter"; key: string }
  | { mode: "redacted"; category: string; length: number };

/** One privacy-safe target selected from an Android UI hierarchy. */
export interface DeviceUiTarget {
  source: "android-uiautomator";
  confidence: "exact-resource-id" | "composite" | "heuristic";
  packageName: string | null;
  activityName: string | null;
  className: string;
  resourceId?: string;
  text?: DeviceUiClassifiedText;
  description?: DeviceUiClassifiedText;
  bounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    screenWidth: number;
    screenHeight: number;
  };
  clickable: boolean;
  editable: boolean;
}

/** Strict result returned by device.ui.target-at. */
export interface DeviceUiTargetAtResult {
  target: DeviceUiTarget | null;
  foreground: {
    packageName: string | null;
    activityName: string | null;
  };
  display: { width: number; height: number };
  capturedAt: number;
}

/** Generic UI labels independently reviewed for literal transport by the PC. */
const DEVICE_UI_PUBLIC_LITERAL_VALUES = new Set([
  "add", "allow", "back", "cancel", "close", "continue", "delete",
  "deny", "done", "edit", "home", "log in", "messages", "more",
  "new", "next", "ok", "open", "previous", "publish", "retry",
  "save", "search", "send", "share", "sign in", "sms", "上一步",
  "下一步", "主页", "主屏幕", "允许", "信息", "保存", "关闭",
  "分享", "删除", "发送", "发布", "取消", "完成", "打开",
  "拒绝", "新建", "更多", "消息", "添加", "短信", "确定",
  "继续", "编辑", "返回", "重试",
]);

/** Fixed messages accepted for the privacy-sensitive UI target operation. */
const DEVICE_UI_TARGET_RESPONSE_MESSAGES: Readonly<Record<string, string>> = {
  "SUCCESS:OPS_OPERATION_SUCCEEDED": "Operation completed",
  "FAILURE:UI_HIERARCHY_TOO_LARGE":
    "Android UI hierarchy exceeded the read limit",
  "FAILURE:UI_HIERARCHY_DUMP_FAILED": "Android UI hierarchy dump failed",
  "FAILURE:UI_HIERARCHY_CLEANUP_FAILED":
    "Android UI hierarchy temporary file cleanup failed",
  "FAILURE:UI_HIERARCHY_INVALID": "Android returned an invalid UI hierarchy",
  "FAILURE:OPS_OPERATION_FAILED": "Android UI target lookup failed",
  "FAILURE:OPS_RESPONSE_TOO_LARGE": "Operation result exceeded the frame limit",
  "TIMEOUT:OPS_REQUEST_EXPIRED": "Operation request expired",
  "TIMEOUT:OPS_OPERATION_TIMEOUT": "Operation timed out",
  "REJECTED:UI_TARGET_COORDINATES_INVALID":
    "UI target coordinates were rejected",
  "REJECTED:DEPLOYMENT_DRAINING": "Device deployment is draining",
  "REJECTED:OPS_CONCURRENCY_LIMIT": "Operations concurrency limit reached",
};

/**
 * Return whether a value is a plain JSON object.
 *
 * @param value Unknown value received from HTTP or WebSocket JSON.
 * @returns Whether the value is a non-array object.
 */
export function isDeviceOpsRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return whether a string is a protocol-safe identifier.
 *
 * @param value Unknown identifier value.
 * @returns Whether the value matches the bounded protocol identifier format.
 */
export function isDeviceOpsId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value);
}

/**
 * Return whether a string is a valid device identifier.
 *
 * @param value Unknown client identifier value.
 * @returns Whether the value is safe for the device MQTT topic segment.
 */
export function isDeviceOpsClientId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value)
  );
}

/**
 * Compare two secret strings without leaking equal-length timing.
 *
 * @param actual Credential received from an untrusted peer.
 * @param expected Configured credential.
 * @returns Whether both credentials are exactly equal.
 */
export function safeDeviceOpsSecretEqual(
  actual: string,
  expected: string,
): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

/**
 * Reject unknown object keys to keep the public command surface explicit.
 *
 * @param value Object whose keys are checked.
 * @param allowed Exact set of accepted keys.
 * @param field Field label included in validation errors.
 * @returns Nothing.
 */
function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${field} contains unknown field ${unknown}`);
}

/** Validate a nullable, bounded Android component identifier. */
function parseNullableAndroidIdentifier(
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9_.$:-]+(?:\/[A-Za-z0-9_.$:-]+)?$/.test(value)
  ) {
    throw new Error(`${field} is not a bounded Android identifier`);
  }
  return value;
}

/** Validate one privacy-classified target text value. */
function parseDeviceUiClassifiedText(
  value: unknown,
  field: string,
): DeviceUiClassifiedText {
  if (!isDeviceOpsRecord(value) || typeof value.mode !== "string") {
    throw new Error(`${field} is not a classified text object`);
  }
  if (value.mode === "literal") {
    requireOnlyKeys(value, ["mode", "value", "reviewed"], field);
    if (
      typeof value.value !== "string" ||
      value.value.length < 1 ||
      value.value.length > 80 ||
      value.reviewed !== true ||
      /[\u0000-\u001f\u007f]/.test(value.value) ||
      value.value !== value.value.trim().replace(/\s+/g, " ") ||
      !DEVICE_UI_PUBLIC_LITERAL_VALUES.has(
        value.value.toLocaleLowerCase("en-US"),
      )
    ) {
      throw new Error(`${field} literal is invalid`);
    }
    return { mode: "literal", value: value.value, reviewed: true };
  }
  if (value.mode === "parameter") {
    requireOnlyKeys(value, ["mode", "key"], field);
    if (
      typeof value.key !== "string" ||
      !/^[a-z][a-z0-9_.-]{0,79}$/.test(value.key)
    ) {
      throw new Error(`${field} parameter key is invalid`);
    }
    return { mode: "parameter", key: value.key };
  }
  if (value.mode === "redacted") {
    requireOnlyKeys(value, ["mode", "category", "length"], field);
    if (
      typeof value.category !== "string" ||
      !/^[a-z][a-z0-9-]{0,79}$/.test(value.category) ||
      !Number.isSafeInteger(value.length) ||
      (value.length as number) < 1 ||
      (value.length as number) > OPS_MAX_UI_TEXT_LENGTH
    ) {
      throw new Error(`${field} redaction metadata is invalid`);
    }
    return {
      mode: "redacted",
      category: value.category,
      length: value.length as number,
    };
  }
  throw new Error(`${field} mode is unsupported`);
}

/** Maximum source text length representable by a bounded hierarchy dump. */
const OPS_MAX_UI_TEXT_LENGTH = 4 * 1024;

/** Parse and strictly validate one device.ui.target-at success result. */
export function parseDeviceUiTargetAtResult(
  value: unknown,
): DeviceUiTargetAtResult {
  if (!isDeviceOpsRecord(value)) {
    throw new Error("device.ui.target-at data must be an object");
  }
  requireOnlyKeys(value, ["target", "foreground", "display", "capturedAt"], "data");
  if (
    !Object.prototype.hasOwnProperty.call(value, "target") ||
    !isDeviceOpsRecord(value.foreground) ||
    !isDeviceOpsRecord(value.display) ||
    !Number.isSafeInteger(value.capturedAt) ||
    (value.capturedAt as number) < 0
  ) {
    throw new Error("device.ui.target-at data is incomplete");
  }
  requireOnlyKeys(value.foreground, ["packageName", "activityName"], "foreground");
  const foreground = {
    packageName: parseNullableAndroidIdentifier(
      value.foreground.packageName,
      "foreground.packageName",
    ),
    activityName: parseNullableAndroidIdentifier(
      value.foreground.activityName,
      "foreground.activityName",
    ),
  };
  requireOnlyKeys(value.display, ["width", "height"], "display");
  if (
    !Number.isSafeInteger(value.display.width) ||
    !Number.isSafeInteger(value.display.height) ||
    (value.display.width as number) < 1 ||
    (value.display.height as number) < 1 ||
    (value.display.width as number) > 16_384 ||
    (value.display.height as number) > 16_384
  ) {
    throw new Error("device.ui.target-at display is invalid");
  }
  const display = {
    width: value.display.width as number,
    height: value.display.height as number,
  };
  if (value.target === null) {
    return {
      target: null,
      foreground,
      display,
      capturedAt: value.capturedAt as number,
    };
  }
  if (!isDeviceOpsRecord(value.target)) {
    throw new Error("device.ui.target-at target is invalid");
  }
  requireOnlyKeys(
    value.target,
    [
      "source",
      "confidence",
      "packageName",
      "activityName",
      "className",
      "resourceId",
      "text",
      "description",
      "bounds",
      "clickable",
      "editable",
    ],
    "target",
  );
  if (
    value.target.source !== "android-uiautomator" ||
    !["exact-resource-id", "composite", "heuristic"].includes(
      String(value.target.confidence),
    ) ||
    typeof value.target.className !== "string" ||
    !/^[A-Za-z0-9_.$:-]{1,200}$/.test(value.target.className) ||
    typeof value.target.clickable !== "boolean" ||
    typeof value.target.editable !== "boolean" ||
    !isDeviceOpsRecord(value.target.bounds)
  ) {
    throw new Error("device.ui.target-at target fields are invalid");
  }
  const packageName = parseNullableAndroidIdentifier(
    value.target.packageName,
    "target.packageName",
  );
  const activityName = parseNullableAndroidIdentifier(
    value.target.activityName,
    "target.activityName",
  );
  let resourceId: string | undefined;
  if (value.target.resourceId !== undefined) {
    const parsed = parseNullableAndroidIdentifier(
      value.target.resourceId,
      "target.resourceId",
    );
    if (parsed === null) throw new Error("target.resourceId must not be null");
    resourceId = parsed;
  }
  if (value.target.confidence === "exact-resource-id" && !resourceId) {
    throw new Error("exact-resource-id target requires resourceId");
  }
  const text =
    value.target.text === undefined
      ? undefined
      : parseDeviceUiClassifiedText(value.target.text, "target.text");
  const description =
    value.target.description === undefined
      ? undefined
      : parseDeviceUiClassifiedText(
          value.target.description,
          "target.description",
        );
  const hasSemanticSummary = Boolean(resourceId || text || description);
  if (value.target.confidence === "composite" && !hasSemanticSummary) {
    throw new Error("composite target requires semantic summary fields");
  }
  if (value.target.confidence === "heuristic" && hasSemanticSummary) {
    throw new Error("heuristic target must not contain semantic summary fields");
  }
  requireOnlyKeys(
    value.target.bounds,
    ["left", "top", "right", "bottom", "screenWidth", "screenHeight"],
    "target.bounds",
  );
  const targetBounds = value.target.bounds;
  const boundNames = [
    "left",
    "top",
    "right",
    "bottom",
    "screenWidth",
    "screenHeight",
  ] as const;
  if (
    boundNames.some((name) => !Number.isSafeInteger(targetBounds[name])) ||
    (targetBounds.left as number) < 0 ||
    (targetBounds.top as number) < 0 ||
    (targetBounds.right as number) <= (targetBounds.left as number) ||
    (targetBounds.bottom as number) <= (targetBounds.top as number) ||
    targetBounds.screenWidth !== display.width ||
    targetBounds.screenHeight !== display.height ||
    (targetBounds.right as number) > display.width ||
    (targetBounds.bottom as number) > display.height
  ) {
    throw new Error("device.ui.target-at bounds are invalid");
  }
  return {
    target: {
      source: "android-uiautomator",
      confidence: value.target.confidence as DeviceUiTarget["confidence"],
      packageName,
      activityName,
      className: value.target.className,
      ...(resourceId ? { resourceId } : {}),
      ...(text ? { text } : {}),
      ...(description ? { description } : {}),
      bounds: {
        left: targetBounds.left as number,
        top: targetBounds.top as number,
        right: targetBounds.right as number,
        bottom: targetBounds.bottom as number,
        screenWidth: targetBounds.screenWidth as number,
        screenHeight: targetBounds.screenHeight as number,
      },
      clickable: value.target.clickable,
      editable: value.target.editable,
    },
    foreground,
    display,
    capturedAt: value.capturedAt as number,
  };
}

/**
 * Validate a configured or requested operations WSS URL.
 *
 * @param value Candidate phone-reachable URL.
 * @returns A normalized WSS URL, or loopback-only WS URL for local tests.
 */
export function normalizeDeviceOpsWsUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("DEVICE_OPS_WS_URL is required");
  }
  const url = new URL(value.trim());
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("DEVICE_OPS_WS_URL must use WSS except on loopback");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "DEVICE_OPS_WS_URL must not contain credentials, query data, or a fragment",
    );
  }
  return url.toString();
}

/**
 * Validate one audio stream parameter.
 *
 * @param value Candidate Android audio stream name.
 * @param allowAll Whether the aggregate `all` selector is accepted.
 * @returns The validated audio stream selector.
 */
function parseAudioStream(
  value: unknown,
  allowAll: boolean,
): (typeof DEVICE_OPS_AUDIO_STREAMS)[number] | "all" {
  if (
    typeof value === "string" &&
    (DEVICE_OPS_AUDIO_STREAMS.some((stream) => stream === value) ||
      (allowAll && value === "all"))
  ) {
    return value as (typeof DEVICE_OPS_AUDIO_STREAMS)[number] | "all";
  }
  throw new Error("params.stream is not an allowlisted Android audio stream");
}

/**
 * Validate and normalize operation-specific parameters.
 *
 * @param operation Allowlisted operation being requested.
 * @param value Candidate params object.
 * @returns A detached normalized params object for the device request.
 */
function parseOperationParams(
  operation: DeviceOpsOperation,
  value: unknown,
): Record<string, unknown> {
  const params = value === undefined ? {} : value;
  if (!isDeviceOpsRecord(params)) throw new Error("params must be an object");
  if (operation === "device.ui.target-at") {
    requireOnlyKeys(params, ["x", "y", "screenWidth", "screenHeight"], "params");
    const { x, y, screenWidth, screenHeight } = params;
    if (
      !Number.isSafeInteger(screenWidth) ||
      !Number.isSafeInteger(screenHeight) ||
      (screenWidth as number) < 1 ||
      (screenHeight as number) < 1 ||
      (screenWidth as number) > 16_384 ||
      (screenHeight as number) > 16_384 ||
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      (x as number) < 0 ||
      (y as number) < 0 ||
      (x as number) >= (screenWidth as number) ||
      (y as number) >= (screenHeight as number)
    ) {
      throw new Error(
        "params x/y must be safe integers inside screenWidth/screenHeight from 1 to 16384",
      );
    }
    return {
      x: x as number,
      y: y as number,
      screenWidth: screenWidth as number,
      screenHeight: screenHeight as number,
    };
  }
  if (
    operation === "device.ops.capabilities" ||
    operation === "device.foreground.get" ||
    operation === "device.network.get" ||
    operation === "device.screen.brightness.get" ||
    operation === "device.telephony.get" ||
    operation === "device.screen.capture"
  ) {
    requireOnlyKeys(params, [], "params");
    return {};
  }
  if (operation === "device.audio.get") {
    requireOnlyKeys(params, ["stream"], "params");
    return {
      stream:
        params.stream === undefined
          ? "all"
          : parseAudioStream(params.stream, true),
    };
  }
  if (
    operation === "device.audio.mute" ||
    operation === "device.audio.unmute"
  ) {
    requireOnlyKeys(params, ["stream"], "params");
    return { stream: parseAudioStream(params.stream, false) };
  }
  if (operation === "device.audio.set") {
    requireOnlyKeys(params, ["stream", "level"], "params");
    if (
      !Number.isSafeInteger(params.level) ||
      (params.level as number) < 0
    ) {
      throw new Error(
        "params.level must be a non-negative absolute Android stream index; query device.audio.get for the dynamic maximum",
      );
    }
    return {
      stream: parseAudioStream(params.stream, false),
      level: params.level,
    };
  }
  if (operation === "device.screen.brightness.set") {
    requireOnlyKeys(params, ["level", "mode"], "params");
    if (params.level === undefined && params.mode === undefined) {
      throw new Error("brightness set requires level or mode");
    }
    if (
      params.level !== undefined &&
      (!Number.isInteger(params.level) ||
        (params.level as number) < 1 ||
        (params.level as number) > 255)
    ) {
      throw new Error("params.level must be an integer between 1 and 255");
    }
    if (
      params.mode !== undefined &&
      params.mode !== "manual" &&
      params.mode !== "automatic"
    ) {
      throw new Error("params.mode must be manual or automatic");
    }
    return {
      ...(params.level === undefined ? {} : { level: params.level }),
      ...(params.mode === undefined ? {} : { mode: params.mode }),
    };
  }
  if (operation === "device.alert.find") {
    requireOnlyKeys(params, ["durationMs"], "params");
    const durationMs = params.durationMs === undefined ? 2000 : params.durationMs;
    if (
      !Number.isInteger(durationMs) ||
      (durationMs as number) < 500 ||
      (durationMs as number) > 5000
    ) {
      throw new Error("params.durationMs must be an integer between 500 and 5000");
    }
    return { durationMs };
  }
  if (operation === "device.storage.stat") {
    requireOnlyKeys(params, ["rootId"], "params");
    if (
      typeof params.rootId !== "string" ||
      !/^[a-z0-9-]{1,40}$/.test(params.rootId)
    ) {
      throw new Error("params.rootId has an invalid format");
    }
    return { rootId: params.rootId };
  }
  requireOnlyKeys(
    params,
    ["rootId", "path", "pageSize", "cursor"],
    "params",
  );
  if (
    typeof params.rootId !== "string" ||
    !/^[a-z0-9-]{1,40}$/.test(params.rootId)
  ) {
    throw new Error("params.rootId has an invalid format");
  }
  const relativePath = params.path === undefined ? "" : params.path;
  if (
    typeof relativePath !== "string" ||
    relativePath.length > 1024 ||
    relativePath.includes("\0") ||
    /^(?:[A-Za-z]:|[\\/])/.test(relativePath) ||
    relativePath.split(/[\\/]+/).includes("..")
  ) {
    throw new Error("params.path must be a safe relative path");
  }
  const pageSize = params.pageSize === undefined ? 100 : params.pageSize;
  if (
    !Number.isInteger(pageSize) ||
    (pageSize as number) < 1 ||
    (pageSize as number) > 200
  ) {
    throw new Error("params.pageSize must be an integer between 1 and 200");
  }
  const cursor = params.cursor === undefined ? "" : params.cursor;
  if (typeof cursor !== "string" || !/^\d{0,12}$/.test(cursor)) {
    throw new Error("params.cursor must be a bounded numeric cursor");
  }
  return {
    rootId: params.rootId,
    path: relativePath,
    pageSize,
    cursor,
  };
}

/**
 * Parse a public HTTP request for one allowlisted device operation.
 *
 * @param value Untrusted JSON request body.
 * @returns Strict normalized operation input.
 */
export function parseDeviceOpsCreateInput(
  value: unknown,
): DeviceOpsCreateInput {
  if (!isDeviceOpsRecord(value)) throw new Error("Request body must be an object");
  requireOnlyKeys(
    value,
    ["clientId", "operation", "params", "timeoutMs"],
    "request",
  );
  if (!isDeviceOpsClientId(value.clientId)) {
    throw new Error("clientId has an invalid format");
  }
  if (
    typeof value.operation !== "string" ||
    !DEVICE_OPS_OPERATIONS.some(
      (operation) => operation === value.operation,
    )
  ) {
    throw new Error("operation is not in the device operations allowlist");
  }
  const timeoutMs = value.timeoutMs === undefined ? 10_000 : value.timeoutMs;
  if (
    !Number.isInteger(timeoutMs) ||
    (timeoutMs as number) < DEVICE_OPS_MIN_REQUEST_TIMEOUT_MS ||
    (timeoutMs as number) > DEVICE_OPS_MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new Error("timeoutMs must be an integer between 1000 and 15000");
  }
  const operation = value.operation as DeviceOpsOperation;
  const params = parseOperationParams(operation, value.params);
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > 48 * 1024) {
    throw new Error("params exceeds the operations payload limit");
  }
  return {
    clientId: value.clientId,
    operation,
    params,
    timeoutMs: timeoutMs as number,
  };
}

/**
 * Parse and validate the first application frame from a device.
 *
 * @param value Untrusted WebSocket JSON value.
 * @returns A structurally valid device hello for later session correlation.
 */
export function parseDeviceOpsHello(value: unknown): DeviceOpsHello {
  if (!isDeviceOpsRecord(value)) throw new Error("Ops hello must be an object");
  requireOnlyKeys(
    value,
    [
      "protocolVersion",
      "type",
      "role",
      "sessionId",
      "deviceId",
      "nonce",
      "capabilities",
      "timestamp",
    ],
    "hello",
  );
  if (
    value.protocolVersion !== DEVICE_OPS_PROTOCOL_VERSION ||
    value.type !== "hello" ||
    value.role !== "device" ||
    !isDeviceOpsId(value.sessionId) ||
    !isDeviceOpsClientId(value.deviceId) ||
    !isDeviceOpsId(value.nonce) ||
    !isDeviceOpsRecord(value.capabilities) ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp)
  ) {
    throw new Error("Invalid device operations hello");
  }
  return value as unknown as DeviceOpsHello;
}

/**
 * Parse and validate one terminal device response.
 *
 * @param value Untrusted WebSocket JSON value.
 * @returns A structurally valid response for later request correlation.
 */
export function parseDeviceOpsResponse(value: unknown): DeviceOpsResponse {
  if (!isDeviceOpsRecord(value)) {
    throw new Error("Ops response must be an object");
  }
  requireOnlyKeys(
    value,
    [
      "protocolVersion",
      "type",
      "sessionId",
      "requestId",
      "operation",
      "status",
      "code",
      "message",
      "data",
      "startedAt",
      "finishedAt",
      "durationMs",
    ],
    "response",
  );
  const statusAllowed = [
    "SUCCESS",
    "FAILURE",
    "TIMEOUT",
    "REJECTED",
    "CANCELLED",
  ].includes(String(value.status));
  const operationAllowed = DEVICE_OPS_OPERATIONS.some(
    (operation) => operation === value.operation,
  );
  if (
    value.protocolVersion !== DEVICE_OPS_PROTOCOL_VERSION ||
    value.type !== "response" ||
    !isDeviceOpsId(value.sessionId) ||
    !isDeviceOpsId(value.requestId) ||
    !operationAllowed ||
    !statusAllowed ||
    typeof value.code !== "string" ||
    value.code.length > 100 ||
    typeof value.message !== "string" ||
    value.message.length > 1000 ||
    !Object.prototype.hasOwnProperty.call(value, "data") ||
    typeof value.startedAt !== "number" ||
    typeof value.finishedAt !== "number" ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.startedAt) ||
    !Number.isFinite(value.finishedAt) ||
    !Number.isFinite(value.durationMs) ||
    value.finishedAt < value.startedAt ||
    value.durationMs < 0
  ) {
    throw new Error("Invalid device operations response");
  }
  let data = value.data;
  let message = value.message;
  if (value.operation === "device.ui.target-at") {
    const safeMessage =
      DEVICE_UI_TARGET_RESPONSE_MESSAGES[`${String(value.status)}:${value.code}`];
    if (!safeMessage) {
      throw new Error("device.ui.target-at response code is not allowlisted");
    }
    message = safeMessage;
    if (value.status === "SUCCESS") {
      data = parseDeviceUiTargetAtResult(value.data);
    } else {
      if (!isDeviceOpsRecord(value.data) || Object.keys(value.data).length !== 0) {
        throw new Error(
          "device.ui.target-at failure data must be an empty object",
        );
      }
      data = {};
    }
  }
  return { ...value, message, data } as unknown as DeviceOpsResponse;
}

/**
 * Parse and validate a device-originated close notification.
 *
 * @param value Untrusted WebSocket JSON value.
 * @returns A structurally valid close notification.
 */
export function parseDeviceOpsClose(value: unknown): DeviceOpsClose {
  if (!isDeviceOpsRecord(value)) throw new Error("Ops close must be an object");
  requireOnlyKeys(
    value,
    ["protocolVersion", "type", "sessionId", "code", "message", "timestamp"],
    "close",
  );
  if (
    value.protocolVersion !== DEVICE_OPS_PROTOCOL_VERSION ||
    value.type !== "close" ||
    !isDeviceOpsId(value.sessionId) ||
    typeof value.code !== "string" ||
    value.code.length > 100 ||
    typeof value.message !== "string" ||
    value.message.length > 1000 ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp)
  ) {
    throw new Error("Invalid device operations close");
  }
  return value as unknown as DeviceOpsClose;
}

/**
 * Decode and authenticate one binary screenshot artifact frame.
 *
 * @param frame Untrusted binary WebSocket frame.
 * @returns The verified artifact metadata and copied PNG bytes.
 */
export function parseDeviceOpsArtifactFrame(
  frame: Buffer,
): DeviceOpsArtifact {
  if (
    frame.byteLength < 5 ||
    frame.byteLength >
      4 + DEVICE_OPS_MAX_ARTIFACT_HEADER_BYTES + DEVICE_OPS_MAX_ARTIFACT_BYTES
  ) {
    throw new Error("Invalid device operations artifact size");
  }
  const headerSize = frame.readUInt32BE(0);
  if (
    headerSize < 2 ||
    headerSize > DEVICE_OPS_MAX_ARTIFACT_HEADER_BYTES ||
    4 + headerSize > frame.byteLength
  ) {
    throw new Error("Invalid device operations artifact header size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.subarray(4, 4 + headerSize).toString("utf8"));
  } catch {
    throw new Error("Invalid device operations artifact header JSON");
  }
  if (!isDeviceOpsRecord(parsed)) {
    throw new Error("Invalid device operations artifact header");
  }
  requireOnlyKeys(
    parsed,
    [
      "protocolVersion",
      "type",
      "sessionId",
      "requestId",
      "operation",
      "artifactId",
      "mimeType",
      "sizeBytes",
      "sha256",
      "width",
      "height",
      "capturedAt",
    ],
    "artifact",
  );
  if (
    parsed.protocolVersion !== DEVICE_OPS_PROTOCOL_VERSION ||
    parsed.type !== "artifact" ||
    !isDeviceOpsId(parsed.sessionId) ||
    !isDeviceOpsId(parsed.requestId) ||
    parsed.operation !== "device.screen.capture" ||
    !isDeviceOpsId(parsed.artifactId) ||
    parsed.mimeType !== "image/png" ||
    !Number.isInteger(parsed.sizeBytes) ||
    (parsed.sizeBytes as number) < 1 ||
    (parsed.sizeBytes as number) > DEVICE_OPS_MAX_ARTIFACT_BYTES ||
    typeof parsed.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.sha256) ||
    !Number.isInteger(parsed.width) ||
    (parsed.width as number) < 1 ||
    (parsed.width as number) > 16_384 ||
    !Number.isInteger(parsed.height) ||
    (parsed.height as number) < 1 ||
    (parsed.height as number) > 16_384 ||
    typeof parsed.capturedAt !== "number" ||
    !Number.isFinite(parsed.capturedAt)
  ) {
    throw new Error("Invalid device operations artifact header");
  }
  const content = frame.subarray(4 + headerSize);
  if (content.byteLength !== parsed.sizeBytes) {
    throw new Error("Device operations artifact length does not match header");
  }
  const digest = createHash("sha256").update(content).digest("hex");
  if (!safeDeviceOpsSecretEqual(digest, parsed.sha256)) {
    throw new Error("Device operations artifact checksum mismatch");
  }
  return {
    header: parsed as unknown as DeviceOpsArtifactHeader,
    content: Buffer.from(content),
  };
}
