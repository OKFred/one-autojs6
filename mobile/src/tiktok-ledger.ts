import fs from "node:fs";
import path from "node:path";

/** TikTok 发布的不可逆执行阶段。 */
export type TikTokPublicationPhase =
  | "PRECHECKED"
  | "EDITOR_READY"
  | "COMMITTING"
  | "SUBMITTED"
  | "POST_CONFIRMED"
  | "LINK_CONFIRMED";

/** TikTok 发布的业务结果。 */
export type TikTokPublicationOutcome =
  | "PENDING"
  | "SUCCESS"
  | "FAILURE"
  | "PUBLISHED_LINK_PENDING"
  | "PUBLISH_OUTCOME_UNKNOWN";

/** 发布账本中的媒体快照。 */
export interface TikTokLedgerMedia {
  path: string;
  kind: "image" | "video";
  fingerprint: string;
  size: number;
}

/** 发布账本中的文案快照。 */
export interface TikTokLedgerCaption {
  title: string;
  details: string;
  caption: string;
  fingerprint: string;
}

/** 单次 TikTok 发布的持久记录。 */
export interface TikTokPublicationRecord {
  publicationId: string;
  requestFingerprint: string;
  account: string;
  phase: TikTokPublicationPhase;
  outcome: TikTokPublicationOutcome;
  media: TikTokLedgerMedia;
  caption: TikTokLedgerCaption;
  createdAt: number;
  updatedAt: number;
  committedAt?: number;
  submittedAt?: number;
  publishedAt?: number;
  baselinePostIds?: string[];
  baselineTileCount?: number;
  postUrl?: string;
  canonicalUrl?: string;
  shareUrl?: string;
  postId?: string;
  errorCode?: string;
}

/** 新建发布账本记录所需的稳定字段。 */
export interface NewTikTokPublication {
  publicationId: string;
  requestFingerprint: string;
  account: string;
  media: TikTokLedgerMedia;
  caption: TikTokLedgerCaption;
}

/** TikTok 发布账本的磁盘结构。 */
export interface TikTokLedgerState {
  version: 1;
  publications: Record<string, TikTokPublicationRecord>;
  materialUses: Record<string, number>;
  captionUses: Record<string, number>;
  legacyImport?: {
    status: "LEGACY_UNVERIFIED";
    importedAt: number;
  };
}

const PHASE_ORDER: Record<TikTokPublicationPhase, number> = {
  PRECHECKED: 0,
  EDITOR_READY: 1,
  COMMITTING: 2,
  SUBMITTED: 3,
  POST_CONFIRMED: 4,
  LINK_CONFIRMED: 5,
};

/** 创建空账本。 */
function emptyState(): TikTokLedgerState {
  return {
    version: 1,
    publications: {},
    materialUses: {},
    captionUses: {},
  };
}

/** 判断未知值是否为可读取的账本。 */
function isLedgerState(value: unknown): value is TikTokLedgerState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<TikTokLedgerState>;
  return (
    candidate.version === 1 &&
    Boolean(candidate.publications) &&
    typeof candidate.publications === "object" &&
    Boolean(candidate.materialUses) &&
    typeof candidate.materialUses === "object" &&
    Boolean(candidate.captionUses) &&
    typeof candidate.captionUses === "object"
  );
}

/** 解析单个账本文件；无效文件返回空值。 */
function readState(filePath: string): TikTokLedgerState | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isLedgerState(value) ? value : null;
  } catch {
    return null;
  }
}

/** 将内容写入临时文件并原子替换目标文件。 */
function atomicWrite(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Android 文件系统可能不支持 POSIX 权限，原子写入仍应继续。
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Android 文件系统可能不支持 POSIX 权限。
  }
}

/** 管理 Termux 私有目录中的 TikTok 发布幂等账本。 */
export class TikTokLedger {
  readonly filePath: string;
  readonly backupPath: string;
  private state: TikTokLedgerState;

  /**
   * 打开指定状态目录中的 TikTok 账本。
   *
   * @param stateDirectory Mobile 私有状态根目录。
   */
  constructor(stateDirectory: string) {
    this.filePath = path.join(stateDirectory, "tiktok", "publications.json");
    this.backupPath = `${this.filePath}.bak`;
    this.state =
      readState(this.filePath) ?? readState(this.backupPath) ?? emptyState();
  }

  /**
   * 返回账本的不可变快照。
   *
   * @returns 深复制后的账本。
   */
  snapshot(): TikTokLedgerState {
    return structuredClone(this.state);
  }

  /**
   * 按发布 ID 查询记录。
   *
   * @param publicationId 发布幂等 ID。
   * @returns 记录副本；不存在时返回 undefined。
   */
  get(publicationId: string): TikTokPublicationRecord | undefined {
    const record = this.state.publications[publicationId];
    return record ? structuredClone(record) : undefined;
  }

  /**
   * 新建 PRECHECKED 记录，或返回相同请求的已有记录。
   *
   * @param input 稳定发布字段。
   * @param now 当前时间戳。
   * @returns 记录与是否新建。
   */
  begin(
    input: NewTikTokPublication,
    now = Date.now(),
  ): { record: TikTokPublicationRecord; created: boolean } {
    const existing = this.state.publications[input.publicationId];
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new Error("PUBLICATION_ID_CONFLICT");
      }
      return { record: structuredClone(existing), created: false };
    }
    const record: TikTokPublicationRecord = {
      ...structuredClone(input),
      phase: "PRECHECKED",
      outcome: "PENDING",
      createdAt: now,
      updatedAt: now,
    };
    this.state.publications[input.publicationId] = record;
    this.persist();
    return { record: structuredClone(record), created: true };
  }

  /**
   * 单调推进一次发布的不可逆阶段。
   *
   * @param publicationId 发布幂等 ID。
   * @param phase 新阶段。
   * @param patch 同步更新的结果字段。
   * @param now 当前时间戳。
   * @returns 更新后的记录。
   */
  advance(
    publicationId: string,
    phase: TikTokPublicationPhase,
    patch: Partial<
      Pick<
        TikTokPublicationRecord,
        | "outcome"
        | "committedAt"
        | "submittedAt"
        | "publishedAt"
        | "baselinePostIds"
        | "baselineTileCount"
        | "postUrl"
        | "canonicalUrl"
        | "shareUrl"
        | "postId"
        | "errorCode"
      >
    > = {},
    now = Date.now(),
  ): TikTokPublicationRecord {
    const record = this.state.publications[publicationId];
    if (!record) throw new Error("PUBLICATION_NOT_FOUND");
    if (PHASE_ORDER[phase] < PHASE_ORDER[record.phase]) {
      throw new Error("PUBLICATION_PHASE_REGRESSION");
    }
    const firstCommit =
      PHASE_ORDER[record.phase] < PHASE_ORDER.COMMITTING &&
      PHASE_ORDER[phase] >= PHASE_ORDER.COMMITTING;
    const firstSubmission =
      PHASE_ORDER[record.phase] < PHASE_ORDER.SUBMITTED &&
      PHASE_ORDER[phase] >= PHASE_ORDER.SUBMITTED;
    record.phase = phase;
    record.updatedAt = now;
    Object.assign(record, patch);
    if (firstCommit) {
      record.committedAt = patch.committedAt ?? now;
      this.state.materialUses[record.media.fingerprint] = now;
      this.state.captionUses[record.caption.fingerprint] = now;
    }
    if (firstSubmission) {
      record.submittedAt = patch.submittedAt ?? now;
    }
    this.persist();
    return structuredClone(record);
  }

  /**
   * 在不推进阶段时更新失败或未知结果。
   *
   * @param publicationId 发布幂等 ID。
   * @param outcome 业务结果。
   * @param errorCode 稳定错误码。
   * @param now 当前时间戳。
   * @returns 更新后的记录。
   */
  setOutcome(
    publicationId: string,
    outcome: TikTokPublicationOutcome,
    errorCode?: string,
    now = Date.now(),
  ): TikTokPublicationRecord {
    const record = this.state.publications[publicationId];
    if (!record) throw new Error("PUBLICATION_NOT_FOUND");
    record.outcome = outcome;
    record.errorCode = errorCode;
    record.updatedAt = now;
    this.persist();
    return structuredClone(record);
  }

  /**
   * 保存发布前后采集的恢复上下文，不改变当前阶段。
   *
   * @param publicationId 发布幂等 ID。
   * @param patch 可验证的恢复字段。
   * @param now 当前时间戳。
   * @returns 更新后的记录。
   */
  checkpoint(
    publicationId: string,
    patch: Partial<
      Pick<
        TikTokPublicationRecord,
        | "baselinePostIds"
        | "baselineTileCount"
        | "postId"
        | "postUrl"
        | "canonicalUrl"
        | "shareUrl"
      >
    >,
    now = Date.now(),
  ): TikTokPublicationRecord {
    const record = this.state.publications[publicationId];
    if (!record) throw new Error("PUBLICATION_NOT_FOUND");
    Object.assign(record, structuredClone(patch));
    record.updatedAt = now;
    this.persist();
    return structuredClone(record);
  }

  /**
   * 合并旧公共状态中的非可信复用时间，不导入作品链接或发布身份。
   *
   * @param materialUses 内容指纹到最后使用时间。
   * @param captionUses 文案指纹到最后使用时间。
   * @param now 导入时间。
   */
  importLegacyUnverified(
    materialUses: Readonly<Record<string, number>>,
    captionUses: Readonly<Record<string, number>>,
    now = Date.now(),
  ): void {
    if (this.state.legacyImport) return;
    for (const [fingerprint, usedAt] of Object.entries(materialUses)) {
      if (!/^[a-f0-9]{64}$/.test(fingerprint) || !Number.isFinite(usedAt)) continue;
      this.state.materialUses[fingerprint] = Math.max(
        this.state.materialUses[fingerprint] ?? 0,
        usedAt,
      );
    }
    for (const [fingerprint, usedAt] of Object.entries(captionUses)) {
      if (!/^[a-f0-9]{64}$/.test(fingerprint) || !Number.isFinite(usedAt)) continue;
      this.state.captionUses[fingerprint] = Math.max(
        this.state.captionUses[fingerprint] ?? 0,
        usedAt,
      );
    }
    this.state.legacyImport = {
      status: "LEGACY_UNVERIFIED",
      importedAt: now,
    };
    this.persist();
  }

  /** 将当前状态持久化，并保留上一份可恢复备份。 */
  private persist(): void {
    if (fs.existsSync(this.filePath)) {
      const current = fs.readFileSync(this.filePath, "utf8");
      if (readState(this.filePath)) atomicWrite(this.backupPath, current);
    }
    atomicWrite(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}
