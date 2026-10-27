import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { normalizeTikTokRequest } from "./tiktok-contract.js";

/** A complete creative, reviewed as one indivisible unit. All records stay private. */
export interface CampaignCreative {
  publicationId: string;
  sku: string;
  videoPath: string;
  devicePath: string;
  sha256: string;
  title: string;
  caption: string;
  landingUrl: string;
  sourceVerifiedAt: string;
  sourceEvidenceSha256: string;
  scheduledAt: string;
  postSettings: { audience: "PUBLIC"; commercialDisclosure: "YOUR_BRAND" };
}

/** Versioned, frozen single-account pilot manifest. */
export interface CampaignManifest {
  schemaVersion: 1;
  campaignId: string;
  expectedHandle: string;
  deviceClientId: string;
  timezone: "Asia/Shanghai";
  creatives: CampaignCreative[];
}

/** Explicit human approval binds every byte of the manifest, including slots. */
export interface CampaignApproval {
  manifestSha256: string;
  reviewer: string;
  approvedAt: string;
}

/** Private durable dispatch record. Unknown delivery is never retried as publish. */
export interface CampaignEntry {
  publicationId: string;
  manifestSha256: string;
  state: "DISPATCHING" | "ACCEPTED" | "HOLD" | "REVIEW_REQUIRED" | "PUBLIC_ACCEPTED" | "MISSED";
  attemptedAt: string;
  taskId?: string;
  canonicalUrl?: string;
  reason?: string;
  publicAcceptance?: { reviewer: string; verifiedAt: string; evidenceSha256: string };
  recoveryTasks?: { taskId: string; action: "status" | "recover"; at: string }[];
}

/** One explicit operator action, separate from the immutable first attempt. */
export interface KnownPrecommitResume {
  publicationId: string;
  statusTaskId: string;
  operatorActionId: string;
  reviewer: string;
  authorizationEvidenceSha256: string;
  originalHoldSnapshotFile: string;
  originalHoldSnapshotSha256: string;
}

/** One additional explicitly authorized correction of a proven pre-checkpoint ambiguity. */
export interface KnownPrecommitAmbiguityContinuation extends KnownPrecommitResume {
  previousResumeSnapshotFile: string;
  previousResumeChainSha256: string;
}

/** A durable, bounded same-publication continuation; never scheduled automatically. */
export interface CampaignResumeAttempt extends KnownPrecommitResume {
  schemaVersion: 1 | 2;
  manifestSha256: string;
  attemptedAt: string;
  state: "DISPATCHING" | "ACCEPTED" | "HOLD";
  originalTaskId: string;
  originalHeldEntry: CampaignEntry;
  originalTask: Awaited<ReturnType<CampaignTransport["inspect"]>>;
  nativeStatusTask: Awaited<ReturnType<CampaignTransport["inspect"]>>;
  originalTaskEvidenceSha256: string;
  nativeStatusEvidenceSha256: string;
  requestFingerprint: string;
  previousResumeSnapshotFile?: string;
  previousResumeChainSha256?: string;
  precedingResumeTaskId?: string;
  failedResumeTask?: Awaited<ReturnType<CampaignTransport["inspect"]>>;
  failedResumeTaskEvidenceSha256?: string;
  taskId?: string;
  reason?: string;
  transitions: Array<{ state: "DISPATCHING" | "ACCEPTED" | "HOLD"; at: string }>;
}

/** Transport keeps the existing asynchronous v2 task channel intact. */
export interface CampaignTransport {
  /**
   * Dispatch through the existing asynchronous task channel.
   * @param params Approved v2 task parameters.
   * @param clientId Pinned device identity.
   * @returns Existing service task receipt.
   */
  dispatch(params: Record<string, unknown>, clientId: string): Promise<{ taskId: string }>;
  /**
   * Inspect an original asynchronous task receipt.
   * @param taskId Existing task identity.
   * @returns Task identity, timing and optional result evidence.
   */
  inspect(taskId: string): Promise<{ status: string; clientId: string; scriptId: string | null; createTimeUtc: number; result?: unknown }>;
}

/**
 * Reject invalid input without leaking account or creative content.
 * @param condition Required invariant.
 * @param message Safe failure description.
 * @returns After validation; throws when the invariant fails.
 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Encode stable JSON for review binding, independent of object key order.
 * @param value Complete manifest value.
 * @returns Canonical JSON representation.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash the complete approved object, including unknown future fields.
 * @param manifest Complete private review manifest.
 * @returns Lowercase SHA-256 digest.
 */
export function manifestDigest(manifest: CampaignManifest): string {
  return createHash("sha256").update(canonical(manifest)).digest("hex");
}

/**
 * Read bounded private JSON or a supplied default for a missing record.
 * @param filename Private record path.
 * @param fallback Optional default for an absent record.
 * @returns Parsed record or its supplied default.
 */
async function readJson<T>(filename: string, fallback?: T): Promise<T> {
  try {
    const stat = await fs.stat(filename);
    assert(stat.size <= 1024 * 1024, "Private record exceeds size limit");
    return JSON.parse(await fs.readFile(filename, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

/**
 * Flush a private record before atomic replacement.
 * @param filename Private record destination.
 * @param value Complete replacement value.
 * @returns Completion of the durable record update.
 */
async function writeJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${process.pid}.tmp`;
  const file = await fs.open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await fs.rename(temporary, filename);
}

/**
 * Validate a bounded three-creative pilot and the agreed Shanghai schedule.
 * @param manifest Private campaign manifest to validate.
 * @returns After validation; throws for an invalid campaign.
 */
export function validateCampaign(manifest: CampaignManifest): void {
  assert(manifest.schemaVersion === 1 && manifest.timezone === "Asia/Shanghai", "Unsupported campaign schema/timezone");
  assert(/^[a-zA-Z0-9._-]{1,80}$/.test(manifest.campaignId), "Invalid campaign ID");
  assert(/^[a-zA-Z0-9._]{2,24}$/.test(manifest.expectedHandle), "A pinned account is required");
  assert(/^[a-zA-Z0-9._:-]{1,100}$/.test(manifest.deviceClientId), "A pinned device is required");
  assert(Array.isArray(manifest.creatives) && manifest.creatives.length === 3, "Pilot requires three complete creatives");
  const ids = new Set<string>();
  const skus = new Set<string>();
  const hashes = new Set<string>();
  let previous = 0;
  for (const creative of manifest.creatives) {
    assert(!ids.has(creative.publicationId) && !skus.has(creative.sku) && !hashes.has(creative.sha256), "Duplicate publication, style or video");
    ids.add(creative.publicationId); skus.add(creative.sku);
    hashes.add(creative.sha256);
    assert(/^SHUSHA-L\d{4}$/.test(creative.sku), "Invalid style identity");
    assert(/^[a-f0-9]{64}$/.test(creative.sha256) && /^[a-f0-9]{64}$/.test(creative.sourceEvidenceSha256), "Missing asset/source evidence hash");
    assert(path.isAbsolute(creative.videoPath) && creative.videoPath.toLowerCase().endsWith(".mp4"), "Expected a local MP4");
    assert(creative.devicePath.startsWith("/sdcard/Download/") && path.posix.normalize(creative.devicePath) === creative.devicePath && !/[\\\p{Cc}\p{Cf}]/u.test(creative.devicePath) && creative.devicePath.endsWith(`-${creative.sha256.slice(0, 16)}.mp4`), "Device asset name must bind the video hash");
    const destination = new URL(creative.landingUrl);
    assert(destination.origin === "https://shop.this-time.com" && destination.pathname === "/wholesale" && destination.searchParams.get("utm_source") === "tiktok", "Invalid wholesale campaign destination");
    const slot = Date.parse(creative.scheduledAt);
    assert(Number.isFinite(slot) && new Date(slot).toISOString().slice(11) === "13:00:00.000Z", "Slots must be 21:00 Asia/Shanghai");
    assert(!previous || slot - previous >= 2 * 86400000, "Pilot slots must be at least two days apart"); previous = slot;
    const verifiedAt = Date.parse(creative.sourceVerifiedAt);
    assert(Number.isFinite(verifiedAt) && verifiedAt <= slot, "Invalid source verification time");
    const normalized = normalizeTikTokRequest({ contractVersion: 2, action: "publish", publicationId: creative.publicationId,
      expectedHandle: manifest.expectedHandle, media: { mode: "direct", kind: "video", path: creative.devicePath, expectedSha256: creative.sha256 },
      content: { title: creative.title, details: creative.caption }, postSettings: creative.postSettings }, {}).params;
    assert(creative.publicationId === normalized.publicationId, "Canonical lowercase publication UUID required before review");
    assert(creative.title === normalized.content.title && creative.caption === normalized.content.details, "Reviewed title and caption must already be trimmed");
    assert(creative.postSettings?.audience === "PUBLIC" && creative.postSettings.commercialDisclosure === "YOUR_BRAND", "Commercial post settings required");
    assert(creative.title.length > 0 && creative.caption.length > 0, "A single reviewed caption is required");
  }
}

/** Return the Shanghai calendar day, independently of the host timezone.
 * @param value Valid date or timestamp.
 * @returns YYYY-MM-DD in the approved timezone.
 */
function shanghaiDay(value: Date | string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}

/** Compute the same frozen commercial fingerprint used by the native policy.
 * @param manifest Pinned campaign identity.
 * @param creative The exact approved creative.
 * @returns Native-compatible request fingerprint.
 */
function creativeFingerprint(manifest: CampaignManifest, creative: CampaignCreative): string {
  const caption = createHash("sha256").update(JSON.stringify({ title: creative.title, details: creative.caption })).digest("hex");
  return createHash("sha256").update(JSON.stringify({ account: manifest.expectedHandle, media: [creative.sha256], captions: [caption], expectedSha256: creative.sha256, postSettings: creative.postSettings })).digest("hex");
}

/** Recognize only the known editor failure before any commit or settings proof.
 * @param task Authenticated original task or fresh native ledger-status task.
 * @param action Expected original action.
 * @param manifest Pinned campaign.
 * @param creative Exact approved creative.
 * @param minimumTime Earliest permissible task creation time.
 * @param now Current operator time.
 * @param expectedError One exact failure supported by its separately invoked operator action.
 * @returns Checked evidence; never inferred from an empty URL alone.
 */
function knownPrecommitEvidence(task: Awaited<ReturnType<CampaignTransport["inspect"]>>, action: "publish" | "status", manifest: CampaignManifest, creative: CampaignCreative, minimumTime: number, now: number, expectedError: "EDITOR_NOT_READY" | "POST_SETTINGS_AMBIGUOUS" = "EDITOR_NOT_READY"): void {
  const result = task.result as Record<string, any> | undefined;
  assert(task.status === (action === "publish" ? "FAILURE" : "SUCCESS") && task.clientId === manifest.deviceClientId && task.scriptId === "tiktok.post" && Number.isFinite(task.createTimeUtc) && task.createTimeUtc >= minimumTime - 5000 && task.createTimeUtc <= now + 5000, "Original technical failure or native status task is not bound to this device");
  assert(result?.contractVersion === 2 && result.action === action && result.publicationId === creative.publicationId && ["PRECHECKED", "EDITOR_READY"].includes(result.phase) && result.outcome === "FAILURE" && result.published === false && result.success === false && result.retrySafe === true && result.nextAction === "publish", "Known precommit failure required; uncertain or committed outcomes cannot resume");
  assert(result.error?.code === expectedError && result.postSettingsEvidence === undefined && result.account?.verified === true && result.account.matched === true && result.postSettings?.audience === "PUBLIC" && result.postSettings.commercialDisclosure === "YOUR_BRAND", "Known editor failure without settings proof required");
  assert(result.post && result.post.verified === false && [result.post.shareUrl, result.post.canonicalUrl, result.post.postId, result.postUrl, result.canonicalUrl, result.shareUrl, result.postId].every(value => value === undefined || value === "") && [result.committedAt, result.submittedAt, result.publishedAt].every(value => value === undefined), "A publication or commit indicator blocks resume");
  const caption = createHash("sha256").update(JSON.stringify({ title: creative.title, details: creative.caption })).digest("hex");
  assert(result.media?.kind === "video" && result.creativeEvidence?.mediaSha256 === creative.sha256 && result.creativeEvidence.captionSha256 === caption && result.creativeEvidence.requestFingerprint === creativeFingerprint(manifest, creative), "Original creative or native request fingerprint changed");
}

/** Locked private campaign store. Locks are never force-removed or stolen. */
export class TikTokCampaign {
  /**
   * Bind one private campaign store to its existing transport.
   * @param directory Private campaign directory.
   * @param manifest Validated campaign manifest.
   * @param transport Existing asynchronous task transport.
   * @returns Campaign store instance.
   */
  private constructor(private directory: string, private manifest: CampaignManifest, private transport: CampaignTransport) {}

  /**
   * Open a private manifest without authorizing publication.
   * @param directory Private campaign directory.
   * @param transport Existing asynchronous task transport.
   * @returns Validated campaign store.
   */
  static async open(directory: string, transport: CampaignTransport): Promise<TikTokCampaign> {
    const manifest = await readJson<CampaignManifest>(path.join(directory, "manifest.json"));
    validateCampaign(manifest);
    return new TikTokCampaign(directory, manifest, transport);
  }

  /**
   * Serialize approval, dispatch and recovery with an exclusive process lock.
   * @param operation Bounded operation to perform while holding the lock.
   * @returns Operation result after releasing this process's lock.
   */
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const filename = path.join(this.directory, "campaign.lock");
    const lock = await fs.open(filename, "wx", 0o600);
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return await operation();
    } finally { await lock.close(); await fs.unlink(filename); }
  }

  /**
   * Re-read the manifest inside the lock to invalidate approval after edits.
   * @returns Current validated manifest digest.
   */
  private async refresh(): Promise<string> {
    this.manifest = await readJson<CampaignManifest>(path.join(this.directory, "manifest.json"));
    validateCampaign(this.manifest);
    return manifestDigest(this.manifest);
  }

  /**
   * Record approval only after merchant review of the matching preview.
   * @param expectedDigest Digest of the complete reviewed manifest.
   * @param reviewer Reviewing operator identifier.
   * @param now Approval timestamp.
   * @returns Completion of the private approval record.
   */
  async approve(expectedDigest: string, reviewer: string, now = new Date()): Promise<void> {
    await this.locked(async () => {
      const digest = await this.refresh();
      assert(expectedDigest === digest && reviewer.trim(), "Approval must match the reviewed manifest digest");
      const ledger = await this.entries();
      assert(ledger.every(e => e.state === "PUBLIC_ACCEPTED"), "Unresolved attempts or missed slots require review before approval");
      for (const c of this.manifest.creatives) await this.verifyVideo(c);
      await writeJson(path.join(this.directory, "approval.json"), { manifestSha256: digest, reviewer, approvedAt: now.toISOString() });
    });
  }

  /**
   * Read original dispatch records.
   * @returns Private campaign ledger entries.
   */
  private entries(): Promise<CampaignEntry[]> { return readJson(path.join(this.directory, "ledger.json"), []); }

  /** Read the separate durable resume chain without changing the first attempt.
   * @returns Recorded operator continuations, or no attempts.
   */
  private async resumeAttempts(): Promise<CampaignResumeAttempt[]> {
    const attempts = await readJson<CampaignResumeAttempt[]>(path.join(this.directory, "resume-attempts.json"), []);
    assert(Array.isArray(attempts) && attempts.every(attempt => [1, 2].includes(attempt.schemaVersion) && ["DISPATCHING", "ACCEPTED", "HOLD"].includes(attempt.state)), "Invalid resume attempt chain");
    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index];
      if (attempt.schemaVersion !== 2) continue;
      const preceding = attempts.slice(0, index).filter(value => value.publicationId === attempt.publicationId);
      assert(preceding.length === 1 && preceding[0].schemaVersion === 1 && preceding[0].state === "ACCEPTED" && preceding[0].taskId === attempt.precedingResumeTaskId && attempt.failedResumeTask && attempt.failedResumeTaskEvidenceSha256 === createHash("sha256").update(JSON.stringify(attempt.failedResumeTask)).digest("hex"), "Additional continuation has no immutable preceding failure");
      const previousRaw = await this.sealedResumeSnapshot(attempt.previousResumeSnapshotFile!, attempt.previousResumeChainSha256!);
      assert(JSON.stringify(JSON.parse(previousRaw.toString("utf8"))) === JSON.stringify(attempts.slice(0, index)), "Previous raw resume chain was replaced");
    }
    return attempts;
  }

  /** Read an explicitly sealed previous raw chain without following a link.
   * @param filename Private snapshot basename.
   * @param expectedSha256 Reviewed original-byte hash.
   * @returns Exact preserved bytes.
   */
  private async sealedResumeSnapshot(filename: string, expectedSha256: string): Promise<Buffer> {
    assert(/^[A-Za-z0-9._-]{1,120}\.json$/.test(filename || "") && /^[a-f0-9]{64}$/.test(expectedSha256 || ""), "Previous raw resume snapshot and SHA required");
    const filePath = path.join(this.directory, filename);
    assert(await fs.realpath(filePath) === filePath, "Previous resume snapshot cannot follow a link");
    const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat(); assert(stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024, "Previous resume snapshot bounds invalid");
      const raw = await file.readFile(); assert(raw.length === stat.size && createHash("sha256").update(raw).digest("hex") === expectedSha256, "Previous raw resume snapshot hash changed"); return raw;
    } finally { await file.close(); }
  }

  /** Select the current registered receipt without falling back to a stale first result.
   * @param entry Preserved original publication entry.
   * @returns Original, resumed, or later recovery receipt and its own dispatch time.
   */
  private async inspectionAttempt(entry: CampaignEntry): Promise<{ taskId: string; attemptedAt: string; publicationAttemptedAt: string }> {
    const resumes = (await this.resumeAttempts()).filter(attempt => attempt.publicationId === entry.publicationId);
    const resumed = resumes.at(-1);
    if (resumed) assert(resumed.manifestSha256 === entry.manifestSha256 && resumed.originalTaskId === entry.taskId && resumed.originalHeldEntry.publicationId === entry.publicationId && resumed.originalHeldEntry.taskId === entry.taskId && resumed.originalTaskEvidenceSha256 === createHash("sha256").update(JSON.stringify(resumed.originalTask)).digest("hex") && resumed.nativeStatusEvidenceSha256 === createHash("sha256").update(JSON.stringify(resumed.nativeStatusTask)).digest("hex"), "Original resume attempt chain changed");
    const publicationAttemptedAt = resumed?.attemptedAt || entry.attemptedAt;
    const minimum = Date.parse(publicationAttemptedAt);
    const recovery = entry.recoveryTasks?.filter(task => Date.parse(task.at) >= minimum).at(-1);
    if (recovery) return { taskId: recovery.taskId, attemptedAt: recovery.at, publicationAttemptedAt };
    if (resumed) {
      assert(resumed.state === "ACCEPTED" && resumed.taskId, "No resume receipt; query the original publication ID only");
      return { taskId: resumed.taskId, attemptedAt: resumed.attemptedAt, publicationAttemptedAt };
    }
    assert(entry.taskId, "No task receipt; use original-ID status/recovery");
    return { taskId: entry.taskId, attemptedAt: entry.attemptedAt, publicationAttemptedAt };
  }

  /** Continue one independently proven, known precommit failure under an explicit operator action.
   * @param request Original identity, registered fresh status receipt and private authorization evidence.
   * @param now Actual operator time; first dispatch must already have occurred in its approved minute.
   * @returns One asynchronous receipt state; an unknown delivery cannot be retried.
   */
  async resumeKnownPrecommit(request: KnownPrecommitResume, now = new Date()): Promise<string> {
    return this.performKnownPrecommitResume(request, now, false);
  }

  /** Allow exactly one additional, explicitly reviewed correction of a latest pre-checkpoint ambiguity.
   * @param request Fresh native status, authorization and sealed previous raw chain.
   * @param now Current same-day operator time.
   * @returns One asynchronous receipt state; never a scheduled or generic retry.
   */
  async continueKnownPrecommitAmbiguity(request: KnownPrecommitAmbiguityContinuation, now = new Date()): Promise<string> {
    return this.performKnownPrecommitResume(request, now, true);
  }

  /** Enforce common immutable first-attempt and explicit-action gates before one bounded dispatch.
   * @param request Explicit original or one additional correction request.
   * @param now Actual operator time.
   * @param ambiguityContinuation Whether only the proven ambiguity continuation is allowed.
   * @returns Durable asynchronous attempt state.
   */
  private async performKnownPrecommitResume(request: KnownPrecommitResume | KnownPrecommitAmbiguityContinuation, now: Date, ambiguityContinuation: boolean): Promise<string> {
    return this.locked(async () => {
      const digest = await this.refresh();
      const approval = await readJson<CampaignApproval>(path.join(this.directory, "approval.json"));
      const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
      assert(uuid.test(request.publicationId) && uuid.test(request.statusTaskId) && uuid.test(request.operatorActionId) && request.reviewer.trim() && request.reviewer.length <= 100 && !/[\p{Cc}\p{Cf}]/u.test(request.reviewer) && /^[a-f0-9]{64}$/.test(request.authorizationEvidenceSha256), "Explicit bounded operator action and authorization evidence required");
      assert(approval.manifestSha256 === digest && approval.reviewer && Date.parse(approval.approvedAt) <= now.getTime(), "Original approved campaign identity required");
      const entries = await this.entries(), entry = entries.find(value => value.publicationId === request.publicationId);
      const creative = this.manifest.creatives.find(value => value.publicationId === request.publicationId);
      assert(entry && creative && entry.state === "HOLD" && entry.taskId && uuid.test(entry.taskId) && entry.manifestSha256 === digest && !entry.canonicalUrl && entries.every(value => value.publicationId === entry.publicationId || value.state === "PUBLIC_ACCEPTED"), "Only the original held publication can continue");
      const firstAt = Date.parse(entry.attemptedAt), slot = Date.parse(creative.scheduledAt);
      assert(firstAt >= slot && firstAt < slot + 60000 && Date.parse(approval.approvedAt) <= firstAt && now.getTime() >= firstAt && shanghaiDay(now) === shanghaiDay(entry.attemptedAt), "Only the same-day attempt dispatched in its approved minute can resume");
      assert(entries.every(value => value.publicationId === entry.publicationId || shanghaiDay(value.attemptedAt) !== shanghaiDay(now)), "Another same-day publication blocks resume");
      const attempts = await this.resumeAttempts();
      assert(!attempts.some(attempt => attempt.operatorActionId === request.operatorActionId), "This explicit operator action already exists");
      const preceding = attempts.filter(attempt => attempt.publicationId === request.publicationId);
      let prior: CampaignResumeAttempt | undefined;
      if (ambiguityContinuation) {
        const continuation = request as KnownPrecommitAmbiguityContinuation;
        assert(preceding.length === 1 && preceding[0].schemaVersion === 1 && preceding[0].state === "ACCEPTED" && uuid.test(preceding[0].taskId || ""), "Only one additional proven ambiguity correction is allowed");
        prior = preceding[0];
        const previousRaw = await this.sealedResumeSnapshot(continuation.previousResumeSnapshotFile, continuation.previousResumeChainSha256);
        const actualRaw = await fs.readFile(path.join(this.directory, "resume-attempts.json"));
        assert(previousRaw.equals(actualRaw) && JSON.stringify(JSON.parse(previousRaw.toString("utf8"))) === JSON.stringify(attempts), "The exact previous raw resume chain must remain unchanged");
        assert(prior.manifestSha256 === digest && prior.originalTaskId === entry.taskId && prior.requestFingerprint === creativeFingerprint(this.manifest, creative) && prior.originalHeldEntry.publicationId === entry.publicationId && prior.originalHeldEntry.taskId === entry.taskId && shanghaiDay(prior.attemptedAt) === shanghaiDay(now), "Preceding resume identity changed");
        assert(prior.originalTaskEvidenceSha256 === createHash("sha256").update(JSON.stringify(prior.originalTask)).digest("hex") && prior.nativeStatusEvidenceSha256 === createHash("sha256").update(JSON.stringify(prior.nativeStatusTask)).digest("hex"), "Preceding resume proofs changed");
      } else assert(preceding.length === 0, "A bounded resume already exists; inspect the original publication instead");
      assert(/^[A-Za-z0-9._-]{1,120}\.json$/.test(request.originalHoldSnapshotFile) && /^[a-f0-9]{64}$/.test(request.originalHoldSnapshotSha256), "Original pre-status HOLD snapshot required");
      const snapshotPath = path.join(this.directory, request.originalHoldSnapshotFile);
      assert(await fs.realpath(snapshotPath) === snapshotPath, "Original HOLD snapshot cannot follow a link");
      const snapshotFile = await fs.open(snapshotPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let originalRaw: Buffer;
      try { const stat = await snapshotFile.stat(); assert(stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024, "Original HOLD snapshot bounds invalid"); originalRaw = await snapshotFile.readFile(); }
      finally { await snapshotFile.close(); }
      assert(createHash("sha256").update(originalRaw).digest("hex") === request.originalHoldSnapshotSha256, "Original HOLD snapshot hash changed");
      const originalEntries = JSON.parse(originalRaw.toString("utf8")) as CampaignEntry[];
      assert(Array.isArray(originalEntries), "Original HOLD snapshot context invalid");
      const originalEntry = originalEntries.find(value => value.publicationId === entry.publicationId);
      assert(originalEntries.length === entries.length && originalEntry?.state === "HOLD", "Original HOLD snapshot context invalid");
      /** Compare immutable entry fields while allowing only the registered status append. @param value Original entry. @returns Immutable fields. */
      const stripStatus = (value: CampaignEntry) => { const { recoveryTasks, reason, ...rest } = value; return rest; };
      assert(JSON.stringify(stripStatus(originalEntry)) === JSON.stringify(stripStatus(entry)) && originalEntries.every(value => value.publicationId === entry.publicationId || JSON.stringify(value) === JSON.stringify(entries.find(current => current.publicationId === value.publicationId))), "Original HOLD or another publication changed");
      const originalStatus = originalEntry.recoveryTasks || [], currentStatus = entry.recoveryTasks || [];
      if (prior) assert(originalStatus.some(value => value.taskId === prior!.statusTaskId && value.action === "status") && currentStatus.filter(value => Date.parse(value.at) >= Date.parse(prior!.attemptedAt)).every(value => value.action === "status"), "The additional correction must preserve the registered preceding status chain");
      assert(currentStatus.length > originalStatus.length && originalStatus.every((value, index) => JSON.stringify(value) === JSON.stringify(currentStatus[index])), "Original status history was replaced");
      const appended = currentStatus.slice(originalStatus.length), status = appended.at(-1)!;
      assert(appended.every(value => value.action === "status" && uuid.test(value.taskId) && Number.isFinite(Date.parse(value.at)) && Date.parse(value.at) >= firstAt && Date.parse(value.at) <= now.getTime() + 5000) && new Set(currentStatus.map(value => value.taskId)).size === currentStatus.length && status.taskId === request.statusTaskId && entry.reason === "Original-ID recovery pending", "Only a registered native status append can extend the original HOLD");
      assert(Date.parse(status.at) >= now.getTime() - 120000, "Fresh native ledger status required");
      const originalTask = await this.transport.inspect(entry.taskId);
      const nativeStatusTask = await this.transport.inspect(status.taskId);
      knownPrecommitEvidence(originalTask, "publish", this.manifest, creative, firstAt, now.getTime());
      let failedResumeTask: Awaited<ReturnType<CampaignTransport["inspect"]>> | undefined;
      let comparison = originalTask.result as Record<string, any>;
      if (prior) {
        assert(createHash("sha256").update(JSON.stringify(originalTask)).digest("hex") === prior.originalTaskEvidenceSha256 && Date.parse(status.at) > Date.parse(prior.attemptedAt), "Original failure or additional status chronology changed");
        failedResumeTask = await this.transport.inspect(prior.taskId!);
        knownPrecommitEvidence(failedResumeTask, "publish", this.manifest, creative, Date.parse(prior.attemptedAt), now.getTime(), "POST_SETTINGS_AMBIGUOUS");
        comparison = failedResumeTask.result as Record<string, any>;
        assert(comparison.phase === "PRECHECKED", "Only a pre-checkpoint ambiguity without settings proof can continue");
      }
      knownPrecommitEvidence(nativeStatusTask, "status", this.manifest, creative, Date.parse(status.at), now.getTime(), prior ? "POST_SETTINGS_AMBIGUOUS" : "EDITOR_NOT_READY");
      const nativeResult = nativeStatusTask.result as Record<string, any>;
      assert(nativeStatusTask.createTimeUtc >= now.getTime() - 120000 && nativeResult.phase === comparison.phase && nativeResult.error.code === comparison.error.code, "Fresh native ledger differs from the latest known failure");
      await this.verifyVideo(creative);
      const attempt: CampaignResumeAttempt = { schemaVersion: prior ? 2 : 1, ...request, manifestSha256: digest, attemptedAt: now.toISOString(), state: "DISPATCHING", originalTaskId: entry.taskId, originalHeldEntry: structuredClone(originalEntry), originalTask, nativeStatusTask, originalTaskEvidenceSha256: createHash("sha256").update(JSON.stringify(originalTask)).digest("hex"), nativeStatusEvidenceSha256: createHash("sha256").update(JSON.stringify(nativeStatusTask)).digest("hex"), requestFingerprint: creativeFingerprint(this.manifest, creative), transitions: [{ state: "DISPATCHING", at: now.toISOString() }] };
      if (prior) Object.assign(attempt, { precedingResumeTaskId: prior.taskId, failedResumeTask, failedResumeTaskEvidenceSha256: createHash("sha256").update(JSON.stringify(failedResumeTask)).digest("hex") });
      const previousPrefix = JSON.stringify(attempts);
      attempts.push(attempt); await writeJson(path.join(this.directory, "resume-attempts.json"), attempts);
      const params = normalizeTikTokRequest({ contractVersion: 2, action: "publish", publicationId: creative.publicationId, expectedHandle: this.manifest.expectedHandle, media: { mode: "direct", kind: "video", path: creative.devicePath, expectedSha256: creative.sha256 }, content: { title: creative.title, details: creative.caption }, postSettings: creative.postSettings, policy: { minIntervalSeconds: 86400, maxPostsPerDay: 1, materialReuseSeconds: 2592000, captionReuseSeconds: 2592000 } }, {}).params;
      try { const receipt = await this.transport.dispatch(params, this.manifest.deviceClientId); assert(uuid.test(receipt.taskId) && receipt.taskId !== entry.taskId && !attempts.some(value => value !== attempt && value.taskId === receipt.taskId) && !currentStatus.some(value => value.taskId === receipt.taskId), "Invalid bounded resume receipt"); attempt.taskId = receipt.taskId; attempt.state = "ACCEPTED"; }
      catch { attempt.state = "HOLD"; attempt.reason = "Resume delivery uncertain; query the original publication ID only"; }
      attempt.transitions.push({ state: attempt.state, at: now.toISOString() });
      assert(JSON.stringify(attempts.slice(0, -1)) === previousPrefix, "Existing resume records must never be rewritten");
      await writeJson(path.join(this.directory, "resume-attempts.json"), attempts);
      return attempt.state;
    });
  }

  /**
   * Hash the local video before dispatch without trusting its filename.
   * @param creative Complete approved creative.
   * @returns After exact-byte validation; throws if the video changed.
   */
  private async verifyVideo(creative: CampaignCreative): Promise<void> {
    const stat = await fs.stat(creative.videoPath);
    assert(stat.isFile() && stat.size > 0 && stat.size <= 200 * 1024 * 1024, "Invalid video size");
    const hash = createHash("sha256");
    const file = await fs.open(creative.videoPath, "r");
    try { for await (const chunk of file.createReadStream()) hash.update(chunk); }
    finally { await file.close(); }
    assert(hash.digest("hex") === creative.sha256, "Video changed after creative review");
  }

  /**
   * Run one scheduling pass without catch-up or another attempted publish.
   * @param now Current scheduling timestamp.
   * @param observedFirst Whether an operator is observing the first attempt.
   * @returns Scheduling or dispatch state.
   */
  async tick(now = new Date(), observedFirst = false): Promise<string> {
    return this.locked(async () => {
      const digest = await this.refresh();
      const approval = await readJson<CampaignApproval | null>(path.join(this.directory, "approval.json"), null);
      assert(approval && approval.manifestSha256 === digest && approval.reviewer && Date.parse(approval.approvedAt) <= now.getTime(), "Matching merchant approval required");
      const entries = await this.entries();
      if (entries.some(e => e.state !== "PUBLIC_ACCEPTED")) return "HOLD_EXISTING_ATTEMPT";
      const creative = this.manifest.creatives.find(c => !entries.some(e => e.publicationId === c.publicationId));
      if (!creative) return "COMPLETE";
      const difference = now.getTime() - Date.parse(creative.scheduledAt);
      if (difference < 0) return "NOT_DUE";
      if (difference >= 60000) {
        entries.push({ publicationId: creative.publicationId, manifestSha256: digest, state: "MISSED", attemptedAt: now.toISOString(), reason: "Slot missed; manual rescheduling requires a new review" });
        await writeJson(path.join(this.directory, "ledger.json"), entries); return "MISSED";
      }
      assert(entries.length > 0 || observedFirst, "First post requires an observing operator");
      assert(!entries.some(e => e.attemptedAt.slice(0, 10) === now.toISOString().slice(0, 10)), "Daily pilot limit reached");
      await this.verifyVideo(creative);
      const params = normalizeTikTokRequest({ contractVersion: 2, action: "publish", publicationId: creative.publicationId,
        expectedHandle: this.manifest.expectedHandle,
        media: { mode: "direct", kind: "video", path: creative.devicePath, expectedSha256: creative.sha256 },
        content: { title: creative.title, details: creative.caption }, postSettings: creative.postSettings,
        policy: { minIntervalSeconds: 86400, maxPostsPerDay: 1, materialReuseSeconds: 2592000, captionReuseSeconds: 2592000 } }, {}).params;
      const entry: CampaignEntry = { publicationId: creative.publicationId, manifestSha256: digest, state: "DISPATCHING", attemptedAt: now.toISOString() };
      entries.push(entry);
      await writeJson(path.join(this.directory, "ledger.json"), entries);
      try {
        const result = await this.transport.dispatch(params, this.manifest.deviceClientId);
        assert(typeof result.taskId === "string" && result.taskId.length > 0, "No task receipt");
        entry.taskId = result.taskId; entry.state = "ACCEPTED";
      } catch { entry.state = "HOLD"; entry.reason = "Delivery uncertain; query original publicationId only"; }
      await writeJson(path.join(this.directory, "ledger.json"), entries);
      return entry.state;
    });
  }

  /**
   * Queue status or recovery for the original ID without publishing.
   * @param publicationId Original attempted publication UUID.
   * @param action Read-only status or link-recovery action.
   * @param now Recovery request timestamp.
   * @returns Existing service receipt for the recovery task.
   */
  async recover(publicationId: string, action: "status" | "recover", now = new Date()): Promise<string> {
    assert(action === "status" || action === "recover", "Recovery can only query the original publication");
    return this.locked(async () => {
      const digest = await this.refresh();
      const entries = await this.entries(); const entry = entries.find(e => e.publicationId === publicationId);
      assert(entry && entry.state !== "MISSED" && entry.state !== "PUBLIC_ACCEPTED", "No recoverable original attempt");
      const approval = await readJson<CampaignApproval>(path.join(this.directory, "approval.json"));
      assert(entry.manifestSha256 === digest && approval.manifestSha256 === digest, "Original approved campaign identity required");
      const creative = this.manifest.creatives.find(c => c.publicationId === publicationId)!;
      const params = normalizeTikTokRequest({ contractVersion: 2, action, publicationId, expectedHandle: this.manifest.expectedHandle,
        media: { mode: "direct", kind: "video", path: creative.devicePath, expectedSha256: creative.sha256 },
        content: { title: creative.title, details: creative.caption }, postSettings: creative.postSettings }, {}).params;
      entry.state = "HOLD"; entry.reason = "Original-ID recovery pending";
      await writeJson(path.join(this.directory, "ledger.json"), entries);
      const task = await this.transport.dispatch(params, this.manifest.deviceClientId);
      (entry.recoveryTasks ??= []).push({ taskId: task.taskId, action, at: now.toISOString() });
      await writeJson(path.join(this.directory, "ledger.json"), entries);
      return task.taskId;
    });
  }

  /**
   * Inspect task evidence while retaining the independent public-review gate.
   * @param publicationId Original attempted publication UUID.
   * @param now Current inspection timestamp.
   * @returns Pending, held or public-review-required state.
   */
  async inspect(publicationId: string, now = new Date()): Promise<string> {
    return this.locked(async () => {
      const digest = await this.refresh();
      const entries = await this.entries(); const entry = entries.find(e => e.publicationId === publicationId);
      assert(entry && entry.state !== "MISSED" && entry.state !== "PUBLIC_ACCEPTED", "No pending original attempt");
      const approval = await readJson<CampaignApproval>(path.join(this.directory, "approval.json"));
      assert(entry.manifestSha256 === digest && approval.manifestSha256 === digest, "Original approved campaign identity required");
      const creative = this.manifest.creatives.find(c => c.publicationId === publicationId)!;
      const inspectedAttempt = await this.inspectionAttempt(entry);
      const task = await this.transport.inspect(inspectedAttempt.taskId);
      if (["PENDING", "EXECUTING", "RUNNING"].includes(task.status)) return "IN_PROGRESS";
      const result = task.result as Record<string, any> | undefined;
      const escaped = this.manifest.expectedHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const url = result?.post?.canonicalUrl;
      const proof = result?.postSettingsEvidence;
      const valid = task.status === "SUCCESS" && task.clientId === this.manifest.deviceClientId && task.scriptId === "tiktok.post" &&
        task.createTimeUtc >= Date.parse(inspectedAttempt.attemptedAt) - 5000 && task.createTimeUtc <= now.getTime() + 5000 && result?.contractVersion === 2 &&
        result.publicationId === publicationId && ["publish", "recover", "status"].includes(result.action) &&
        result.phase === "LINK_CONFIRMED" && result.outcome === "SUCCESS" && result.published === true && result.success === true &&
        result.post?.verified === true && typeof url === "string" && new RegExp(`^https://www\\.tiktok\\.com/@${escaped}/video/\\d+$`).test(url) &&
        url.endsWith(`/${result.post?.postId}`) && result.postSettings?.audience === "PUBLIC" && result.postSettings?.commercialDisclosure === "YOUR_BRAND" &&
        proof?.verified === true && proof.audience === "PUBLIC" && proof.commercialDisclosure === "YOUR_BRAND" &&
        Number.isSafeInteger(proof.verifiedAt) && proof.verifiedAt >= Date.parse(inspectedAttempt.publicationAttemptedAt) - 5000 && proof.verifiedAt <= now.getTime() + 5000 &&
        result.creativeEvidence?.mediaSha256 === creative.sha256 &&
        result.creativeEvidence?.captionSha256 === createHash("sha256").update(JSON.stringify({ title: creative.title, details: creative.caption })).digest("hex");
      entry.state = valid ? "REVIEW_REQUIRED" : "HOLD";
      entry.reason = valid ? "Independently verify public content, disclosure and visibility" : "Uncertain or unverified task outcome; do not republish";
      if (valid) entry.canonicalUrl = url;
      await writeJson(path.join(this.directory, "ledger.json"), entries);
      return entry.state;
    });
  }

  /**
   * Replan only never-dispatched slots and preserve the old plan and journal.
   * @param firstRemainingSlot New future Shanghai 21:00 slot in ISO format.
   * @param reviewer Reviewing operator identifier.
   * @param now Replanning timestamp.
   * @returns Completion of the journaled plan and approval invalidation.
   */
  async reschedule(firstRemainingSlot: string, reviewer: string, now = new Date()): Promise<void> {
    await this.locked(async () => {
      await this.refresh();
      const entries = await this.entries();
      assert(reviewer.trim() && entries.some(e => e.state === "MISSED") && entries.every(e => ["MISSED", "PUBLIC_ACCEPTED"].includes(e.state)), "Only missed, never-dispatched slots may be replanned");
      const start = Date.parse(firstRemainingSlot);
      assert(start > now.getTime(), "Replanned slots must be in the future");
      const original = structuredClone(this.manifest);
      const approval = await readJson<CampaignApproval | null>(path.join(this.directory, "approval.json"), null);
      let offset = 0;
      for (const creative of this.manifest.creatives) {
        if (!entries.some(e => e.publicationId === creative.publicationId && e.state === "PUBLIC_ACCEPTED")) {
          creative.scheduledAt = new Date(start + offset++ * 2 * 86400000).toISOString();
        }
      }
      validateCampaign(this.manifest);
      const history = await readJson<unknown[]>(path.join(this.directory, "reschedule-journal.json"), []);
      history.push({ reviewer, at: now.toISOString(), originalManifest: original, originalApproval: approval, originalLedger: entries, nextManifestSha256: manifestDigest(this.manifest) });
      await writeJson(path.join(this.directory, "reschedule-journal.json"), history);
      await writeJson(path.join(this.directory, "approval.json"), null);
      await writeJson(path.join(this.directory, "manifest.json"), this.manifest);
      await writeJson(path.join(this.directory, "ledger.json"), entries.filter(e => e.state === "PUBLIC_ACCEPTED"));
    });
  }

  /**
   * Record independently observed public acceptance after technical checks.
   * @param publicationId Original publication UUID.
   * @param canonicalUrl Independently inspected pinned-account video URL.
   * @param reviewer Reviewing operator identifier.
   * @param evidenceSha256 Hash of the private public-review evidence.
   * @param now Public acceptance timestamp.
   * @returns Completion of the private public-acceptance record.
   */
  async acceptPublic(publicationId: string, canonicalUrl: string, reviewer: string, evidenceSha256: string, now = new Date()): Promise<void> {
    await this.locked(async () => {
      const digest = await this.refresh();
      const approval = await readJson<CampaignApproval>(path.join(this.directory, "approval.json"));
      assert(digest === approval.manifestSha256, "Creative changed since approval");
      const escaped = this.manifest.expectedHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert(new RegExp(`^https://www\\.tiktok\\.com/@${escaped}/video/\\d+$`).test(canonicalUrl), "Expected canonical video URL for the pinned account");
      assert(reviewer.trim() && /^[a-f0-9]{64}$/.test(evidenceSha256), "Independent public content/settings evidence required");
      const entries = await this.entries(); const entry = entries.find(e => e.publicationId === publicationId);
      assert(entry && entry.state === "REVIEW_REQUIRED" && entry.canonicalUrl === canonicalUrl, "Verified original task result required before independent acceptance");
      entry.state = "PUBLIC_ACCEPTED"; entry.canonicalUrl = canonicalUrl;
      entry.publicAcceptance = { reviewer, verifiedAt: now.toISOString(), evidenceSha256 };
      await writeJson(path.join(this.directory, "ledger.json"), entries);
    });
  }
}
