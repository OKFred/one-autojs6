import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { TikTokConfig } from "./config.js";
import { isRecord } from "./protocol.js";
import {
  TikTokLedger,
  type TikTokLedgerCaption,
  type TikTokLedgerMedia,
  type TikTokPublicationPhase,
  type TikTokPublicationRecord,
} from "./tiktok-ledger.js";

/** TikTok 任务动作。 */
export type TikTokAction = "publish" | "preflight" | "recover" | "status";

/** TikTok 媒体类型。 */
export type TikTokMediaKind = "image" | "video";

/** 最终生效的本机发布保护策略。 */
export interface EffectiveTikTokPolicy {
  minIntervalSeconds: number;
  maxPostsPerDay: number;
  materialReuseSeconds: number;
  captionReuseSeconds: number;
}

/** 规范化后的素材来源。 */
export interface NormalizedTikTokMedia {
  mode: "direct" | "pool";
  kind?: TikTokMediaKind;
  paths: string[];
  directories: string[];
}

/** 规范化后的 TikTok v2 请求。 */
export interface NormalizedTikTokRequest {
  contractVersion: 2;
  legacy: boolean;
  action: TikTokAction;
  publicationId: string;
  expectedHandle?: string;
  warnings: string[];
  media?: NormalizedTikTokMedia;
  content: {
    titles: string[];
    details: string[];
  };
  policy: EffectiveTikTokPolicy;
  link: {
    maxAttempts: number;
    retrySeconds: number;
  };
}

/** 已读取并计算内容指纹的媒体候选。 */
export interface TikTokMediaCandidate extends TikTokLedgerMedia {
  mtimeMs: number;
}

/** 可选择的标题与详情组合。 */
export interface TikTokCaptionCandidate extends TikTokLedgerCaption {}

/** 发布保护校验结果。 */
export interface TikTokPolicyCheck {
  ok: boolean;
  code?: "POST_COOLDOWN" | "DAILY_POST_LIMIT";
  retryAt?: number;
}

/** Mobile 客户端执行 TikTok 前得到的决策。 */
export interface PreparedTikTokTask {
  request: NormalizedTikTokRequest;
  ledger: TikTokLedger;
  decision:
    | "PREFLIGHT"
    | "NEW"
    | "RESUME"
    | "RECOVER"
    | "CACHED"
    | "STATUS";
  publication?: TikTokPublicationRecord;
  scriptParams: Record<string, unknown> | null;
}

/** TikTok 准备流程的可注入依赖。 */
export interface PrepareTikTokOptions {
  stateDirectory: string;
  now?: number;
  randomPublicationId?: () => string;
}

/** 旧公共发布历史迁移结果。 */
export interface LegacyTikTokImportResult {
  imported: boolean;
  materialFingerprints: number;
  captionFingerprints: number;
}

/** 发布流程保存给补链动作的最小恢复上下文。 */
export interface TikTokPublicationCheckpoint {
  baselinePostIds?: string[];
  baselineTileCount?: number;
  postId?: string;
  postUrl?: string;
  canonicalUrl?: string;
  shareUrl?: string;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);
const MAX_MEDIA_CANDIDATES = 20;
const PHASE_ORDER: Record<TikTokPublicationPhase, number> = {
  PRECHECKED: 0,
  EDITOR_READY: 1,
  COMMITTING: 2,
  SUBMITTED: 3,
  POST_CONFIRMED: 4,
  LINK_CONFIRMED: 5,
};

/** 计算稳定的 SHA-256 十六进制摘要。 */
export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * 使用固定大小缓冲区计算文件 SHA-256，并拒绝哈希期间发生变化的文件。
 *
 * @param filePath 本地媒体路径。
 * @returns 十六进制 SHA-256。
 */
export function sha256File(filePath: string): string {
  const before = fs.statSync(filePath);
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const after = fs.statSync(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("MEDIA_CHANGED_DURING_HASH");
  }
  return hash.digest("hex");
}

/** 标准化不带 @ 的 TikTok 用户名。 */
export function normalizeTikTokHandle(value: string): string {
  const handle = value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{2,24}$/.test(handle)) {
    throw new Error("INVALID_TIKTOK_HANDLE");
  }
  return handle.toLowerCase();
}

/** 从扩展名判断受支持的 TikTok 媒体类型。 */
export function detectTikTokMediaKind(filePath: string): TikTokMediaKind {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  throw new Error("UNSUPPORTED_MEDIA_TYPE");
}

/** 判断绝对路径是否位于任一允许的素材根目录中。 */
export function isPathWithinAllowedRoots(
  filePath: string,
  allowedRoots: readonly string[],
): boolean {
  if (filePath.includes("\0")) return false;
  const pathApi = filePath.startsWith("/") ? path.posix : path.win32;
  if (!pathApi.isAbsolute(filePath)) return false;
  const resolvedPath = pathApi.resolve(filePath);
  return allowedRoots.some((root) => {
    if (!pathApi.isAbsolute(root) || root.includes("\0")) return false;
    const resolvedRoot = pathApi.resolve(root);
    const relative = pathApi.relative(resolvedRoot, resolvedPath);
    return (
      relative === "" ||
      (!relative.startsWith(`..${pathApi.sep}`) && relative !== "..")
    );
  });
}

/** 将存在的允许根目录解析为真实路径，兼容 Android 的 /sdcard 系统别名。 */
function resolveAllowedRoots(allowedRoots: readonly string[]): string[] {
  return allowedRoots.map((root) => {
    try {
      return fs.realpathSync(root).replace(/\\/g, "/");
    } catch {
      return root;
    }
  });
}

/** 读取有限非负整数；非法值抛出稳定错误。 */
function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`INVALID_${field.toUpperCase()}`);
  }
  return value;
}

/** 读取可选字符串数组并执行去重。 */
function optionalStrings(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`INVALID_${field.toUpperCase()}`);
  }
  const result = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (result.length > maximum) throw new Error(`TOO_MANY_${field.toUpperCase()}`);
  return result;
}

/** 拒绝 v2 对象中的未知字段，避免拼写错误被静默忽略。 */
function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  scope: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`UNKNOWN_${scope.toUpperCase()}_FIELD:${unknown}`);
}

/** 读取可选非空字符串。 */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`INVALID_${field.toUpperCase()}`);
  const normalized = value.trim();
  return normalized || undefined;
}

/** 合并本机策略和只能收紧限制的远程策略。 */
export function tightenTikTokPolicy(
  local: TikTokConfig,
  remote: unknown,
  legacy = false,
): EffectiveTikTokPolicy {
  if (remote !== undefined && !isRecord(remote)) {
    throw new Error("INVALID_POLICY");
  }
  const value = isRecord(remote) ? remote : {};
  assertKnownKeys(
    value,
    [
      "minIntervalSeconds",
      "maxPostsPerDay",
      "materialReuseSeconds",
      "captionReuseSeconds",
    ],
    "policy",
  );
  const minIntervalSeconds = optionalInteger(
    value.minIntervalSeconds,
    "minIntervalSeconds",
    legacy ? 0 : 1,
    86400,
  );
  const maxPostsPerDay = optionalInteger(
    value.maxPostsPerDay,
    "maxPostsPerDay",
    legacy ? 0 : 1,
    100,
  );
  const materialReuseSeconds = optionalInteger(
    value.materialReuseSeconds,
    "materialReuseSeconds",
    0,
    2592000,
  );
  const captionReuseSeconds = optionalInteger(
    value.captionReuseSeconds,
    "captionReuseSeconds",
    0,
    2592000,
  );
  return {
    minIntervalSeconds: Math.max(
      local.minIntervalSeconds,
      minIntervalSeconds ?? local.minIntervalSeconds,
    ),
    maxPostsPerDay:
      maxPostsPerDay && maxPostsPerDay > 0
        ? Math.min(local.maxPostsPerDay, maxPostsPerDay)
        : local.maxPostsPerDay,
    materialReuseSeconds: Math.max(
      local.materialReuseSeconds,
      materialReuseSeconds ?? local.materialReuseSeconds,
    ),
    captionReuseSeconds: Math.max(
      local.captionReuseSeconds,
      captionReuseSeconds ?? local.captionReuseSeconds,
    ),
  };
}

/** 将媒体对象规范化为候选路径和目录。 */
function normalizeV2Media(
  value: unknown,
  allowedRoots: readonly string[],
): NormalizedTikTokMedia | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("INVALID_MEDIA");
  assertKnownKeys(
    value,
    ["mode", "kind", "path", "paths", "directory", "directories"],
    "media",
  );
  if (value.mode !== "direct" && value.mode !== "pool") {
    throw new Error("INVALID_MEDIA_MODE");
  }
  const kind =
    value.kind === "image" || value.kind === "video" ? value.kind : undefined;
  const automaticKind = value.kind === "auto" && value.mode === "pool";
  if (value.kind !== undefined && !kind && !automaticKind) {
    throw new Error("INVALID_MEDIA_KIND");
  }
  const paths = optionalStrings(value.paths, "media.paths", MAX_MEDIA_CANDIDATES);
  const directPath = optionalString(value.path, "media.path");
  if (directPath) paths.unshift(directPath);
  const directories = optionalStrings(
    value.directories,
    "media.directories",
    MAX_MEDIA_CANDIDATES,
  );
  const directory = optionalString(value.directory, "media.directory");
  if (directory) directories.unshift(directory);
  const uniquePaths = [...new Set(paths)];
  const uniqueDirectories = [...new Set(directories)];
  if (value.mode === "direct" && (uniquePaths.length !== 1 || uniqueDirectories.length)) {
    throw new Error("DIRECT_MEDIA_REQUIRES_ONE_PATH");
  }
  if (value.mode === "pool" && !uniquePaths.length && !uniqueDirectories.length) {
    throw new Error("EMPTY_MEDIA_POOL");
  }
  if (uniquePaths.length + uniqueDirectories.length > MAX_MEDIA_CANDIDATES) {
    throw new Error("TOO_MANY_MEDIA_CANDIDATES");
  }
  for (const candidate of [...uniquePaths, ...uniqueDirectories]) {
    if (!isPathWithinAllowedRoots(candidate, allowedRoots)) {
      throw new Error("MEDIA_PATH_NOT_ALLOWED");
    }
  }
  for (const candidate of uniquePaths) {
    const detected = detectTikTokMediaKind(candidate);
    if (kind && detected !== kind) throw new Error("MEDIA_KIND_MISMATCH");
  }
  return {
    mode: value.mode,
    kind,
    paths: uniquePaths,
    directories: uniqueDirectories,
  };
}

/** 将旧版扁平媒体字段映射为 v2 媒体池。 */
function normalizeLegacyMedia(
  value: Record<string, unknown>,
  allowedRoots: readonly string[],
): NormalizedTikTokMedia | undefined {
  const imagePath = optionalString(value.imagePath, "imagePath");
  const videoPath = optionalString(value.videoPath, "videoPath");
  if (imagePath && videoPath) throw new Error("MULTIPLE_DIRECT_MEDIA");
  const directPath = imagePath ?? videoPath;
  if (directPath) {
    return normalizeV2Media(
      {
        mode: "direct",
        path: directPath,
        kind: imagePath ? "image" : "video",
      },
      allowedRoots,
    );
  }
  const paths = [
    ...optionalStrings(value.imagePaths, "imagePaths"),
    ...optionalStrings(value.videoPaths, "videoPaths"),
  ];
  const directory = optionalString(value.materialDir, "materialDir");
  if (!paths.length && !directory) return undefined;
  return normalizeV2Media(
    { mode: "pool", paths, directory },
    allowedRoots,
  );
}

/** 规范化并校验标题、详情候选池。 */
function normalizeContent(
  value: Record<string, unknown>,
  legacy: boolean,
): NormalizedTikTokRequest["content"] {
  const content = legacy
    ? value
    : isRecord(value.content)
      ? value.content
      : {};
  if (!legacy && value.content !== undefined && !isRecord(value.content)) {
    throw new Error("INVALID_CONTENT");
  }
  if (!legacy) {
    assertKnownKeys(
      content,
      ["title", "details", "titles", "detailsPool"],
      "content",
    );
  }
  const titles = optionalStrings(content.titles, "titles", 20);
  const details = optionalStrings(content.detailsPool, "detailsPool", 20);
  const title = optionalString(content.title, "title");
  const detail = optionalString(content.details, "details");
  if (title) titles.push(title);
  if (detail) details.push(detail);
  const uniqueTitles = [...new Set(titles)];
  const uniqueDetails = [...new Set(details)];
  if (uniqueTitles.length > 20 || uniqueDetails.length > 20) {
    throw new Error("CAPTION_POOL_TOO_LARGE");
  }
  if (uniqueTitles.some((item) => item.length > 90)) {
    throw new Error("TITLE_TOO_LONG");
  }
  if (uniqueDetails.some((item) => item.length > 4000)) {
    throw new Error("DETAILS_TOO_LONG");
  }
  return { titles: uniqueTitles, details: uniqueDetails };
}

/**
 * 将 v2 或旧版扁平 TikTok 参数规范化为本机可信契约。
 *
 * @param input 原始任务参数。
 * @param config 本机 TikTok 策略。
 * @param randomPublicationId 可注入的发布 ID 生成器。
 * @returns 规范化请求。
 */
export function normalizeTikTokRequest(
  input: unknown,
  config: TikTokConfig,
  randomPublicationId: () => string = crypto.randomUUID,
): NormalizedTikTokRequest {
  if (!isRecord(input)) throw new Error("INVALID_TIKTOK_REQUEST");
  const legacy = input.contractVersion === undefined;
  if (!legacy && input.contractVersion !== 2) {
    throw new Error("UNSUPPORTED_TIKTOK_CONTRACT");
  }
  if (!legacy) {
    assertKnownKeys(
      input,
      [
        "contractVersion",
        "action",
        "publicationId",
        "expectedHandle",
        "media",
        "content",
        "policy",
        "link",
      ],
      "request",
    );
  }
  let action: TikTokAction = "publish";
  if (legacy && input.linkOnly === true) action = "recover";
  if (!legacy && input.action !== undefined) {
    if (!['publish', 'preflight', 'recover', 'status'].includes(String(input.action))) {
      throw new Error("INVALID_TIKTOK_ACTION");
    }
    action = input.action as TikTokAction;
  }
  const suppliedPublicationId = optionalString(
    input.publicationId,
    "publicationId",
  );
  if ((action === "recover" || action === "status") && !suppliedPublicationId) {
    throw new Error("PUBLICATION_ID_REQUIRED");
  }
  const publicationId = suppliedPublicationId ?? randomPublicationId();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(publicationId)) {
    throw new Error("INVALID_PUBLICATION_ID");
  }
  const configuredHandle = config.expectedHandle
    ? normalizeTikTokHandle(config.expectedHandle)
    : undefined;
  const assertedHandle = optionalString(input.expectedHandle, "expectedHandle");
  if (assertedHandle && configuredHandle) {
    if (normalizeTikTokHandle(assertedHandle) !== configuredHandle) {
      throw new Error("EXPECTED_ACCOUNT_MISMATCH");
    }
  }
  const effectiveHandle = configuredHandle ??
    (assertedHandle ? normalizeTikTokHandle(assertedHandle) : undefined);
  if (
    !legacy &&
    (action === "publish" || action === "recover") &&
    !effectiveHandle
  ) {
    throw new Error("EXPECTED_HANDLE_REQUIRED");
  }
  const media = legacy
    ? normalizeLegacyMedia(input, config.allowedMaterialRoots)
    : normalizeV2Media(input.media, config.allowedMaterialRoots);
  if (action === "publish" && !media) throw new Error("MEDIA_REQUIRED");
  const content = normalizeContent(input, legacy);
  if (action === "publish" && !content.titles.length && !content.details.length) {
    throw new Error("CAPTION_REQUIRED");
  }
  const remotePolicy = legacy
    ? {
        minIntervalSeconds: input.minIntervalSeconds,
        maxPostsPerDay: input.maxPostsPerDay,
        materialReuseSeconds: input.materialReuseSeconds,
        captionReuseSeconds: input.captionReuseSeconds,
      }
    : input.policy;
  const policy = tightenTikTokPolicy(config, remotePolicy, legacy);
  const linkValue = !legacy && isRecord(input.link) ? input.link : input;
  if (!legacy && input.link !== undefined && !isRecord(input.link)) {
    throw new Error("INVALID_LINK_POLICY");
  }
  if (!legacy && isRecord(input.link)) {
    assertKnownKeys(input.link, ["maxAttempts", "retrySeconds"], "link");
  }
  const maxAttempts = optionalInteger(
    legacy ? linkValue.linkMaxAttempts : linkValue.maxAttempts,
    "link.maxAttempts",
    1,
    20,
  );
  const retrySeconds = optionalInteger(
    legacy ? linkValue.linkRetrySeconds : linkValue.retrySeconds,
    "link.retrySeconds",
    2,
    120,
  );
  return {
    contractVersion: 2,
    legacy,
    action,
    publicationId,
    expectedHandle: effectiveHandle,
    warnings:
      legacy && action === "publish" && !effectiveHandle
        ? ["LEGACY_EXPECTED_HANDLE_MISSING"]
        : [],
    media,
    content,
    policy,
    link: {
      maxAttempts: maxAttempts ?? 8,
      retrySeconds: retrySeconds ?? 15,
    },
  };
}

/** 读取、校验并计算全部媒体候选的内容指纹。 */
export function inspectMediaCandidates(
  media: NormalizedTikTokMedia,
  allowedRoots: readonly string[],
): TikTokMediaCandidate[] {
  const resolvedAllowedRoots = resolveAllowedRoots(allowedRoots);
  const discovered = [...media.paths];
  for (const directory of media.directories) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error("MEDIA_DIRECTORY_NOT_FOUND");
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const entryPath = path.posix.join(directory, entry.name);
      try {
        detectTikTokMediaKind(entryPath);
        discovered.push(entryPath);
      } catch {
        // 素材目录允许存在说明文件等非媒体文件。
      }
    }
  }
  const unique = [...new Set(discovered)].slice(0, MAX_MEDIA_CANDIDATES + 1);
  if (unique.length > MAX_MEDIA_CANDIDATES) {
    throw new Error("TOO_MANY_MEDIA_CANDIDATES");
  }
  const candidates: TikTokMediaCandidate[] = [];
  const seenFingerprints = new Set<string>();
  for (const filePath of unique) {
    if (!isPathWithinAllowedRoots(filePath, allowedRoots)) {
      throw new Error("MEDIA_PATH_NOT_ALLOWED");
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    const realPath = fs.realpathSync(filePath).replace(/\\/g, "/");
    if (!isPathWithinAllowedRoots(realPath, resolvedAllowedRoots)) {
      throw new Error("MEDIA_SYMLINK_NOT_ALLOWED");
    }
    const kind = detectTikTokMediaKind(realPath);
    if (media.kind && media.kind !== kind) continue;
    const stat = fs.statSync(realPath);
    if (stat.size <= 0) continue;
    const fingerprint = sha256File(realPath);
    if (seenFingerprints.has(fingerprint)) continue;
    seenFingerprints.add(fingerprint);
    candidates.push({
      path: realPath,
      kind,
      fingerprint,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  if (!candidates.length) throw new Error("NO_USABLE_MEDIA");
  return candidates;
}

/**
 * 将旧公共状态安全迁移为仅用于防重复的非可信指纹历史。
 *
 * 旧记录中的作品 URL、账号和 publicationId 均不会导入。私有账本成功落盘后，
 * 才删除公共状态文件，避免敏感文案继续留在共享存储。
 *
 * @param ledger 私有 TikTok 账本。
 * @param legacyStatePath 旧公共 JSON 文件路径。
 * @param allowedRoots 本机允许的素材根目录。
 * @param now 当前时间戳。
 * @returns 实际导入数量。
 */
export function importLegacyTikTokState(
  ledger: TikTokLedger,
  legacyStatePath: string,
  allowedRoots: readonly string[],
  now = Date.now(),
): LegacyTikTokImportResult {
  const resolvedAllowedRoots = resolveAllowedRoots(allowedRoots);
  if (!fs.existsSync(legacyStatePath)) {
    return { imported: false, materialFingerprints: 0, captionFingerprints: 0 };
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(legacyStatePath, "utf8"));
  } catch {
    throw new Error("LEGACY_TIKTOK_STATE_INVALID");
  }
  if (!isRecord(value)) throw new Error("LEGACY_TIKTOK_STATE_INVALID");
  const materialUses: Record<string, number> = {};
  const captionUses: Record<string, number> = {};
  if (isRecord(value.materialUses)) {
    for (const [mediaPath, timestamp] of Object.entries(value.materialUses)) {
      if (
        typeof timestamp !== "number" ||
        !Number.isFinite(timestamp) ||
        !isPathWithinAllowedRoots(mediaPath, allowedRoots) ||
        !fs.existsSync(mediaPath) ||
        !fs.statSync(mediaPath).isFile()
      ) {
        continue;
      }
      const realPath = fs.realpathSync(mediaPath).replace(/\\/g, "/");
      if (!isPathWithinAllowedRoots(realPath, resolvedAllowedRoots)) continue;
      const fingerprint = sha256File(realPath);
      materialUses[fingerprint] = Math.max(materialUses[fingerprint] ?? 0, timestamp);
    }
  }
  if (isRecord(value.captionUses)) {
    for (const [serializedCaption, timestamp] of Object.entries(value.captionUses)) {
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
      try {
        const captionValue: unknown = JSON.parse(serializedCaption);
        if (!isRecord(captionValue)) continue;
        const title = typeof captionValue.title === "string" ? captionValue.title : "";
        const details =
          typeof captionValue.details === "string" ? captionValue.details : "";
        const fingerprint = sha256(JSON.stringify({ title, details }));
        captionUses[fingerprint] = Math.max(captionUses[fingerprint] ?? 0, timestamp);
      } catch {
        // 单条旧文案损坏时忽略，不影响其余安全历史的迁移。
      }
    }
  }
  ledger.importLegacyUnverified(materialUses, captionUses, now);
  fs.unlinkSync(legacyStatePath);
  return {
    imported: true,
    materialFingerprints: Object.keys(materialUses).length,
    captionFingerprints: Object.keys(captionUses).length,
  };
}

/** 构造并校验全部标题与详情组合。 */
export function buildCaptionCandidates(
  content: NormalizedTikTokRequest["content"],
  mediaKinds: readonly TikTokMediaKind[],
): TikTokCaptionCandidate[] {
  const titles = content.titles.length ? content.titles : [""];
  const details = content.details.length ? content.details : [""];
  const result: TikTokCaptionCandidate[] = [];
  const seen = new Set<string>();
  for (const title of titles) {
    for (const detail of details) {
      const caption = title && detail ? `${title}\n${detail}` : title || detail;
      if (!caption) continue;
      if (mediaKinds.includes("video") && caption.length > 2200) {
        throw new Error("VIDEO_CAPTION_TOO_LONG");
      }
      const fingerprint = sha256(JSON.stringify({ title, details: detail }));
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      result.push({ title, details: detail, caption, fingerprint });
    }
  }
  if (!result.length) throw new Error("CAPTION_REQUIRED");
  return result;
}

/** 根据使用时间选择最久未使用的素材。 */
export function selectMediaCandidate(
  candidates: readonly TikTokMediaCandidate[],
  uses: Readonly<Record<string, number>>,
  reuseSeconds: number,
  now: number,
): TikTokMediaCandidate {
  const eligible = candidates.filter(
    (candidate) => now - (uses[candidate.fingerprint] ?? 0) >= reuseSeconds * 1000,
  );
  if (!eligible.length) throw new Error("MATERIAL_REUSE_COOLDOWN");
  return [...eligible].sort((left, right) => {
    const usedDifference =
      (uses[left.fingerprint] ?? 0) - (uses[right.fingerprint] ?? 0);
    return usedDifference || left.fingerprint.localeCompare(right.fingerprint);
  })[0];
}

/** 根据使用时间选择最久未使用的文案。 */
export function selectCaptionCombination(
  candidates: readonly TikTokCaptionCandidate[],
  uses: Readonly<Record<string, number>>,
  reuseSeconds: number,
  now: number,
): TikTokCaptionCandidate {
  const eligible = candidates.filter(
    (candidate) => now - (uses[candidate.fingerprint] ?? 0) >= reuseSeconds * 1000,
  );
  if (!eligible.length) throw new Error("CAPTION_REUSE_COOLDOWN");
  return [...eligible].sort((left, right) => {
    const usedDifference =
      (uses[left.fingerprint] ?? 0) - (uses[right.fingerprint] ?? 0);
    return usedDifference || left.fingerprint.localeCompare(right.fingerprint);
  })[0];
}

/** 检查全局发布间隔和单日本地上限。 */
export function evaluatePostingPolicy(
  publications: readonly TikTokPublicationRecord[],
  policy: EffectiveTikTokPolicy,
  now: number,
): TikTokPolicyCheck {
  const committed = publications.filter(
    (record) => PHASE_ORDER[record.phase] >= PHASE_ORDER.COMMITTING,
  );
  const lastSubmittedAt = Math.max(
    0,
    ...committed.map(
      (record) => record.committedAt ?? record.submittedAt ?? record.updatedAt,
    ),
  );
  const intervalRetryAt = lastSubmittedAt + policy.minIntervalSeconds * 1000;
  if (lastSubmittedAt && now < intervalRetryAt) {
    return { ok: false, code: "POST_COOLDOWN", retryAt: intervalRetryAt };
  }
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const todayCount = committed.filter(
    (record) =>
      (record.committedAt ?? record.submittedAt ?? record.updatedAt) >=
      startOfDay.getTime(),
  ).length;
  if (todayCount >= policy.maxPostsPerDay) {
    const nextDay = new Date(startOfDay);
    nextDay.setDate(nextDay.getDate() + 1);
    return { ok: false, code: "DAILY_POST_LIMIT", retryAt: nextDay.getTime() };
  }
  return { ok: true };
}

/** 为 AutoJS 执行脚本生成兼容旧字段的受控参数。 */
function buildScriptParams(
  request: NormalizedTikTokRequest,
  publication?: TikTokPublicationRecord,
): Record<string, unknown> {
  const record = publication;
  return {
    contractVersion: 2,
    action: request.action,
    publicationId: request.publicationId,
    expectedHandle: request.expectedHandle,
    linkOnly: request.action === "recover",
    ...(record?.media.kind === "image" ? { imagePath: record.media.path } : {}),
    ...(record?.media.kind === "video" ? { videoPath: record.media.path } : {}),
    title: record?.caption.title ?? request.content.titles[0] ?? "",
    details: record?.caption.details ?? request.content.details[0] ?? "",
    minIntervalSeconds: request.policy.minIntervalSeconds,
    maxPostsPerDay: request.policy.maxPostsPerDay,
    materialReuseSeconds: request.policy.materialReuseSeconds,
    captionReuseSeconds: request.policy.captionReuseSeconds,
    linkMaxAttempts: request.link.maxAttempts,
    linkRetrySeconds: request.link.retrySeconds,
    ...(request.action === "recover" && record
      ? {
          recoveryContext: {
            publicationId: record.publicationId,
            title: record.caption.title,
            details: record.caption.details,
            caption: record.caption.caption,
            mediaType: record.media.kind,
            baselinePostIds: record.baselinePostIds ?? [],
            baselineTileCount: record.baselineTileCount,
            postId: record.postId,
            canonicalUrl: record.canonicalUrl,
          },
        }
      : {}),
  };
}

/**
 * 执行媒体预检、策略选择与发布幂等决策。
 *
 * @param input 原始 TikTok 参数。
 * @param config 本机 TikTok 配置。
 * @param options 状态目录、当前时间和可注入 ID 生成器。
 * @returns 客户端可直接执行或短路返回的决策。
 */
export function prepareTikTokTask(
  input: unknown,
  config: TikTokConfig,
  options: PrepareTikTokOptions,
): PreparedTikTokTask {
  const now = options.now ?? Date.now();
  const request = normalizeTikTokRequest(
    input,
    config,
    options.randomPublicationId,
  );
  const ledger = new TikTokLedger(options.stateDirectory);
  if (request.action === "status") {
    const publication = ledger.get(request.publicationId);
    if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
    return { request, ledger, decision: "STATUS", publication, scriptParams: null };
  }
  if (request.action === "recover") {
    const publication = ledger.get(request.publicationId);
    if (!publication) throw new Error("PUBLICATION_NOT_FOUND");
    if (publication.account !== request.expectedHandle) {
      throw new Error("EXPECTED_ACCOUNT_MISMATCH");
    }
    return {
      request,
      ledger,
      decision: publication.phase === "LINK_CONFIRMED" ? "CACHED" : "RECOVER",
      publication,
      scriptParams:
        publication.phase === "LINK_CONFIRMED"
          ? null
          : buildScriptParams(request, publication),
    };
  }

  const candidates = request.media
    ? inspectMediaCandidates(request.media, config.allowedMaterialRoots)
    : [];
  if (
    request.action === "preflight" &&
    !request.content.titles.length &&
    !request.content.details.length
  ) {
    return {
      request,
      ledger,
      decision: "PREFLIGHT",
      scriptParams: buildScriptParams(request),
    };
  }
  const captionCandidates = buildCaptionCandidates(
    request.content,
    candidates.map((candidate) => candidate.kind),
  );
  const snapshot = ledger.snapshot();
  const requestFingerprint = sha256(
    JSON.stringify({
      account: request.expectedHandle,
      media: candidates.map((candidate) => candidate.fingerprint).sort(),
      captions: captionCandidates.map((candidate) => candidate.fingerprint).sort(),
    }),
  );
  const existing = ledger.get(request.publicationId);
  if (request.action === "publish" && existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new Error("PUBLICATION_ID_CONFLICT");
    }
    let decision: PreparedTikTokTask["decision"] = "RESUME";
    if (existing.phase === "LINK_CONFIRMED") decision = "CACHED";
    else if (PHASE_ORDER[existing.phase] >= PHASE_ORDER.COMMITTING) {
      decision = "RECOVER";
    }
    const executionRequest =
      decision === "RECOVER" ? { ...request, action: "recover" as const } : request;
    return {
      request: executionRequest,
      ledger,
      decision,
      publication: existing,
      scriptParams:
        decision === "CACHED" ? null : buildScriptParams(executionRequest, existing),
    };
  }
  if (request.action === "publish") {
    const policyCheck = evaluatePostingPolicy(
      Object.values(snapshot.publications),
      request.policy,
      now,
    );
    if (!policyCheck.ok) {
      throw new Error(`${policyCheck.code}:${policyCheck.retryAt}`);
    }
  }
  const media = candidates.length
    ? selectMediaCandidate(
        candidates,
        snapshot.materialUses,
        request.policy.materialReuseSeconds,
        now,
      )
    : undefined;
  const caption = selectCaptionCombination(
    captionCandidates,
    snapshot.captionUses,
    request.policy.captionReuseSeconds,
    now,
  );
  if (request.action === "preflight") {
    const scriptParams = buildScriptParams(request);
    if (media) {
      if (media.kind === "image") scriptParams.imagePath = media.path;
      else scriptParams.videoPath = media.path;
    }
    scriptParams.title = caption.title;
    scriptParams.details = caption.details;
    return { request, ledger, decision: "PREFLIGHT", scriptParams };
  }
  if (!media) throw new Error("MEDIA_REQUIRED");
  const begin = ledger.begin(
    {
      publicationId: request.publicationId,
      requestFingerprint,
      account: request.expectedHandle ?? "LEGACY_UNVERIFIED",
      media,
      caption,
    },
    now,
  );
  let decision: PreparedTikTokTask["decision"] = begin.created ? "NEW" : "RESUME";
  if (begin.record.phase === "LINK_CONFIRMED") decision = "CACHED";
  else if (PHASE_ORDER[begin.record.phase] >= PHASE_ORDER.COMMITTING) {
    decision = "RECOVER";
  }
  const executionRequest =
    decision === "RECOVER" ? { ...request, action: "recover" as const } : request;
  return {
    request: executionRequest,
    ledger,
    decision,
    publication: begin.record,
    scriptParams:
      decision === "CACHED" ? null : buildScriptParams(executionRequest, begin.record),
  };
}

/** 单调推进准备结果对应的账本阶段。 */
export function markTikTokPublicationPhase(
  prepared: PreparedTikTokTask,
  phase: TikTokPublicationPhase,
  now = Date.now(),
): TikTokPublicationRecord {
  const patch =
    phase === "COMMITTING" || phase === "SUBMITTED"
      ? ({ outcome: "PENDING", errorCode: undefined } as const)
      : {};
  return prepared.ledger.advance(
    prepared.request.publicationId,
    phase,
    patch,
    now,
  );
}

/**
 * 保存补链所需的基线作品 ID 和已解析链接，不推进执行阶段。
 *
 * @param prepared 执行前准备结果。
 * @param checkpoint 待保存的恢复上下文。
 * @param now 当前时间戳。
 * @returns 更新后的发布记录。
 */
export function applyTikTokPublicationCheckpoint(
  prepared: PreparedTikTokTask,
  checkpoint: TikTokPublicationCheckpoint,
  now = Date.now(),
): TikTokPublicationRecord {
  const baselinePostIds = checkpoint.baselinePostIds
    ? [...new Set(checkpoint.baselinePostIds)].filter((value) => /^\d{1,32}$/.test(value))
    : undefined;
  const postId =
    checkpoint.postId && /^\d{1,32}$/.test(checkpoint.postId)
      ? checkpoint.postId
      : undefined;
  const patch: TikTokPublicationCheckpoint = {};
  if (baselinePostIds !== undefined) patch.baselinePostIds = baselinePostIds;
  if (
    checkpoint.baselineTileCount !== undefined &&
    Number.isInteger(checkpoint.baselineTileCount) &&
    checkpoint.baselineTileCount >= 0 &&
    checkpoint.baselineTileCount <= 9
  ) {
    patch.baselineTileCount = checkpoint.baselineTileCount;
  }
  if (postId !== undefined) patch.postId = postId;
  if (checkpoint.postUrl !== undefined) patch.postUrl = checkpoint.postUrl;
  if (checkpoint.canonicalUrl !== undefined) {
    patch.canonicalUrl = checkpoint.canonicalUrl;
  }
  if (checkpoint.shareUrl !== undefined) patch.shareUrl = checkpoint.shareUrl;
  return prepared.ledger.checkpoint(
    prepared.request.publicationId,
    patch,
    now,
  );
}

/** 从有效 TikTok 作品链接提取作品 ID。 */
function postIdFromUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!/(^|\.)tiktok\.com$/i.test(parsed.hostname)) return undefined;
    return parsed.pathname.match(/\/(?:video|photo)\/(\d+)/)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * 将 AutoJS 最终结果安全归并到 TikTok 发布账本。
 *
 * @param prepared 执行前准备结果。
 * @param result AutoJS 返回的未知 JSON 值。
 * @param now 当前时间戳。
 * @returns 最新发布记录；纯预检没有账本记录时返回 undefined。
 */
export function applyTikTokScriptResult(
  prepared: PreparedTikTokTask,
  result: unknown,
  now = Date.now(),
): TikTokPublicationRecord | undefined {
  if (!prepared.publication || prepared.request.action === "preflight") {
    return prepared.publication;
  }
  if (!isRecord(result)) {
    return prepared.ledger.setOutcome(
      prepared.request.publicationId,
      "PUBLISH_OUTCOME_UNKNOWN",
      "INVALID_SCRIPT_RESULT",
      now,
    );
  }
  if (Array.isArray(result.baselinePostIds)) {
    applyTikTokPublicationCheckpoint(
      prepared,
      {
        baselinePostIds: result.baselinePostIds.filter(
          (value): value is string => typeof value === "string",
        ),
        baselineTileCount:
          typeof result.baselineTileCount === "number"
            ? result.baselineTileCount
            : undefined,
      },
      now,
    );
  }
  const published = result.published === true;
  const canonicalUrl =
    typeof result.canonicalUrl === "string" ? result.canonicalUrl : "";
  const shareUrl = typeof result.shareUrl === "string" ? result.shareUrl : "";
  const postUrl =
    canonicalUrl || (typeof result.postUrl === "string" ? result.postUrl : "");
  const postId = postIdFromUrl(postUrl);
  if (published && postId) {
    return prepared.ledger.advance(
      prepared.request.publicationId,
      "LINK_CONFIRMED",
      {
        outcome: "SUCCESS",
        publishedAt: now,
        postUrl,
        canonicalUrl: canonicalUrl || postUrl,
        shareUrl: shareUrl || undefined,
        postId,
        errorCode: undefined,
      },
      now,
    );
  }
  if (published) {
    return prepared.ledger.advance(
      prepared.request.publicationId,
      "POST_CONFIRMED",
      {
        outcome: "PUBLISHED_LINK_PENDING",
        publishedAt: now,
        errorCode: "PUBLISHED_LINK_PENDING",
      },
      now,
    );
  }
  const current = prepared.ledger.get(prepared.request.publicationId);
  const nestedError = isRecord(result.error) ? result.error : undefined;
  const code =
    typeof result.code === "string"
      ? result.code
      : typeof nestedError?.code === "string"
        ? nestedError.code
        : typeof result.error === "string"
          ? "TIKTOK_SCRIPT_FAILURE"
        : "UNKNOWN_TIKTOK_FAILURE";
  if (current && PHASE_ORDER[current.phase] >= PHASE_ORDER.COMMITTING) {
    return prepared.ledger.setOutcome(
      prepared.request.publicationId,
      "PUBLISH_OUTCOME_UNKNOWN",
      code,
      now,
    );
  }
  return prepared.ledger.setOutcome(
    prepared.request.publicationId,
    "FAILURE",
    code,
    now,
  );
}
