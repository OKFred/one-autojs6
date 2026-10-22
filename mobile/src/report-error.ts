/** HTTP 上报响应的最小对象形状。 */
interface ReportErrorEnvelope {
  data?: {
    code?: unknown;
    details?: unknown;
  };
}

/**
 * 返回经过白名单过滤的稳定业务代码。
 *
 * @param value 服务端返回的未知业务代码。
 * @returns 可安全记录的业务代码；不符合约束时返回空字符串。
 */
function safeBusinessCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : "";
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
  const suffix = code ? ` code=${code}` : "";
  return new Error(
    `HTTP_REPORT_REJECTED status=${status}${suffix} details=${detailShape(envelope.data?.details)}`,
  );
}
