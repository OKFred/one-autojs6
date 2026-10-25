import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { waitForTikTokCommitReview, type TikTokCommitReviewContext,
  type TikTokCommitReviewPending } from "../src/tiktok-commit-review.js";

/**
 * Create private synthetic fixtures with no phone, audio or account access.
 * @param t Test lifecycle for private fixture cleanup.
 * @returns Bound synthetic context, paths and a controlled local clock.
 */
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synthetic-tiktok-review-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = 1700000000000;
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const context: TikTokCommitReviewContext = { action: "publish", phase: "COMMITTING", taskId: randomUUID(), publicationId: randomUUID(),
    mediaSha256: hash("synthetic-only-video"), captionSha256: hash("synthetic-only-caption"), checkpointNonce: randomUUID(),
    checkpointTimestamp: clock - 1, postSettingsEvidence: { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND", verified: true, verifiedAt: clock - 10 } };
  const root = path.join(directory, "tiktok", "commit-review");
  const requestDirectory = path.join(root, context.publicationId, context.checkpointNonce);
  const pending = async () => JSON.parse(await fs.readFile(path.join(requestDirectory, "pending.json"), "utf8")) as TikTokCommitReviewPending;
  const release = async (mutate?: (value: Record<string, unknown>) => void) => {
    const value: Record<string, unknown> = { ...await pending(), status: "APPROVED", reviewer: "synthetic-operator",
      reviewedAt: clock, evidenceSha256: hash("synthetic-ui-review-not-live-evidence"), noAddedMusicVerified: true };
    mutate?.(value);
    await fs.writeFile(path.join(requestDirectory, "release.json"), JSON.stringify(value), { mode: 0o600, flag: "wx" });
  };
  return { directory, context, root, requestDirectory, pending, release, now: () => clock,
    advance: (milliseconds: number) => { clock += milliseconds; },
    options: { stateDirectory: directory, enabled: true, timeoutMs: 1000, pollIntervalMs: 25, now: () => clock } };
}

test("disabled, non-publish and malformed context never create a review request", async (t) => {
  const f = await fixture(t);
  await assert.rejects(waitForTikTokCommitReview(f.context, { ...f.options, enabled: false }), /COMMIT_REVIEW_DISABLED/);
  for (const changes of [{ action: "recover" }, { action: "status" }, { phase: "EDITOR_READY" }, { phase: "SUBMITTED" }, { publicationId: "../unsafe" },
    { mediaSha256: "A".repeat(64) }, { checkpointNonce: "../nonce" }, { postSettingsEvidence: { verified: true } }]) {
    await assert.rejects(waitForTikTokCommitReview({ ...f.context, ...changes } as TikTokCommitReviewContext, f.options), /COMMIT_REVIEW_INVALID_CONTEXT/);
  }
  await assert.rejects(waitForTikTokCommitReview({ ...f.context, checkpointTimestamp: f.now() - 30001,
    postSettingsEvidence: { ...f.context.postSettingsEvidence, verifiedAt: f.now() - 30002 },
  }, f.options), /COMMIT_REVIEW_STALE/);
  await assert.rejects(fs.access(f.root), { code: "ENOENT" });
});

test("only a complete exact local release is consumed once and journaled durably", async (t) => {
  const f = await fixture(t);
  const approved = await waitForTikTokCommitReview(f.context, { ...f.options, sleep: async (ms) => { await f.release(); f.advance(ms); } });
  const pending = await f.pending();
  assert.equal(approved.status, "APPROVED"); assert.equal(approved.noAddedMusicVerified, true);
  assert.equal(approved.requestSha256, pending.requestSha256);
  const consumed = JSON.parse(await fs.readFile(path.join(f.requestDirectory, "consumed.json"), "utf8"));
  assert.equal(consumed.status, "CONSUMED"); assert.equal(consumed.checkpointNonce, f.context.checkpointNonce);
  assert.deepEqual(consumed.postSettingsEvidence, f.context.postSettingsEvidence);
  assert.equal((await fs.readdir(f.requestDirectory)).filter((name) => name.startsWith("release.claimed-")).length, 1);
  await assert.rejects(fs.access(path.join(f.requestDirectory, "release.json")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(f.root, `${f.context.publicationId}.lock`)), { code: "ENOENT" });
  await assert.rejects(waitForTikTokCommitReview(f.context, f.options), /COMMIT_REVIEW_ALREADY_CONSUMED/);
  assert.deepEqual(await f.pending(), pending);
});

test("changed binding, omitted evidence and premature or future reviews never authorize commit", async (t) => {
  const mutations: Array<(value: Record<string, unknown>) => void> = [
    (value) => { value.publicationId = randomUUID(); }, (value) => { value.taskId = randomUUID(); },
    (value) => { value.mediaSha256 = "0".repeat(64); }, (value) => { value.captionSha256 = "0".repeat(64); },
    (value) => { value.checkpointNonce = randomUUID(); }, (value) => { value.checkpointTimestamp = 1; },
    (value) => { value.requestedAt = 1; }, (value) => { value.expiresAt = Number(value.expiresAt) + 1; },
    (value) => { value.requestSha256 = "0".repeat(64); }, (value) => { value.noAddedMusicVerified = false; },
    (value) => { delete value.noAddedMusicVerified; }, (value) => { value.evidenceSha256 = "unverified"; },
    (value) => { value.reviewer = ""; }, (value) => { value.status = "EDITOR_READY"; },
    (value) => { value.extraApproval = true; }, (value) => { value.reviewedAt = Number(value.requestedAt) - 1; },
    (value) => { value.reviewedAt = Number(value.expiresAt) + 1; },
    (value) => { value.postSettingsEvidence = { ...(value.postSettingsEvidence as object), verifiedAt: 1 }; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await t.test(`synthetic invalid release ${index}`, async (child) => {
      const f = await fixture(child);
      await assert.rejects(waitForTikTokCommitReview(f.context, { ...f.options,
        sleep: async (ms) => { await f.release(mutate); f.advance(ms); } }), /COMMIT_REVIEW_INVALID_RELEASE/);
      await assert.rejects(fs.access(path.join(f.requestDirectory, "consumed.json")), { code: "ENOENT" });
      assert.equal(JSON.parse(await fs.readFile(path.join(f.requestDirectory, "terminal.json"), "utf8")).status, "HELD");
    });
  }
});

test("missing review times out; cancellation cannot acknowledge a newly supplied release", async (t) => {
  const absent = await fixture(t);
  await assert.rejects(waitForTikTokCommitReview(absent.context, { ...absent.options,
    sleep: async (ms) => absent.advance(ms) }), /COMMIT_REVIEW_TIMEOUT/);
  assert.equal(JSON.parse(await fs.readFile(path.join(absent.requestDirectory, "terminal.json"), "utf8")).code, "COMMIT_REVIEW_TIMEOUT");
  const cancelled = await fixture(t); const controller = new AbortController();
  await assert.rejects(waitForTikTokCommitReview(cancelled.context, { ...cancelled.options, signal: controller.signal,
    sleep: async () => { await cancelled.release(); controller.abort(); } }), /COMMIT_REVIEW_CANCELLED/);
  await assert.rejects(fs.access(path.join(cancelled.requestDirectory, "consumed.json")), { code: "ENOENT" });
  const replaced = await fixture(t); let current = true;
  await assert.rejects(waitForTikTokCommitReview(replaced.context, { ...replaced.options, isCurrent: () => current,
    sleep: async () => { await replaced.release(); current = false; } }), /COMMIT_REVIEW_CANCELLED/);
});

test("unknown and replaced locks are preserved and cannot release a commit", async (t) => {
  const f = await fixture(t); await fs.mkdir(f.root, { recursive: true, mode: 0o700 });
  const lock = path.join(f.root, `${f.context.publicationId}.lock`);
  await fs.writeFile(lock, "unknown-owner", { mode: 0o600 });
  await assert.rejects(waitForTikTokCommitReview(f.context, f.options), /COMMIT_REVIEW_BUSY/);
  assert.equal(await fs.readFile(lock, "utf8"), "unknown-owner");
  const replaced = await fixture(t);
  const replacedLock = path.join(replaced.root, `${replaced.context.publicationId}.lock`);
  await assert.rejects(waitForTikTokCommitReview(replaced.context, { ...replaced.options, sleep: async () => {
    await replaced.release(); await fs.unlink(replacedLock); await fs.writeFile(replacedLock, "foreign-owner", { mode: 0o600 });
  } }), /COMMIT_REVIEW_BUSY/);
  assert.equal(await fs.readFile(replacedLock, "utf8"), "foreign-owner");
  await assert.rejects(fs.access(path.join(replaced.requestDirectory, "consumed.json")), { code: "ENOENT" });
});

test("operator proof is explicit and pending requests never manufacture audio approval", async (t) => {
  const f = await fixture(t);
  await assert.rejects(waitForTikTokCommitReview(f.context, { ...f.options, sleep: async (ms) => {
    const pending = await f.pending();
    assert.equal("noAddedMusicVerified" in pending, false); assert.equal("reviewer" in pending, false);
    assert.equal("evidenceSha256" in pending, false); f.advance(ms);
  } }), /COMMIT_REVIEW_TIMEOUT/);
});

test("concurrent waiters for one publication cannot race independent releases", async (t) => {
  const f = await fixture(t); const controller = new AbortController();
  let signalReady!: () => void; let wake!: () => void;
  const ready = new Promise<void>((resolve) => { signalReady = resolve; });
  const hold = new Promise<void>((resolve) => { wake = resolve; });
  const first = waitForTikTokCommitReview(f.context, { ...f.options, signal: controller.signal,
    sleep: async () => { signalReady(); await hold; } });
  const rejected = assert.rejects(first, /COMMIT_REVIEW_CANCELLED/);
  await ready;
  await assert.rejects(waitForTikTokCommitReview({ ...f.context, checkpointNonce: randomUUID() }, f.options), /COMMIT_REVIEW_BUSY/);
  controller.abort(); wake(); await rejected;
  await assert.rejects(fs.access(path.join(f.requestDirectory, "consumed.json")), { code: "ENOENT" });
});

test("a redirected commit-review directory never receives a pending request", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.directory, "unrelated-private-target"); await fs.mkdir(target, { mode: 0o700 });
  await fs.mkdir(path.join(f.directory, "tiktok"), { mode: 0o700 });
  await fs.symlink(target, f.root, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(waitForTikTokCommitReview(f.context, f.options), /COMMIT_REVIEW_UNSAFE_PATH/);
  assert.deepEqual(await fs.readdir(target), []);
  assert.equal((await fs.lstat(f.root)).isSymbolicLink(), true);
});
