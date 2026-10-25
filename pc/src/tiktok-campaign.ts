import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
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
    normalizeTikTokRequest({ contractVersion: 2, action: "publish", publicationId: creative.publicationId,
      expectedHandle: manifest.expectedHandle, media: { mode: "direct", kind: "video", path: creative.devicePath, expectedSha256: creative.sha256 },
      content: { title: creative.title, details: creative.caption }, postSettings: creative.postSettings }, {});
    assert(creative.postSettings?.audience === "PUBLIC" && creative.postSettings.commercialDisclosure === "YOUR_BRAND", "Commercial post settings required");
    assert(creative.title.length > 0 && creative.caption.length > 0, "A single reviewed caption is required");
  }
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
      const taskId = entry.recoveryTasks?.at(-1)?.taskId ?? entry.taskId;
      assert(taskId, "No task receipt; use original-ID status/recovery");
      const task = await this.transport.inspect(taskId);
      if (["PENDING", "EXECUTING", "RUNNING"].includes(task.status)) return "IN_PROGRESS";
      const result = task.result as Record<string, any> | undefined;
      const escaped = this.manifest.expectedHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const url = result?.post?.canonicalUrl;
      const proof = result?.postSettingsEvidence;
      const valid = task.status === "SUCCESS" && task.clientId === this.manifest.deviceClientId && task.scriptId === "tiktok.post" &&
        task.createTimeUtc >= Date.parse(entry.attemptedAt) - 5000 && task.createTimeUtc <= now.getTime() + 5000 && result?.contractVersion === 2 &&
        result.publicationId === publicationId && ["publish", "recover", "status"].includes(result.action) &&
        result.phase === "LINK_CONFIRMED" && result.outcome === "SUCCESS" && result.published === true && result.success === true &&
        result.post?.verified === true && typeof url === "string" && new RegExp(`^https://www\\.tiktok\\.com/@${escaped}/video/\\d+$`).test(url) &&
        url.endsWith(`/${result.post?.postId}`) && result.postSettings?.audience === "PUBLIC" && result.postSettings?.commercialDisclosure === "YOUR_BRAND" &&
        proof?.verified === true && proof.audience === "PUBLIC" && proof.commercialDisclosure === "YOUR_BRAND" &&
        Number.isSafeInteger(proof.verifiedAt) && proof.verifiedAt >= Date.parse(entry.attemptedAt) - 5000 && proof.verifiedAt <= now.getTime() + 5000 &&
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
