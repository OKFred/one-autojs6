import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTikTokRequest,
  TikTokContractError,
} from "../src/tiktok-contract.js";

const PUBLICATION_ID = "8fa04e65-0c0c-46ca-bdb2-00bd21e53c28";

/** 断言调用因 TikTok 契约错误失败。 */
function assertContractError(callback: () => unknown, pattern: RegExp): void {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof TikTokContractError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("normalizes a canonical direct-video publish request", () => {
  const result = normalizeTikTokRequest({
    contractVersion: 2,
    action: "publish",
    expectedHandle: "@creator.account",
    media: {
      mode: "direct",
      kind: "video",
      path: "/sdcard/Download/tiktok-materials/clip.mp4",
    },
    content: { title: "Evening walk", details: "A quiet moment." },
  });

  assert.match(result.params.publicationId, /^[0-9a-f-]{36}$/);
  assert.equal(result.params.expectedHandle, "creator.account");
  assert.deepEqual(result.params.media, {
    mode: "direct",
    kind: "video",
    path: "/sdcard/Download/tiktok-materials/clip.mp4",
  });
  assert.deepEqual(result.params.policy, {
    minIntervalSeconds: 1800,
    maxPostsPerDay: 3,
    materialReuseSeconds: 86400,
    captionReuseSeconds: 86400,
  });
  assert.deepEqual(result.params.link, { maxAttempts: 8, retrySeconds: 15 });
  assert.equal(result.timeoutSeconds, 420);
});

test("normalizes a canonical mixed media pool", () => {
  const result = normalizeTikTokRequest({
    contractVersion: 2,
    action: "publish",
    publicationId: PUBLICATION_ID.toUpperCase(),
    media: {
      mode: "pool",
      kind: "auto",
      paths: [
        "/sdcard/Download/tiktok-materials/photo.jpg",
        "/sdcard/Download/tiktok-materials/clip.mp4",
      ],
    },
    content: { titles: ["Look one", "Look two"] },
    policy: { minIntervalSeconds: 3600, maxPostsPerDay: 2 },
    link: { maxAttempts: 10, retrySeconds: 20 },
    timeout: 500,
  });

  assert.equal(result.params.publicationId, PUBLICATION_ID);
  assert.equal(result.params.media?.kind, "auto");
  assert.equal(result.params.policy.minIntervalSeconds, 3600);
  assert.equal(result.params.policy.maxPostsPerDay, 2);
  assert.equal(result.timeoutSeconds, 500);
});

test("maps a legacy flat publish request to contract v2", () => {
  const result = normalizeTikTokRequest(
    {
      title: "Legacy title",
      videoPath: "/sdcard/Download/tiktok-materials/legacy.mp4",
      minIntervalSeconds: 2400,
    },
    {},
  );

  assert.equal(result.params.contractVersion, 2);
  assert.equal(result.params.action, "publish");
  assert.equal(result.params.content.title, "Legacy title");
  assert.deepEqual(result.params.media, {
    mode: "direct",
    kind: "video",
    path: "/sdcard/Download/tiktok-materials/legacy.mp4",
  });
  assert.equal(result.params.policy.minIntervalSeconds, 2400);
});

test("maps legacy linkOnly to recover only with the original publicationId", () => {
  const result = normalizeTikTokRequest({
    linkOnly: true,
    publicationId: PUBLICATION_ID,
  });
  assert.equal(result.params.action, "recover");
  assert.equal(result.params.publicationId, PUBLICATION_ID);
  assert.equal(result.params.media, undefined);

  assertContractError(
    () => normalizeTikTokRequest({ linkOnly: true }),
    /publicationId is required/,
  );
});

test("requires publicationId for recover and status", () => {
  for (const action of ["recover", "status"]) {
    assertContractError(
      () => normalizeTikTokRequest({ contractVersion: 2, action }),
      /publicationId is required/,
    );
  }
});

test("requires an explicit action for a contract v2 request", () => {
  assertContractError(
    () => normalizeTikTokRequest({ contractVersion: 2 }),
    /action is required/,
  );
});

test("rejects unknown contract v2 fields instead of ignoring typos", () => {
  assertContractError(
    () =>
      normalizeTikTokRequest({
        contractVersion: 2,
        action: "preflight",
        expectedHanlde: "creator_account",
      }),
    /unknown field expectedHanlde/,
  );
});

test("does not expose device-local IME configuration through task params", () => {
  for (const forbidden of [
    { adbKeyboard: { enabled: true } },
    { inputMethod: "com.android.adbkeyboard/.AdbIME" },
    { ime: { component: "com.android.adbkeyboard/.AdbIME" } },
    { imeComponent: "com.android.adbkeyboard/.AdbIME" },
  ]) {
    assertContractError(
      () =>
        normalizeTikTokRequest({
          contractVersion: 2,
          action: "preflight",
          ...forbidden,
        }),
      /request contains unknown field/,
    );
  }
});

test("rejects numeric strings in canonical JSON but accepts legacy query strings", () => {
  assertContractError(
    () =>
      normalizeTikTokRequest({
        contractVersion: 2,
        action: "preflight",
        timeout: "420",
      }),
    /timeout must be an integer/,
  );
  const legacy = normalizeTikTokRequest(
    { title: "Legacy title" },
    { timeout: "420", minIntervalSeconds: "1800" },
  );
  assert.equal(legacy.timeoutSeconds, 420);
  assert.equal(legacy.params.policy.minIntervalSeconds, 1800);
});

test("rejects unsafe media and invalid policy values", () => {
  assertContractError(
    () =>
      normalizeTikTokRequest({
        contractVersion: 2,
        action: "publish",
        media: { mode: "direct", kind: "auto", path: "/sdcard/a.mp4" },
        content: { title: "x" },
      }),
    /media.kind/,
  );
  assertContractError(
    () =>
      normalizeTikTokRequest({
        contractVersion: 2,
        action: "publish",
        media: {
          mode: "direct",
          kind: "video",
          path: "/sdcard/../data/local/tmp/a.mp4",
        },
        content: { title: "x" },
      }),
    /safe absolute Android path/,
  );
  assertContractError(
    () =>
      normalizeTikTokRequest({
        contractVersion: 2,
        action: "preflight",
        policy: { maxPostsPerDay: 0 },
      }),
    /maxPostsPerDay/,
  );
  assertContractError(
    () =>
      normalizeTikTokRequest({
        contractVersion: 2,
        action: "publish",
        media: {
          mode: "pool",
          kind: "image",
          paths: Array.from(
            { length: 21 },
            (_, index) => `/sdcard/${index}.jpg`,
          ),
        },
        content: { title: "x" },
      }),
    /more than 20/,
  );
  assertContractError(
    () =>
      normalizeTikTokRequest({
        title: "legacy",
        imagePaths: Array.from(
          { length: 11 },
          (_, index) => `/sdcard/image-${index}.jpg`,
        ),
        videoPaths: Array.from(
          { length: 10 },
          (_, index) => `/sdcard/video-${index}.mp4`,
        ),
      }),
    /at most 20 items in total/,
  );
});

test("enforces image and video caption limits", () => {
  assertContractError(
    () =>
      normalizeTikTokRequest({
        contractVersion: 2,
        action: "publish",
        media: { mode: "direct", kind: "image", path: "/sdcard/a.jpg" },
        content: { title: "x".repeat(91) },
      }),
    /90 UTF-16/,
  );
  assertContractError(
    () =>
      normalizeTikTokRequest({
        contractVersion: 2,
        action: "publish",
        media: { mode: "direct", kind: "video", path: "/sdcard/a.mp4" },
        content: { title: "title", details: "x".repeat(2196) },
      }),
    /2200 UTF-16/,
  );
});

test("supports a lightweight preflight and rejects malformed handles", () => {
  const result = normalizeTikTokRequest({
    contractVersion: 2,
    action: "preflight",
  });
  assert.equal(result.params.action, "preflight");
  assert.match(result.params.publicationId, /^[0-9a-f-]{36}$/);

  assertContractError(
    () =>
      normalizeTikTokRequest({
        contractVersion: 2,
        action: "preflight",
        expectedHandle: "bad handle",
      }),
    /valid TikTok handle/,
  );
});
