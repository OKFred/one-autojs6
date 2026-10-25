import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TikTokConfig } from "../src/config.js";
import { TikTokLedger } from "../src/tiktok-ledger.js";
import {
  applyTikTokScriptResult,
  applyTikTokPublicationCheckpoint,
  buildCaptionCandidates,
  detectTikTokMediaKind,
  evaluatePostingPolicy,
  importLegacyTikTokState,
  inspectMediaCandidates,
  isPathWithinAllowedRoots,
  markTikTokPublicationPhase,
  normalizeTikTokRequest,
  prepareTikTokTask,
  selectCaptionCombination,
  selectMediaCandidate,
  sha256,
  sha256File,
  tightenTikTokPolicy,
  tikTokPostSettingsSummary,
  tikTokCreativeEvidenceSummary,
  validateTikTokPostSettingsEvidence,
  type TikTokMediaCandidate,
} from "../src/tiktok-policy.js";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autojs6-tiktok-"));
const mediaRoot = path.join(temporaryRoot, "media").replace(/\\/g, "/");
const stateRoot = path.join(temporaryRoot, "state").replace(/\\/g, "/");
fs.mkdirSync(mediaRoot, { recursive: true });
const imagePath = path.join(mediaRoot, "photo.jpg").replace(/\\/g, "/");
const duplicateImagePath = path
  .join(mediaRoot, "photo-copy.jpg")
  .replace(/\\/g, "/");
const videoPath = path.join(mediaRoot, "clip.mp4").replace(/\\/g, "/");
fs.writeFileSync(imagePath, "image-content", "utf8");
fs.writeFileSync(duplicateImagePath, "image-content", "utf8");
fs.writeFileSync(videoPath, "video-content", "utf8");

const config: TikTokConfig = {
  expectedHandle: "@Example.Creator",
  allowedMaterialRoots: [mediaRoot],
  minIntervalSeconds: 1800,
  maxPostsPerDay: 3,
  materialReuseSeconds: 86400,
  captionReuseSeconds: 86400,
  adbKeyboard: {
    enabled: false,
    apkSha256: "",
  },
};

const effective = tightenTikTokPolicy(config, {
  minIntervalSeconds: 3600,
  maxPostsPerDay: 2,
  materialReuseSeconds: 10,
  captionReuseSeconds: 172800,
});
assert.deepEqual(effective, {
  minIntervalSeconds: 3600,
  maxPostsPerDay: 2,
  materialReuseSeconds: 86400,
  captionReuseSeconds: 172800,
});

const normalized = normalizeTikTokRequest(
  {
    contractVersion: 2,
    action: "publish",
    publicationId: "publication_001",
    expectedHandle: "example.creator",
    media: { mode: "direct", path: imagePath, kind: "image" },
    content: { title: "Title", details: "Description" },
    policy: { minIntervalSeconds: 120 },
    link: { maxAttempts: 4, retrySeconds: 5 },
  },
  config,
);
assert.equal(normalized.expectedHandle, "example.creator");
assert.equal(normalized.policy.minIntervalSeconds, 1800);
assert.deepEqual(normalized.link, { maxAttempts: 4, retrySeconds: 5 });
assert.throws(
  () =>
    normalizeTikTokRequest(
      {
        contractVersion: 2,
        action: "publish",
        publicationId: "publication_002",
        expectedHandle: "someone.else",
        media: { mode: "direct", path: imagePath },
        content: { title: "Title" },
      },
      config,
    ),
  /EXPECTED_ACCOUNT_MISMATCH/,
);
assert.equal(
  normalizeTikTokRequest(
    {
      contractVersion: 2,
      action: "publish",
      publicationId: "publication_003",
      expectedHandle: "request.only",
      media: { mode: "direct", path: imagePath },
      content: { title: "Title" },
    },
    { ...config, expectedHandle: undefined },
  ).expectedHandle,
  "request.only",
);
assert.throws(
  () =>
    normalizeTikTokRequest(
      {
        contractVersion: 2,
        action: "publish",
        publicationId: "publication_004",
        media: { mode: "direct", path: imagePath },
        content: { title: "Title" },
      },
      { ...config, expectedHandle: undefined },
    ),
  /EXPECTED_HANDLE_REQUIRED/,
);
assert.equal(
  normalizeTikTokRequest(
    { contractVersion: 2, action: "preflight", publicationId: "preflight_001" },
    { ...config, expectedHandle: undefined },
  ).action,
  "preflight",
);
assert.throws(
  () => normalizeTikTokRequest({ linkOnly: true }, config),
  /PUBLICATION_ID_REQUIRED/,
);
const legacy = normalizeTikTokRequest(
  { imagePath, title: "Legacy title" },
  { ...config, expectedHandle: undefined },
  () => "legacy_publication_001",
);
assert.equal(legacy.legacy, true);
assert.deepEqual(legacy.warnings, ["LEGACY_EXPECTED_HANDLE_MISSING"]);
assert.throws(
  () =>
    normalizeTikTokRequest(
      {
        contractVersion: 2,
        action: "publish",
        publicationId: "publication_005",
        expectedHandle: "example.creator",
        media: { mode: "direct", path: "/sdcard/secret.jpg" },
        content: { title: "Title" },
      },
      config,
    ),
  /MEDIA_PATH_NOT_ALLOWED/,
);

assert.equal(isPathWithinAllowedRoots(imagePath, [mediaRoot]), true);
assert.equal(
  isPathWithinAllowedRoots(`${mediaRoot}/../outside.jpg`, [mediaRoot]),
  false,
);
const rootAlias = path.join(temporaryRoot, "media-alias");
if (process.platform !== "win32") {
  fs.symlinkSync(mediaRoot, rootAlias, "dir");
  const aliasImagePath = path.join(rootAlias, path.basename(imagePath));
  const aliasRequest = normalizeTikTokRequest(
    {
      contractVersion: 2,
      action: "preflight",
      publicationId: "publication_alias_001",
      media: { mode: "direct", kind: "image", path: aliasImagePath },
    },
    { ...config, allowedMaterialRoots: [rootAlias] },
  );
  assert.equal(
    inspectMediaCandidates(aliasRequest.media!, [rootAlias])[0]?.path,
    fs.realpathSync(imagePath).replace(/\\/g, "/"),
  );
}
assert.equal(detectTikTokMediaKind(imagePath), "image");
assert.equal(detectTikTokMediaKind(videoPath), "video");
assert.equal(sha256File(imagePath), sha256("image-content"));
const automaticPool = normalizeTikTokRequest(
  {
    contractVersion: 2,
    action: "publish",
    publicationId: "publication_auto_001",
    media: { mode: "pool", paths: [imagePath, videoPath], kind: "auto" },
    content: { title: "Mixed" },
  },
  config,
);
assert.equal(automaticPool.media?.kind, undefined);
assert.throws(
  () =>
    normalizeTikTokRequest(
      {
        contractVersion: 2,
        action: "publish",
        publicationId: "publication_auto_002",
        media: { mode: "direct", path: imagePath, kind: "auto" },
        content: { title: "Invalid auto" },
      },
      config,
    ),
  /INVALID_MEDIA_KIND/,
);
const inspected = inspectMediaCandidates(
  {
    mode: "pool",
    paths: [imagePath, duplicateImagePath, videoPath],
    directories: [],
  },
  [mediaRoot],
);
assert.equal(inspected.length, 2, "identical file content must deduplicate");

const captions = buildCaptionCandidates(
  { titles: ["A", "B"], details: ["one"] },
  ["image"],
);
assert.equal(captions.length, 2);
assert.throws(
  () => buildCaptionCandidates({ titles: ["A"], details: ["x".repeat(2200)] }, ["video"]),
  /VIDEO_CAPTION_TOO_LONG/,
);
const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
const mediaCandidates: TikTokMediaCandidate[] = [
  {
    path: imagePath,
    kind: "image",
    fingerprint: "a".repeat(64),
    size: 10,
    mtimeMs: 1,
  },
  {
    path: videoPath,
    kind: "video",
    fingerprint: "b".repeat(64),
    size: 10,
    mtimeMs: 1,
  },
];
assert.equal(
  selectMediaCandidate(
    mediaCandidates,
    { [mediaCandidates[0].fingerprint]: now - 100_000 },
    10,
    now,
  ).fingerprint,
  mediaCandidates[1].fingerprint,
);
assert.equal(
  selectCaptionCombination(captions, {}, 86400, now).fingerprint,
  [...captions].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))[0]
    .fingerprint,
);

const ledgerForPolicy = new TikTokLedger(path.join(temporaryRoot, "policy-state"));
const policyMedia = {
  path: imagePath,
  kind: "image" as const,
  fingerprint: sha256("policy-media"),
  size: 10,
};
const policyCaption = {
  title: "Policy",
  details: "",
  caption: "Policy",
  fingerprint: sha256("policy-caption"),
};
ledgerForPolicy.begin(
  {
    publicationId: "policy_publication_001",
    requestFingerprint: sha256("policy-request"),
    account: "example.creator",
    media: policyMedia,
    caption: policyCaption,
  },
  now - 1000,
);
ledgerForPolicy.advance("policy_publication_001", "SUBMITTED", {}, now - 1000);
assert.equal(
  evaluatePostingPolicy(
    Object.values(ledgerForPolicy.snapshot().publications),
    effective,
    now,
  ).code,
  "POST_COOLDOWN",
);

const prepared = prepareTikTokTask(
  {
    contractVersion: 2,
    action: "publish",
    publicationId: "prepared_publication_001",
    media: { mode: "direct", path: imagePath, kind: "image" },
    content: { title: "Prepared", details: "Details" },
  },
  config,
  { stateDirectory: stateRoot, now },
);
assert.equal(prepared.decision, "NEW");
assert.equal(prepared.scriptParams?.publicationId, "prepared_publication_001");
assert.equal(fs.existsSync(prepared.ledger.filePath), true);
if (process.platform !== "win32") {
  assert.equal(fs.statSync(prepared.ledger.filePath).mode & 0o777, 0o600);
}
const repeated = prepareTikTokTask(
  {
    contractVersion: 2,
    action: "publish",
    publicationId: "prepared_publication_001",
    media: { mode: "direct", path: imagePath, kind: "image" },
    content: { title: "Prepared", details: "Details" },
  },
  config,
  { stateDirectory: stateRoot, now: now + 1000 },
);
assert.equal(repeated.decision, "RESUME");
assert.throws(
  () =>
    prepareTikTokTask(
      {
        contractVersion: 2,
        action: "publish",
        publicationId: "prepared_publication_001",
        media: { mode: "direct", path: videoPath, kind: "video" },
        content: { title: "Changed" },
      },
      config,
      { stateDirectory: stateRoot, now: now + 1000 },
    ),
  /PUBLICATION_ID_CONFLICT/,
);
prepared.ledger.setOutcome(
  "prepared_publication_001",
  "FAILURE",
  "EARLIER_SAFE_FAILURE",
  now + 1900,
);
const committingRecord = markTikTokPublicationPhase(
  prepared,
  "COMMITTING",
  now + 2000,
);
assert.equal(committingRecord.outcome, "PENDING");
assert.equal(committingRecord.errorCode, undefined);
applyTikTokPublicationCheckpoint(
  prepared,
  {
    baselinePostIds: ["111", "222", "not-an-id"],
    baselineTileCount: 2,
  },
  now + 2100,
);
assert.equal(
  evaluatePostingPolicy(
    Object.values(prepared.ledger.snapshot().publications),
    normalized.policy,
    now + 2200,
  ).code,
  "POST_COOLDOWN",
  "COMMITTING tasks must conservatively consume posting limits",
);
const afterCommitReplay = prepareTikTokTask(
  {
    contractVersion: 2,
    action: "publish",
    publicationId: "prepared_publication_001",
    media: { mode: "direct", path: imagePath, kind: "image" },
    content: { title: "Prepared", details: "Details" },
  },
  config,
  { stateDirectory: stateRoot, now: now + 3000 },
);
assert.equal(afterCommitReplay.decision, "RECOVER");
assert.equal(afterCommitReplay.scriptParams?.linkOnly, true);
assert.deepEqual(
  (
    afterCommitReplay.scriptParams?.recoveryContext as {
      baselinePostIds: string[];
      baselineTileCount: number;
    }
  ).baselinePostIds,
  ["111", "222"],
);
assert.equal(
  (
    afterCommitReplay.scriptParams?.recoveryContext as {
      baselineTileCount: number;
    }
  ).baselineTileCount,
  2,
);
const completed = applyTikTokScriptResult(
  afterCommitReplay,
  {
    success: true,
    published: true,
    postUrl: "https://www.tiktok.com/@example.creator/video/1234567890",
  },
  now + 4000,
);
assert.equal(completed?.phase, "LINK_CONFIRMED");
assert.equal(completed?.postId, "1234567890");
const cached = prepareTikTokTask(
  {
    contractVersion: 2,
    action: "recover",
    publicationId: "prepared_publication_001",
  },
  config,
  { stateDirectory: stateRoot, now: now + 5000 },
);
assert.equal(cached.decision, "CACHED");
assert.equal(cached.scriptParams, null);

const preflight = prepareTikTokTask(
  { contractVersion: 2, action: "preflight", publicationId: "preflight_002" },
  { ...config, expectedHandle: undefined },
  { stateDirectory: stateRoot, now },
);
assert.equal(preflight.decision, "PREFLIGHT");

const legacyStatePath = path.join(temporaryRoot, "tiktok_post_state.json");
const legacyCaptionKey = JSON.stringify({
  title: "Old title",
  details: "Old details",
  caption: "Old title\nOld details",
});
fs.writeFileSync(
  legacyStatePath,
  JSON.stringify({
    materialUses: { [videoPath]: now - 1000 },
    captionUses: { [legacyCaptionKey]: now - 1000 },
    posts: [
      {
        postUrl: "https://www.tiktok.com/@wrong/video/999",
        profileHandle: "wrong",
      },
    ],
  }),
  "utf8",
);
const importLedger = new TikTokLedger(path.join(temporaryRoot, "import-state"));
const imported = importLegacyTikTokState(
  importLedger,
  legacyStatePath,
  [mediaRoot],
  now,
);
assert.deepEqual(imported, {
  imported: true,
  materialFingerprints: 1,
  captionFingerprints: 1,
});
assert.equal(fs.existsSync(legacyStatePath), false);
const importedSnapshot = importLedger.snapshot();
assert.equal(importedSnapshot.legacyImport?.status, "LEGACY_UNVERIFIED");
assert.deepEqual(importedSnapshot.publications, {});

const approvedSettings = { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND" } as const;
const approvedHash = sha256File(imagePath);
const approvedRequest = {
  contractVersion: 2, action: "publish", publicationId: "approved_creative_001",
  media: { mode: "direct", kind: "image", path: imagePath, expectedSha256: approvedHash },
  content: { title: "Approved style", details: "Availability confirmed manually." },
  postSettings: approvedSettings,
};
const approvedState = path.join(temporaryRoot, "approved-state");
const approved = prepareTikTokTask(approvedRequest, config, { stateDirectory: approvedState, now });
assert.deepEqual(approved.publication?.postSettings, approvedSettings);
assert.equal(approved.publication?.media.expectedSha256, approvedHash);
assert.deepEqual(approved.scriptParams?.postSettings, approvedSettings);
assert.deepEqual(approved.scriptParams?.media, { expectedSha256: approvedHash });
assert.deepEqual(tikTokCreativeEvidenceSummary(approved.publication), { creativeEvidence: {
  mediaSha256: approvedHash,
  captionSha256: sha256(JSON.stringify(approvedRequest.content)),
  requestFingerprint: approved.publication?.requestFingerprint,
} });
assert.deepEqual(tikTokPostSettingsSummary(approved.publication, now), { postSettings: approvedSettings });
assert.throws(() => markTikTokPublicationPhase(approved, "COMMITTING", now + 100), /POST_SETTINGS_NOT_VERIFIED/);
assert.equal(approved.ledger.get(approvedRequest.publicationId)?.phase, "PRECHECKED");
for (const proof of [null, { ...approvedSettings, verified: false, verifiedAt: now },
  { ...approvedSettings, verified: true, verifiedAt: now - 1 },
  { ...approvedSettings, verified: true, verifiedAt: now + 101 },
  { ...approvedSettings, verified: true, verifiedAt: now, extra: true }]) {
  assert.throws(() => applyTikTokPublicationCheckpoint(approved, { postSettingsEvidence: proof }, now + 100), /POST_SETTINGS_NOT_VERIFIED/);
}
const settingsProof = { ...approvedSettings, verified: true, verifiedAt: now + 100 } as const;
applyTikTokPublicationCheckpoint(approved, { postSettingsEvidence: settingsProof }, now + 100);
assert.deepEqual(tikTokPostSettingsSummary(approved.ledger.get(approvedRequest.publicationId), now + 100), {
  postSettings: approvedSettings, postSettingsEvidence: settingsProof,
});
assert.throws(() => prepareTikTokTask(approvedRequest, config, { stateDirectory: approvedState, now: now + 200 }), /POST_SETTINGS_REVIEW_REQUIRED/);
assert.throws(() => applyTikTokPublicationCheckpoint(approved, {
  postSettingsEvidence: { ...settingsProof, verifiedAt: now + 200 },
}, now + 200), /POST_SETTINGS_EVIDENCE_CONFLICT/);
markTikTokPublicationPhase(approved, "COMMITTING", now + 300);
const recoveredApproved = prepareTikTokTask({ contractVersion: 2, action: "recover", publicationId: approvedRequest.publicationId },
  config, { stateDirectory: approvedState, now: now + 400 });
assert.deepEqual(recoveredApproved.scriptParams?.postSettings, approvedSettings);
assert.deepEqual((recoveredApproved.scriptParams?.recoveryContext as Record<string, unknown>).postSettingsEvidence, settingsProof);
assert.equal(applyTikTokScriptResult(recoveredApproved, {
  contractVersion: 2, publicationId: approvedRequest.publicationId,
  published: true, postUrl: "https://www.tiktok.com/@example.creator/photo/1234567891",
  postSettingsEvidence: settingsProof,
}, now + 500)?.outcome, "SUCCESS");
assert.throws(() => prepareTikTokTask({ contractVersion: 2, action: "status", publicationId: approvedRequest.publicationId },
  { ...config, expectedHandle: "another.account" }, { stateDirectory: approvedState, now: now + 600 }), /EXPECTED_ACCOUNT_MISMATCH/);
assert.throws(() => prepareTikTokTask({ contractVersion: 2, action: "status", publicationId: approvedRequest.publicationId },
  { ...config, expectedHandle: undefined }, { stateDirectory: approvedState, now: now + 600 }), /EXPECTED_HANDLE_REQUIRED/);
assert.throws(() => prepareTikTokTask({ contractVersion: 2, action: "status", publicationId: approvedRequest.publicationId,
  media: { ...approvedRequest.media, expectedSha256: "0".repeat(64) },
}, config, { stateDirectory: approvedState, now: now + 600 }), /MEDIA_SHA256_RECOVERY_MISMATCH/);
assert.equal(prepareTikTokTask({ contractVersion: 2, action: "status", publicationId: approvedRequest.publicationId,
  media: approvedRequest.media, postSettings: approvedSettings,
}, config, { stateDirectory: approvedState, now: now + 600 }).decision, "STATUS");

const mismatchedHashState = path.join(temporaryRoot, "hash-mismatch-state");
assert.throws(() => prepareTikTokTask({ ...approvedRequest,
  media: { ...approvedRequest.media, expectedSha256: "0".repeat(64) },
}, config, { stateDirectory: mismatchedHashState, now }), /MEDIA_HASH_MISMATCH/);
assert.deepEqual(new TikTokLedger(mismatchedHashState).snapshot().publications, {});
for (const expectedSha256 of ["A".repeat(64), "bad", null]) {
  assert.throws(() => normalizeTikTokRequest({ ...approvedRequest,
    media: { ...approvedRequest.media, expectedSha256 },
  }, config), /INVALID_MEDIA_SHA256/);
}
assert.throws(() => normalizeTikTokRequest({ ...approvedRequest,
  media: { mode: "pool", paths: [imagePath], expectedSha256: approvedHash },
}, config), /MEDIA_SHA256_REQUIRES_DIRECT/);
for (const postSettings of [null, {}, { ...approvedSettings, verified: true },
  { audience: "FRIENDS", commercialDisclosure: "YOUR_BRAND" }]) {
  assert.throws(() => normalizeTikTokRequest({ ...approvedRequest, postSettings }, config), /POST_SETTINGS_INVALID|UNKNOWN_POSTSETTINGS_FIELD/);
}
const noProofState = path.join(temporaryRoot, "missing-proof-state");
const missingProof = prepareTikTokTask(approvedRequest, config, { stateDirectory: noProofState, now });
assert.equal(applyTikTokScriptResult(missingProof, {
  contractVersion: 2, publicationId: approvedRequest.publicationId,
  published: true, postUrl: "https://www.tiktok.com/@example.creator/photo/1234567892",
}, now + 100)?.outcome, "PUBLISH_OUTCOME_UNKNOWN");
assert.equal(missingProof.ledger.get(approvedRequest.publicationId)?.phase, "PRECHECKED");
assert.equal(missingProof.ledger.get(approvedRequest.publicationId)?.errorCode, "POST_SETTINGS_NOT_VERIFIED");
const mismatchedResultState = path.join(temporaryRoot, "mismatched-result-state");
const mismatchedResult = prepareTikTokTask(approvedRequest, config, { stateDirectory: mismatchedResultState, now });
assert.equal(applyTikTokScriptResult(mismatchedResult, {
  contractVersion: 2, publicationId: "another_publication", published: true,
  postSettingsEvidence: settingsProof,
  postUrl: "https://www.tiktok.com/@example.creator/photo/1234567893",
}, now + 200)?.errorCode, "PUBLICATION_RESULT_MISMATCH");
assert.equal(mismatchedResult.ledger.get(approvedRequest.publicationId)?.postSettingsEvidence, undefined);
assert.equal(prepareTikTokTask(approvedRequest, config, {
  stateDirectory: noProofState, now: now + 200,
}).decision, "RECOVER", "An unproved claimed publication may recover links but never republish");
assert.throws(() => prepareTikTokTask({ ...approvedRequest, postSettings: undefined }, config,
  { stateDirectory: noProofState, now: now + 200 }), /PUBLICATION_ID_CONFLICT/);
assert.throws(() => prepareTikTokTask({ ...approvedRequest,
  media: { ...approvedRequest.media, expectedSha256: undefined },
}, config, { stateDirectory: noProofState, now: now + 200 }), /PUBLICATION_ID_CONFLICT/);

const historical = prepared.ledger.get("prepared_publication_001");
assert.ok(historical);
assert.deepEqual(tikTokPostSettingsSummary(historical, now + 10000), {});
assert.deepEqual(tikTokCreativeEvidenceSummary(historical), {});
assert.equal(prepareTikTokTask({ contractVersion: 2, action: "status", publicationId: historical.publicationId },
  { ...config, expectedHandle: "another.account" }, { stateDirectory: stateRoot, now: now + 10000 }).decision, "STATUS",
  "Legacy status without new binding fields keeps its original behavior");
assert.equal(historical.requestFingerprint, sha256(JSON.stringify({
  account: "example.creator", media: [sha256File(imagePath)],
  captions: buildCaptionCandidates({ titles: ["Prepared"], details: ["Details"] }, ["image"]).map((item) => item.fingerprint).sort(),
})));
assert.throws(() => validateTikTokPostSettingsEvidence(settingsProof, historical, now + 10000), /POST_SETTINGS_NOT_VERIFIED/);
assert.throws(() => prepareTikTokTask({ contractVersion: 2, action: "recover", publicationId: historical.publicationId,
  postSettings: approvedSettings,
}, config, { stateDirectory: stateRoot, now: now + 10000 }), /POST_SETTINGS_RECOVERY_MISMATCH/);
assert.equal(cached.scriptParams, null);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
console.log("TikTok policy and ledger tests passed");
