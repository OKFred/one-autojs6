import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { TikTokPostSettingsEvidence } from "./tiktok-ledger.js";

/** Immutable local context for the current publish draft, never status/recovery. */
export interface TikTokCommitReviewContext {
  action: "publish";
  phase: "COMMITTING";
  taskId: string;
  publicationId: string;
  mediaSha256: string;
  captionSha256: string;
  checkpointNonce: string;
  checkpointTimestamp: number;
  postSettingsEvidence: TikTokPostSettingsEvidence;
}

/** Local-only enablement and bounded wait; no field is accepted from remote tasks. */
export interface TikTokCommitReviewOptions {
  stateDirectory: string;
  enabled: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Durable pending request copied exactly by an independently reviewing operator. */
export interface TikTokCommitReviewPending extends TikTokCommitReviewContext {
  schemaVersion: 1;
  status: "PENDING";
  requestedAt: number;
  expiresAt: number;
  requestSha256: string;
}

/** Local operator attestation; this is additional to merchant creative approval. */
export interface TikTokCommitReviewRelease extends Omit<TikTokCommitReviewPending, "status"> {
  status: "APPROVED";
  reviewer: string;
  reviewedAt: number;
  evidenceSha256: string;
  noAddedMusicVerified: true;
}

/** Only returned after the exact local release was atomically claimed and journaled. */
export interface TikTokCommitReviewApproval {
  status: "APPROVED";
  publicationId: string;
  checkpointNonce: string;
  requestSha256: string;
  reviewer: string;
  evidenceSha256: string;
  reviewedAt: number;
  consumedAt: number;
  noAddedMusicVerified: true;
}

/** Stable path-free failure for a held local commit review. */
export class TikTokCommitReviewError extends Error {
  /**
   * Create a safe local-review failure.
   * @param code Stable failure code containing no private context.
   * @returns Local-review error instance.
   */
  constructor(readonly code: string) { super(code); this.name = "TikTokCommitReviewError"; }
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{8,100}$/;
const NONCE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_FILE_BYTES = 16 * 1024;

/**
 * Assert a fail-closed local-review invariant.
 * @param condition Required invariant.
 * @param code Safe stable failure code.
 * @returns After successful validation.
 */
function requireReview(condition: unknown, code: string): asserts condition {
  if (!condition) throw new TikTokCommitReviewError(code);
}

/**
 * Recognize plain JSON objects.
 * @param value Unknown JSON field.
 * @returns Whether the value is an object rather than an array or null.
 */
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Hash the normalized pending binding in a stable insertion order.
 * @param value Complete normalized binding.
 * @returns Lowercase SHA-256.
 */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Normalize the trusted current-draft context without inferring any proof.
 * @param value Local client context bound to the original ledger/checkpoint.
 * @param now Current local time.
 * @returns Validated copied context.
 */
function contextValue(value: TikTokCommitReviewContext, now: number): TikTokCommitReviewContext {
  const proof = value?.postSettingsEvidence;
  requireReview(record(value) && value.action === "publish" && value.phase === "COMMITTING" && typeof value.taskId === "string" && ID.test(value.taskId) &&
    typeof value.publicationId === "string" && ID.test(value.publicationId) &&
    typeof value.mediaSha256 === "string" && HASH.test(value.mediaSha256) &&
    typeof value.captionSha256 === "string" && HASH.test(value.captionSha256) &&
    typeof value.checkpointNonce === "string" && NONCE.test(value.checkpointNonce) &&
    Number.isSafeInteger(value.checkpointTimestamp) && value.checkpointTimestamp > 0 &&
    record(proof) && Object.keys(proof).sort().join(",") === "audience,commercialDisclosure,verified,verifiedAt" &&
    proof.audience === "PUBLIC" && proof.commercialDisclosure === "YOUR_BRAND" && proof.verified === true &&
    Number.isSafeInteger(proof.verifiedAt) && proof.verifiedAt > 0 && proof.verifiedAt <= value.checkpointTimestamp,
  "COMMIT_REVIEW_INVALID_CONTEXT");
  requireReview(value.checkpointTimestamp <= now && now - value.checkpointTimestamp <= 30000, "COMMIT_REVIEW_STALE");
  return { action: "publish", phase: "COMMITTING", taskId: value.taskId, publicationId: value.publicationId,
    mediaSha256: value.mediaSha256, captionSha256: value.captionSha256, checkpointNonce: value.checkpointNonce,
    checkpointTimestamp: value.checkpointTimestamp, postSettingsEvidence: { audience: "PUBLIC",
      commercialDisclosure: "YOUR_BRAND", verified: true, verifiedAt: proof.verifiedAt } };
}

/**
 * Flush a parent directory on the deployed POSIX mobile filesystem.
 * @param directory Private directory containing a changed entry.
 * @returns Completion of its durability barrier; Windows tests lack directory fsync.
 */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Ensure an owned private directory without following a symlink.
 * @param directory Exact locally computed directory.
 * @returns Completion after checking ownership, type and private permissions.
 */
async function privateDirectory(directory: string): Promise<void> {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await fs.lstat(directory);
  requireReview(stat.isDirectory() && !stat.isSymbolicLink() &&
    (process.platform === "win32" || stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0), "COMMIT_REVIEW_UNSAFE_PATH");
  await syncDirectory(path.dirname(directory));
}

/**
 * Exclusively persist one immutable private JSON record and its directory entry.
 * @param filename Exact locally computed record path.
 * @param value Complete record.
 * @returns Completion after both file and directory durability barriers.
 */
async function durable(filename: string, value: unknown): Promise<void> {
  const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(path.dirname(filename));
}

/**
 * Read an operator record without following symlinks or accepting public files.
 * @param filename Exact private release/claim path.
 * @returns Parsed JSON plus a digest of the exact original bytes.
 */
async function readPrivate(filename: string): Promise<{ value: unknown; bytesSha256: string }> {
  const listing = await fs.lstat(filename);
  requireReview(listing.isFile() && !listing.isSymbolicLink(), "COMMIT_REVIEW_INVALID_RELEASE");
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireReview(stat.isFile() && stat.ino === listing.ino && stat.dev === listing.dev && stat.size > 0 && stat.size <= MAX_FILE_BYTES &&
      (process.platform === "win32" || stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0), "COMMIT_REVIEW_INVALID_RELEASE");
    const bytes = await handle.readFile();
    requireReview(bytes.length <= MAX_FILE_BYTES, "COMMIT_REVIEW_INVALID_RELEASE");
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { throw new TikTokCommitReviewError("COMMIT_REVIEW_INVALID_RELEASE"); }
    return { value, bytesSha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { await handle.close(); }
}

/**
 * Validate the exact one-use operator release against every pending binding.
 * @param value Unknown local release JSON.
 * @param pending Original durable pending request.
 * @param now Current local time.
 * @returns Validated operator attestation, with no inferred audio evidence.
 */
function releaseValue(value: unknown, pending: TikTokCommitReviewPending, now: number): TikTokCommitReviewRelease {
  const extra = ["reviewer", "reviewedAt", "evidenceSha256", "noAddedMusicVerified"];
  requireReview(record(value) && Object.keys(value).sort().join(",") === [...Object.keys(pending), ...extra].sort().join(","), "COMMIT_REVIEW_INVALID_RELEASE");
  for (const [key, expected] of Object.entries(pending)) {
    if (key === "status") continue;
    requireReview(key === "postSettingsEvidence"
      ? record(value[key]) && Object.keys(value[key]).sort().join(",") === Object.keys(expected as object).sort().join(",") &&
        Object.entries(expected as object).every(([proofKey, proofValue]) => (value[key] as Record<string, unknown>)[proofKey] === proofValue)
      : value[key] === expected, "COMMIT_REVIEW_INVALID_RELEASE");
  }
  requireReview(value.status === "APPROVED" && value.noAddedMusicVerified === true &&
    typeof value.reviewer === "string" && value.reviewer.trim().length > 0 && value.reviewer.length <= 100 && !/[\p{Cc}\p{Cf}]/u.test(value.reviewer) &&
    typeof value.evidenceSha256 === "string" && HASH.test(value.evidenceSha256) &&
    Number.isSafeInteger(value.reviewedAt) && Number(value.reviewedAt) >= pending.requestedAt &&
    Number(value.reviewedAt) <= now && Number(value.reviewedAt) < pending.expiresAt && now < pending.expiresAt,
  "COMMIT_REVIEW_INVALID_RELEASE");
  return value as unknown as TikTokCommitReviewRelease;
}

/**
 * Wait for an independently written, same-draft local operator release.
 * @param context Trusted publish ledger/checkpoint context; never remote settings.
 * @param options Local opt-in, private state directory, cancellation and time bounds.
 * @returns One consumed approval; every disabled, stale, invalid or cancelled path throws.
 */
export async function waitForTikTokCommitReview(
  context: TikTokCommitReviewContext,
  options: TikTokCommitReviewOptions,
): Promise<TikTokCommitReviewApproval> {
  requireReview(options.enabled === true, "COMMIT_REVIEW_DISABLED");
  const now = options.now ?? Date.now;
  const startedAt = now();
  requireReview(Number.isSafeInteger(startedAt) && startedAt > 0, "COMMIT_REVIEW_INVALID_CONTEXT");
  const bound = contextValue(context, startedAt);
  const timeout = options.timeoutMs ?? 180000;
  const interval = options.pollIntervalMs ?? 500;
  requireReview(Number.isSafeInteger(timeout) && timeout >= 1000 && timeout <= 180000 &&
    Number.isSafeInteger(interval) && interval >= 25 && interval <= 1000, "COMMIT_REVIEW_INVALID_CONTEXT");
  requireReview(typeof options.stateDirectory === "string" && path.isAbsolute(options.stateDirectory), "COMMIT_REVIEW_UNSAFE_PATH");
  /** Check that cleanup has not cancelled or replaced this same-draft wait. @returns After current-task validation. */
  const checkActive = (): void => {
    requireReview(!options.signal?.aborted && (!options.isCurrent || options.isCurrent()), "COMMIT_REVIEW_CANCELLED");
  };
  checkActive();
  let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
  let lockPath: string | undefined;
  let ownedLockBytes: string | undefined;
  let requestDirectory: string | undefined;
  let pending: TikTokCommitReviewPending | undefined;
  /** Confirm this process still owns the exclusive publication lock. @returns Completion of ownership validation. */
  const checkLock = async (): Promise<void> => {
    requireReview(lock && lockPath && ownedLockBytes, "COMMIT_REVIEW_BUSY");
    const owned = await lock.stat();
    const actual = await fs.lstat(lockPath);
    requireReview(actual.isFile() && !actual.isSymbolicLink() && actual.ino === owned.ino && actual.dev === owned.dev &&
      await fs.readFile(lockPath, "utf8") === ownedLockBytes, "COMMIT_REVIEW_BUSY");
  };
  try {
    await fs.mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    const state = await fs.realpath(options.stateDirectory);
    const tiktok = path.join(state, "tiktok"); await privateDirectory(tiktok);
    const root = path.join(tiktok, "commit-review"); await privateDirectory(root);
    lockPath = path.join(root, `${bound.publicationId}.lock`);
    try { lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TikTokCommitReviewError("COMMIT_REVIEW_BUSY"); throw error; }
    ownedLockBytes = JSON.stringify({ owner: randomUUID(), pid: process.pid, publicationId: bound.publicationId, checkpointNonce: bound.checkpointNonce });
    await lock.writeFile(ownedLockBytes, "utf8"); await lock.sync(); await syncDirectory(root);
    const publicationDirectory = path.join(root, bound.publicationId); await privateDirectory(publicationDirectory);
    requestDirectory = path.join(publicationDirectory, bound.checkpointNonce);
    try { await fs.mkdir(requestDirectory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TikTokCommitReviewError("COMMIT_REVIEW_ALREADY_CONSUMED"); throw error; }
    await syncDirectory(publicationDirectory);
    const binding = { schemaVersion: 1 as const, ...bound, requestedAt: startedAt, expiresAt: startedAt + timeout };
    pending = { ...binding, status: "PENDING", requestSha256: digest(binding) };
    await durable(path.join(requestDirectory, "pending.json"), pending);
    const releasePath = path.join(requestDirectory, "release.json");
    for (let polls = 0; polls <= Math.ceil(timeout / interval); polls++) {
      checkActive();
      await checkLock();
      const current = now();
      requireReview(current >= startedAt && current < pending.expiresAt, "COMMIT_REVIEW_TIMEOUT");
      let incoming: Awaited<ReturnType<typeof readPrivate>> | undefined;
      try { incoming = await readPrivate(releasePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (incoming) {
        const release = releaseValue(incoming.value, pending, current);
        checkActive();
        await checkLock();
        const claimed = path.join(requestDirectory, `release.claimed-${randomUUID()}.json`);
        await fs.rename(releasePath, claimed); await syncDirectory(requestDirectory);
        const consumedRelease = await readPrivate(claimed);
        requireReview(consumedRelease.bytesSha256 === incoming.bytesSha256, "COMMIT_REVIEW_INVALID_RELEASE");
        releaseValue(consumedRelease.value, pending, now());
        checkActive();
        await checkLock();
        const consumedAt = now();
        requireReview(consumedAt >= startedAt && consumedAt < pending.expiresAt, "COMMIT_REVIEW_TIMEOUT");
        await durable(path.join(requestDirectory, "consumed.json"), { ...release, status: "CONSUMED", consumedAt });
        checkActive();
        await checkLock();
        return { status: "APPROVED", publicationId: bound.publicationId, checkpointNonce: bound.checkpointNonce,
          requestSha256: pending.requestSha256, reviewer: release.reviewer, evidenceSha256: release.evidenceSha256,
          reviewedAt: release.reviewedAt, consumedAt, noAddedMusicVerified: true };
      }
      const pause = Math.min(interval, pending.expiresAt - current);
      if (options.sleep) await options.sleep(pause);
      else await delay(pause, undefined, { signal: options.signal });
    }
    throw new TikTokCommitReviewError("COMMIT_REVIEW_TIMEOUT");
  } catch (error) {
    const code = options.signal?.aborted ? "COMMIT_REVIEW_CANCELLED" :
      error instanceof TikTokCommitReviewError ? error.code : "COMMIT_REVIEW_IO_FAILURE";
    if (pending && requestDirectory) {
      try { await durable(path.join(requestDirectory, "terminal.json"), { schemaVersion: 1, status: "HELD", code,
        publicationId: bound.publicationId, checkpointNonce: bound.checkpointNonce, requestSha256: pending.requestSha256, at: now() }); }
      catch { /* Preserve existing evidence; an I/O failure cannot authorize commit. */ }
    }
    throw new TikTokCommitReviewError(code);
  } finally {
    if (lock && lockPath && ownedLockBytes) {
      const owned = await lock.stat(); await lock.close();
      try {
        const actual = await fs.lstat(lockPath);
        if (actual.isFile() && !actual.isSymbolicLink() && actual.ino === owned.ino && actual.dev === owned.dev &&
            await fs.readFile(lockPath, "utf8") === ownedLockBytes) {
          await fs.unlink(lockPath); await syncDirectory(path.dirname(lockPath));
        }
      } catch { /* Never delete a missing, replaced or unknown lock. */ }
    }
  }
}
