import { randomUUID } from "node:crypto";

/** TikTok 任务动作。 */
export type TikTokAction = "publish" | "preflight" | "recover" | "status";

/** TikTok 媒体类型。 */
export type TikTokMediaKind = "image" | "video" | "auto";

/** TikTok v2 媒体选择参数。 */
export interface TikTokMediaContract {
  mode: "direct" | "pool";
  kind: TikTokMediaKind;
  path?: string;
  paths?: string[];
  directory?: string;
}

/** TikTok v2 文案参数。 */
export interface TikTokContentContract {
  title: string;
  details: string;
  titles: string[];
  detailsPool: string[];
}

/** TikTok v2 本次请求的频率保护参数。 */
export interface TikTokPolicyContract {
  minIntervalSeconds: number;
  maxPostsPerDay: number;
  materialReuseSeconds: number;
  captionReuseSeconds: number;
}

/** TikTok v2 作品链接重试参数。 */
export interface TikTokLinkContract {
  maxAttempts: number;
  retrySeconds: number;
}

/** 下发给手机的 TikTok v2 任务参数。 */
export interface TikTokTaskContract extends Record<string, unknown> {
  contractVersion: 2;
  action: TikTokAction;
  publicationId: string;
  expectedHandle?: string;
  media?: TikTokMediaContract;
  content: TikTokContentContract;
  policy: TikTokPolicyContract;
  link: TikTokLinkContract;
}

/** TikTok 请求归一化结果。 */
export interface NormalizedTikTokRequest {
  params: TikTokTaskContract;
  timeoutSeconds: number;
}

/** 可向归一化器传入的旧版查询参数。 */
export type TikTokLegacyQuery = Record<string, string | undefined>;

/** 可安全返回给调用方的 TikTok 请求校验错误。 */
export class TikTokContractError extends Error {
  /**
   * 创建契约校验错误。
   *
   * @param message 不包含敏感请求内容的错误说明。
   */
  constructor(message: string) {
    super(message);
    this.name = "TikTokContractError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDLE_PATTERN = /^[A-Za-z0-9._]{2,24}$/;
const ABSOLUTE_ANDROID_PATH_PATTERN = /^\/(?:[^\0/]+\/)*[^\0/]+$/;
const ACTIONS = new Set<TikTokAction>([
  "publish",
  "preflight",
  "recover",
  "status",
]);
const MEDIA_KINDS = new Set<TikTokMediaKind>(["image", "video", "auto"]);
const DEFAULT_POLICY: TikTokPolicyContract = {
  minIntervalSeconds: 1800,
  maxPostsPerDay: 3,
  materialReuseSeconds: 86400,
  captionReuseSeconds: 86400,
};
const DEFAULT_LINK: TikTokLinkContract = {
  maxAttempts: 8,
  retrySeconds: 15,
};

/** 判断未知值是否为普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 拒绝 v2 对象中的未知字段，避免拼写错误被静默忽略。 */
function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  scope: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new TikTokContractError(`${scope} contains unknown field ${unknown}`);
  }
}

/** 读取非空字符串；不接受隐式类型转换。 */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new TikTokContractError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized;
}

/** 读取有界整数；无值时返回默认值。 */
function integer(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
  allowNumericString = false,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed =
    allowNumericString &&
    typeof value === "string" &&
    /^-?\d+$/.test(value.trim())
      ? Number(value)
      : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new TikTokContractError(
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

/** 读取有数量和长度限制的字符串数组。 */
function stringList(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (value === undefined || value === null || value === "") return [];
  const source =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
  if (!source) throw new TikTokContractError(`${field} must be an array`);
  const result = source.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new TikTokContractError(`${field} must contain non-empty strings`);
    }
    const normalized = item.trim();
    if (normalized.length > maximumLength) {
      throw new TikTokContractError(
        `${field} items must not exceed ${maximumLength} UTF-16 units`,
      );
    }
    return normalized;
  });
  if (result.length > maximumItems) {
    throw new TikTokContractError(
      `${field} must not contain more than ${maximumItems} items`,
    );
  }
  return result;
}

/** 校验手机上的绝对媒体路径。 */
function androidPath(value: unknown, field: string): string {
  const normalized = optionalString(value, field);
  if (
    !normalized ||
    normalized.length > 1024 ||
    !ABSOLUTE_ANDROID_PATH_PATTERN.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new TikTokContractError(`${field} must be a safe absolute Android path`);
  }
  return normalized;
}

/** 从对象或旧查询参数读取同名字段。 */
function bodyOrQuery(
  body: Record<string, unknown>,
  query: TikTokLegacyQuery,
  key: string,
): unknown {
  return body[key] ?? query[key];
}

/** 判断请求是否使用 v2 嵌套字段。 */
function isCanonicalBody(body: Record<string, unknown>): boolean {
  return (
    body.contractVersion !== undefined ||
    body.action !== undefined ||
    body.media !== undefined ||
    body.content !== undefined ||
    body.policy !== undefined ||
    body.link !== undefined
  );
}

/** 规范化并校验账号断言。 */
function normalizeExpectedHandle(value: unknown): string | undefined {
  const input = optionalString(value, "expectedHandle")?.replace(/^@/, "");
  if (!input) return undefined;
  if (!HANDLE_PATTERN.test(input) || input.endsWith(".") || input.includes("..")) {
    throw new TikTokContractError("expectedHandle is not a valid TikTok handle");
  }
  return input;
}

/** 规范化发布幂等 ID。 */
function normalizePublicationId(
  value: unknown,
  action: TikTokAction,
): string {
  const input = optionalString(value, "publicationId");
  if (!input) {
    if (action === "publish" || action === "preflight") return randomUUID();
    throw new TikTokContractError(
      `publicationId is required when action is ${action}`,
    );
  }
  if (!UUID_PATTERN.test(input)) {
    throw new TikTokContractError("publicationId must be a UUID");
  }
  return input.toLowerCase();
}

/** 规范化 v2 文案对象。 */
function normalizeContent(value: unknown): TikTokContentContract {
  if (value !== undefined && !isRecord(value)) {
    throw new TikTokContractError("content must be an object");
  }
  const source = isRecord(value) ? value : {};
  assertKnownKeys(source, ["title", "details", "titles", "detailsPool"], "content");
  const title = optionalString(source.title, "content.title") ?? "";
  const details = optionalString(source.details, "content.details") ?? "";
  if (title.length > 90) {
    throw new TikTokContractError(
      "content.title must not exceed 90 UTF-16 units",
    );
  }
  if (details.length > 4000) {
    throw new TikTokContractError(
      "content.details must not exceed 4000 UTF-16 units",
    );
  }
  return {
    title,
    details,
    titles: stringList(source.titles, "content.titles", 20, 90),
    detailsPool: stringList(
      source.detailsPool,
      "content.detailsPool",
      20,
      4000,
    ),
  };
}

/** 规范化 v2 频率保护对象。 */
function normalizePolicy(value: unknown): TikTokPolicyContract {
  if (value !== undefined && !isRecord(value)) {
    throw new TikTokContractError("policy must be an object");
  }
  const source = isRecord(value) ? value : {};
  assertKnownKeys(
    source,
    [
      "minIntervalSeconds",
      "maxPostsPerDay",
      "materialReuseSeconds",
      "captionReuseSeconds",
    ],
    "policy",
  );
  return {
    minIntervalSeconds: integer(
      source.minIntervalSeconds,
      "policy.minIntervalSeconds",
      DEFAULT_POLICY.minIntervalSeconds,
      1,
      86400,
    ),
    maxPostsPerDay: integer(
      source.maxPostsPerDay,
      "policy.maxPostsPerDay",
      DEFAULT_POLICY.maxPostsPerDay,
      1,
      100,
    ),
    materialReuseSeconds: integer(
      source.materialReuseSeconds,
      "policy.materialReuseSeconds",
      DEFAULT_POLICY.materialReuseSeconds,
      0,
      2592000,
    ),
    captionReuseSeconds: integer(
      source.captionReuseSeconds,
      "policy.captionReuseSeconds",
      DEFAULT_POLICY.captionReuseSeconds,
      0,
      2592000,
    ),
  };
}

/** 规范化 v2 链接重试对象。 */
function normalizeLink(value: unknown): TikTokLinkContract {
  if (value !== undefined && !isRecord(value)) {
    throw new TikTokContractError("link must be an object");
  }
  const source = isRecord(value) ? value : {};
  assertKnownKeys(source, ["maxAttempts", "retrySeconds"], "link");
  return {
    maxAttempts: integer(
      source.maxAttempts,
      "link.maxAttempts",
      DEFAULT_LINK.maxAttempts,
      1,
      20,
    ),
    retrySeconds: integer(
      source.retrySeconds,
      "link.retrySeconds",
      DEFAULT_LINK.retrySeconds,
      2,
      60,
    ),
  };
}

/** 规范化 v2 媒体对象。 */
function normalizeMedia(value: unknown): TikTokMediaContract | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new TikTokContractError("media must be an object");
  assertKnownKeys(
    value,
    ["mode", "kind", "path", "paths", "directory"],
    "media",
  );
  const mode = optionalString(value.mode, "media.mode");
  if (mode !== "direct" && mode !== "pool") {
    throw new TikTokContractError("media.mode must be direct or pool");
  }
  const kind = optionalString(value.kind, "media.kind") as
    | TikTokMediaKind
    | undefined;
  if (!kind || !MEDIA_KINDS.has(kind) || (mode === "direct" && kind === "auto")) {
    throw new TikTokContractError(
      "media.kind must be image or video; pool also accepts auto",
    );
  }
  if (mode === "direct") {
    if (value.paths !== undefined || value.directory !== undefined) {
      throw new TikTokContractError(
        "direct media accepts path only, not paths or directory",
      );
    }
    return { mode, kind, path: androidPath(value.path, "media.path") };
  }
  if (value.path !== undefined) {
    throw new TikTokContractError("pool media does not accept path");
  }
  const paths =
    value.paths === undefined
      ? []
      : stringList(value.paths, "media.paths", 20, 1024).map((item) =>
          androidPath(item, "media.paths"),
        );
  const directory =
    value.directory === undefined
      ? undefined
      : androidPath(value.directory, "media.directory");
  if ((paths.length > 0) === Boolean(directory)) {
    throw new TikTokContractError(
      "pool media requires exactly one of paths or directory",
    );
  }
  return {
    mode,
    kind,
    ...(paths.length > 0 ? { paths } : {}),
    ...(directory ? { directory } : {}),
  };
}

/** 从旧版扁平字段生成 v2 媒体对象。 */
function normalizeLegacyMedia(
  body: Record<string, unknown>,
  query: TikTokLegacyQuery,
): TikTokMediaContract {
  const imagePath = optionalString(bodyOrQuery(body, query, "imagePath"), "imagePath");
  const videoPath = optionalString(bodyOrQuery(body, query, "videoPath"), "videoPath");
  const imagePaths = stringList(
    bodyOrQuery(body, query, "imagePaths"),
    "imagePaths",
    20,
    1024,
  );
  const videoPaths = stringList(
    bodyOrQuery(body, query, "videoPaths"),
    "videoPaths",
    20,
    1024,
  );
  const materialDir =
    optionalString(bodyOrQuery(body, query, "materialDir"), "materialDir") ??
    "/sdcard/DCIM/Camera";
  const direct = [imagePath, videoPath].filter(Boolean);
  const pooled = [...imagePaths, ...videoPaths];
  if (pooled.length > 20) {
    throw new TikTokContractError(
      "legacy imagePaths and videoPaths accept at most 20 items in total",
    );
  }
  if (direct.length > 1 || (direct.length > 0 && pooled.length > 0)) {
    throw new TikTokContractError(
      "legacy media fields must select one direct path or a path pool",
    );
  }
  if (direct.length === 1) {
    return {
      mode: "direct",
      kind: imagePath ? "image" : "video",
      path: androidPath(direct[0], imagePath ? "imagePath" : "videoPath"),
    };
  }
  if (pooled.length > 0) {
    return {
      mode: "pool",
      kind:
        imagePaths.length > 0 && videoPaths.length > 0
          ? "auto"
          : imagePaths.length > 0
            ? "image"
            : "video",
      paths: pooled.map((item) => androidPath(item, "media path")),
    };
  }
  return {
    mode: "pool",
    kind: "auto",
    directory: androidPath(materialDir, "materialDir"),
  };
}

/** 从旧版扁平请求构造 v2 参数。 */
function normalizeLegacyRequest(
  body: Record<string, unknown>,
  query: TikTokLegacyQuery,
): NormalizedTikTokRequest {
  const rawLinkOnly = bodyOrQuery(body, query, "linkOnly");
  if (
    rawLinkOnly !== undefined &&
    rawLinkOnly !== true &&
    rawLinkOnly !== false &&
    rawLinkOnly !== "true" &&
    rawLinkOnly !== "false"
  ) {
    throw new TikTokContractError("linkOnly must be a boolean");
  }
  const linkOnly = rawLinkOnly === true || rawLinkOnly === "true";
  const action: TikTokAction = linkOnly ? "recover" : "publish";
  const publicationId = normalizePublicationId(
    bodyOrQuery(body, query, "publicationId"),
    action,
  );
  const content = normalizeContent({
    title: bodyOrQuery(body, query, "title"),
    details: bodyOrQuery(body, query, "details"),
    titles: bodyOrQuery(body, query, "titles"),
    detailsPool: bodyOrQuery(body, query, "detailsPool"),
  });
  if (
    action === "publish" &&
    !content.title &&
    !content.details &&
    content.titles.length === 0 &&
    content.detailsPool.length === 0
  ) {
    throw new TikTokContractError(
      "at least one title or details value is required",
    );
  }
  return {
    timeoutSeconds: integer(
      bodyOrQuery(body, query, "timeout"),
      "timeout",
      420,
      120,
      600,
      true,
    ),
    params: {
      contractVersion: 2,
      action,
      publicationId,
      expectedHandle: normalizeExpectedHandle(
        bodyOrQuery(body, query, "expectedHandle"),
      ),
      ...(action === "publish" ? { media: normalizeLegacyMedia(body, query) } : {}),
      content,
      policy: {
        minIntervalSeconds: integer(
          bodyOrQuery(body, query, "minIntervalSeconds"),
          "minIntervalSeconds",
          DEFAULT_POLICY.minIntervalSeconds,
          0,
          86400,
          true,
        ),
        maxPostsPerDay: integer(
          bodyOrQuery(body, query, "maxPostsPerDay"),
          "maxPostsPerDay",
          DEFAULT_POLICY.maxPostsPerDay,
          1,
          100,
          true,
        ),
        materialReuseSeconds: DEFAULT_POLICY.materialReuseSeconds,
        captionReuseSeconds: DEFAULT_POLICY.captionReuseSeconds,
      },
      link: {
        maxAttempts: integer(
          bodyOrQuery(body, query, "linkMaxAttempts"),
          "linkMaxAttempts",
          DEFAULT_LINK.maxAttempts,
          1,
          20,
          true,
        ),
        retrySeconds: integer(
          bodyOrQuery(body, query, "linkRetrySeconds"),
          "linkRetrySeconds",
          DEFAULT_LINK.retrySeconds,
          2,
          60,
          true,
        ),
      },
    },
  };
}

/**
 * 将 TikTok v2 或兼容旧版输入归一化为唯一的手机任务契约。
 *
 * @param input JSON 请求体；无请求体时可传 undefined。
 * @param query 旧版查询参数。
 * @returns 可直接下发到 `tiktok.post` 的参数和任务超时。
 */
export function normalizeTikTokRequest(
  input: unknown,
  query: TikTokLegacyQuery = {},
): NormalizedTikTokRequest {
  if (input !== undefined && !isRecord(input)) {
    throw new TikTokContractError("request body must be a JSON object");
  }
  const body = isRecord(input) ? input : {};
  if (!isCanonicalBody(body)) return normalizeLegacyRequest(body, query);
  if (body.contractVersion !== 2) {
    throw new TikTokContractError("contractVersion must be 2");
  }
  assertKnownKeys(
    body,
    [
      "contractVersion",
      "action",
      "publicationId",
      "expectedHandle",
      "media",
      "content",
      "policy",
      "link",
      "timeout",
    ],
    "request",
  );
  const actionValue = optionalString(body.action, "action");
  if (!actionValue) {
    throw new TikTokContractError("action is required for contractVersion 2");
  }
  if (!ACTIONS.has(actionValue as TikTokAction)) {
    throw new TikTokContractError(
      "action must be publish, preflight, recover, or status",
    );
  }
  const action = actionValue as TikTokAction;
  const publicationId = normalizePublicationId(body.publicationId, action);
  const media = normalizeMedia(body.media);
  const content = normalizeContent(body.content);
  if (action === "publish" && !media) {
    throw new TikTokContractError("media is required when action is publish");
  }
  if (
    action === "publish" &&
    !content.title &&
    !content.details &&
    content.titles.length === 0 &&
    content.detailsPool.length === 0
  ) {
    throw new TikTokContractError(
      "content requires at least one title or details value when publishing",
    );
  }
  const policy = normalizePolicy(body.policy);
  const link = normalizeLink(body.link);
  if (media?.kind === "video") {
    const titleCandidates = [content.title, ...content.titles].filter(Boolean);
    const detailsCandidates = [content.details, ...content.detailsPool].filter(
      Boolean,
    );
    const captions = (titleCandidates.length > 0 ? titleCandidates : [""]).flatMap(
      (title) =>
        (detailsCandidates.length > 0 ? detailsCandidates : [""]).map((details) =>
        [title, details].filter(Boolean).join("\n\n"),
      ),
    );
    if (captions.some((caption) => caption.length > 2200)) {
      throw new TikTokContractError(
        "combined video caption must not exceed 2200 UTF-16 units",
      );
    }
  }
  return {
    timeoutSeconds: integer(body.timeout, "timeout", 420, 120, 600),
    params: {
      contractVersion: 2,
      action,
      publicationId,
      expectedHandle: normalizeExpectedHandle(body.expectedHandle),
      ...(media ? { media } : {}),
      content,
      policy,
      link,
    },
  };
}
