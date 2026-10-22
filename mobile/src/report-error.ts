/** HTTP 上报响应的最小对象形状。 */
interface ReportErrorEnvelope {
  data?: {
    code?: unknown;
    details?: unknown;
  };
}

const BUSINESS_CODES = new Set([
  "INVALID_PARAMS",
  "NOT_AUTHENTICATED",
  "PERMISSION_DENIED",
  "NOT_EXIST_OR_DISABLED",
  "DUPLICATE_DATA",
  "VALIDATION_FAILED",
  "UNKNOWN_ERROR",
  "NOT_YET_IMPLEMENTED",
  "DATABASE_BUSY",
  "DATABASE_ERROR",
]);

const REPORT_FIELD_ALIASES = new Map(
  [
    "protocolVersion",
    "deviceId",
    "status",
    "timestamp",
    "manufacturer",
    "brand",
    "model",
    "androidVersion",
    "androidSdk",
    "autojs6Version",
    "clientVersion",
    "identifiers",
    "capabilities",
    "reportedExtra",
    "eventId",
    "type",
    "data",
  ].map((field) => [field, field]),
);

for (const child of [
  "imeis",
  "imeiStatus",
  "serialNumber",
  "serialStatus",
]) {
  const normalized = `identifiers.${child}`;
  REPORT_FIELD_ALIASES.set(normalized, normalized);
  REPORT_FIELD_ALIASES.set(`identifiers/${child}`, normalized);
}

const DETAIL_REASONS = new Map([
  ["Missing device report token", "MISSING_DEVICE_REPORT_TOKEN"],
  ["Unknown or disabled device", "UNKNOWN_OR_DISABLED_DEVICE"],
  ["Invalid operations capability", "INVALID_OPERATIONS_CAPABILITY"],
  [
    "Invalid or expired device report token",
    "INVALID_OR_EXPIRED_DEVICE_REPORT_TOKEN",
  ],
]);

/**
 * 返回经过白名单过滤的稳定业务代码。
 *
 * @param value 服务端返回的未知业务代码。
 * @returns 可安全记录的业务代码；不符合约束时返回空字符串。
 */
function safeBusinessCode(value: unknown): string {
  return typeof value === "string" && BUSINESS_CODES.has(value) ? value : "";
}

/**
 * 读取 Hodor 固定应用异常或 JSON Schema 字段，不返回任意详情文本。
 *
 * @param details Hodor 错误封装中的详情数组。
 * @returns 严格白名单映射后的原因码和字段名。
 */
function summarizeDetails(details: unknown): {
  reason: string;
  fields: string[];
} {
  if (!Array.isArray(details)) return { reason: "unknown", fields: [] };
  let reason = "unknown";
  const fields = new Set<string>();
  for (const detail of details.slice(0, 100)) {
    if (
      typeof detail !== "object" ||
      detail === null ||
      Array.isArray(detail)
    ) {
      continue;
    }
    const value = detail as Record<string, unknown>;
    if (value.type === "detail_error" && typeof value.message === "string") {
      reason = DETAIL_REASONS.get(value.message) || reason;
      continue;
    }
    if (typeof value.type === "string") {
      const normalizedField = REPORT_FIELD_ALIASES.get(value.type);
      if (normalizedField) fields.add(normalizedField);
    }
  }
  return { reason, fields: [...fields].sort() };
}

/**
 * 汇总服务端详情的数据形状，不记录任意文本或字段值。
 *
 * @param details 服务端返回的未知详情。
 * @returns 可安全记录的详情类型。
 */
function detailShape(details: unknown): string {
  if (Array.isArray(details)) return `array:${Math.min(details.length, 99)}`;
  if (details === null || details === undefined) return "none";
  if (typeof details === "object") return "object";
  return typeof details;
}

/**
 * 构造不会泄露令牌、设备标识、载荷或服务端任意消息的上报错误。
 *
 * @param status HTTP 状态码。
 * @param responseBody 已解析的未知响应体。
 * @returns 适合写入设备日志的稳定错误对象。
 */
export function createHttpReportError(
  status: number,
  responseBody: unknown,
): Error {
  const envelope =
    typeof responseBody === "object" &&
    responseBody !== null &&
    !Array.isArray(responseBody)
      ? (responseBody as ReportErrorEnvelope)
      : {};
  const code = safeBusinessCode(envelope.data?.code);
  const summary = summarizeDetails(envelope.data?.details);
  const suffix = code ? ` code=${code}` : "";
  const fields = summary.fields.length
    ? ` fields=${summary.fields.join(",")}`
    : "";
  return new Error(
    `HTTP_REPORT_REJECTED status=${status}${suffix} reason=${summary.reason}${fields} details=${detailShape(envelope.data?.details)}`,
  );
}
