import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.js";
import { TikTokCommitAckGate, tikTokCommitReviewTimeoutMs } from "../src/tiktok-commit-ack.js";
import { normalizeTikTokRequest, type PreparedTikTokTask } from "../src/tiktok-policy.js";
import type { TikTokCommitReviewApproval, TikTokCommitReviewContext, waitForTikTokCommitReview } from "../src/tiktok-commit-review.js";

/** Create only the immutable selection fields used by local review eligibility. */
function prepared(action: "publish" | "recover" | "status" = "publish"): PreparedTikTokTask {
  return { request: { action }, publication: { media: { fingerprint: "a".repeat(64), expectedSha256: "a".repeat(64) }, postSettings: { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND" } } } as unknown as PreparedTikTokTask;
}

/** A synthetic same-draft checkpoint does not identify any actual phone or account. */
function context(): TikTokCommitReviewContext {
  return { action: "publish", phase: "COMMITTING", taskId: "synthetic-task-001", publicationId: "synthetic-publication-001", mediaSha256: "a".repeat(64), captionSha256: "b".repeat(64),
    checkpointNonce: "1bfc9614-cac0-4c64-8bcc-a4d7fb66c7dc", checkpointTimestamp: 2000,
    postSettingsEvidence: { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND", verified: true, verifiedAt: 1000 } };
}

/** Return only a synthetic consumed approval from the isolated injected review boundary. */
function approved(value: TikTokCommitReviewContext): TikTokCommitReviewApproval {
  return { status: "APPROVED", publicationId: value.publicationId, checkpointNonce: value.checkpointNonce, requestSha256: "c".repeat(64), reviewer: "synthetic-operator", evidenceSha256: "d".repeat(64), reviewedAt: 2500, consumedAt: 2600, noAddedMusicVerified: true };
}

test("review eligibility is local opt-in and only affects explicit hash-bound commercial publish jobs", () => {
  const enabled = { ...DEFAULT_CONFIG.tiktok, commitReview: { required: true, timeoutSeconds: 180 } };
  assert.equal(tikTokCommitReviewTimeoutMs(DEFAULT_CONFIG.tiktok, prepared()), 0);
  assert.equal(tikTokCommitReviewTimeoutMs(enabled, prepared()), 180000);
  assert.equal(tikTokCommitReviewTimeoutMs(enabled, prepared("recover")), 0);
  assert.equal(tikTokCommitReviewTimeoutMs(enabled, prepared("status")), 0);
  assert.equal(tikTokCommitReviewTimeoutMs(enabled), 0);
  const missingHash = prepared();
  delete missingHash.publication!.media.expectedSha256;
  assert.equal(tikTokCommitReviewTimeoutMs(enabled, missingHash), 0);
  const ordinaryPost = prepared();
  delete ordinaryPost.publication!.postSettings;
  assert.equal(tikTokCommitReviewTimeoutMs(enabled, ordinaryPost), 0);
  assert.throws(() => tikTokCommitReviewTimeoutMs({ ...enabled, commitReview: { required: true, timeoutSeconds: 181 } }, prepared()), /INVALID_CONTEXT/);
});

test("remote v2 fields cannot disable review or inject the private wrapper timeout", () => {
  for (const extra of [{ commitReview: { required: false } }, { taskCommittingReviewTimeoutMs: 0 }, { internalHints: { taskCommittingReviewTimeoutMs: 0 } }]) {
    assert.throws(() => normalizeTikTokRequest({ contractVersion: 2, action: "preflight", expectedHandle: "synthetic_shop", ...extra }, DEFAULT_CONFIG.tiktok));
  }
});

test("a pending same-draft review cannot produce a COMMITTING ACK and is awaited only once", async () => {
  const gate = new TikTokCommitAckGate();
  const bound = context();
  let resolve!: (value: TikTokCommitReviewApproval) => void;
  let calls = 0;
  let acknowledgements = 0;
  const wait: typeof waitForTikTokCommitReview = () => { calls++; return new Promise(done => { resolve = done; }); };
  const options = { stateDirectory: "/synthetic-private-state", enabled: true, isCurrent: () => true };
  const first = gate.wait(bound, options, wait).then(() => { acknowledgements++; });
  const pollAgain = gate.wait(bound, options, wait);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(acknowledgements, 0);
  resolve(approved(bound));
  await first; await pollAgain;
  assert.equal(acknowledgements, 1);
  assert.equal(calls, 1);
});

test("a changed nonce, media hash, caption hash or frozen proof cannot reuse a draft's pending review", async () => {
  for (const changed of [
    { checkpointNonce: "901d7ac0-9fc9-4c17-bcc7-bef13c16fd12" },
    { mediaSha256: "e".repeat(64) },
    { captionSha256: "f".repeat(64) },
    { postSettingsEvidence: { ...context().postSettingsEvidence, verifiedAt: 1100 } },
  ]) {
    const gate = new TikTokCommitAckGate();
    const bound = context();
    let resolve!: (value: TikTokCommitReviewApproval) => void;
    const wait: typeof waitForTikTokCommitReview = () => new Promise(done => { resolve = done; });
    const options = { stateDirectory: "/synthetic-private-state", enabled: true };
    const pending = gate.wait(bound, options, wait);
    await assert.rejects(gate.wait({ ...bound, ...changed }, options, wait), /COMMIT_REVIEW_STALE/);
    resolve(approved(bound)); await pending;
  }
});

test("expired, invalid or consumed release failures never become an ACK on later polls", async () => {
  for (const code of ["COMMIT_REVIEW_TIMEOUT", "COMMIT_REVIEW_INVALID_RELEASE", "COMMIT_REVIEW_ALREADY_CONSUMED"]) {
    const gate = new TikTokCommitAckGate();
    let calls = 0;
    let acknowledgements = 0;
    const wait: typeof waitForTikTokCommitReview = async () => { calls++; throw new Error(code); };
    const options = { stateDirectory: "/synthetic-private-state", enabled: true };
    await assert.rejects(gate.wait(context(), options, wait).then(() => { acknowledgements++; }), new RegExp(code));
    await assert.rejects(gate.wait(context(), options, wait).then(() => { acknowledgements++; }), new RegExp(code));
    assert.equal(calls, 1);
    assert.equal(acknowledgements, 0);
  }
});

test("task cancellation or changed current draft blocks ACK even if a review boundary resolves", async () => {
  for (const cancel of ["signal", "current"]) {
    const gate = new TikTokCommitAckGate();
    const bound = context();
    const controller = new AbortController();
    let current = true;
    let resolve!: (value: TikTokCommitReviewApproval) => void;
    const wait: typeof waitForTikTokCommitReview = () => new Promise(done => { resolve = done; });
    const pending = gate.wait(bound, { stateDirectory: "/synthetic-private-state", enabled: true, signal: controller.signal, isCurrent: () => current }, wait);
    if (cancel === "signal") controller.abort(); else current = false;
    resolve(approved(bound));
    await assert.rejects(pending, /COMMIT_REVIEW_CANCELLED/);
  }
});
