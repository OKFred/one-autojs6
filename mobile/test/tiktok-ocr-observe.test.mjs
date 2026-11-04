import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../task-scripts/tiktok_ocr_observe.js", import.meta.url), "utf8");
const entrypoint = source.lastIndexOf("\ntry {\n  taskResult =");
assert(entrypoint > 0);
const c = vm.createContext({ __AUTOJS_TASK_PARAMS__: {}, Date, console });
vm.runInContext(source.slice(0, entrypoint), c);
const request = { observationId: "00000000-0000-4000-8000-000000000001", expectedSha256: "a".repeat(64), profile: "disclosure" };
const metadata = { bytes: 120000, width: 1080, height: 2340, sha256: request.expectedSha256 };
let passed = 0;

/** Construct synthetic ML Kit line-shaped data without private screenshots or account text. */
function line(text, x, y, width = 250, height = 50) {
  return { text, confidence: 0.9, bounds: { left: x, top: y, right: x + width, bottom: y + height } };
}

/** Run the pure observer with a bounded fake engine and count recognition calls. */
function run(lines, params = request, meta = metadata) {
  let calls = 0;
  const adapter = { inspect: () => meta, detect: () => { calls++; return lines; } };
  return { result: c.observePhoneOcr(params, adapter), calls };
}

/** Assert one stable refusal without matching raw exception messages. */
function refused(code, operation) {
  assert.throws(operation, error => error.code === code);
  passed++;
}

const fixtures = {
  caption: [line("所有人可见", 100, 1150), line("更多选项", 100, 1320), line("发布", 730, 2140, 140)],
  "more-options": [line("更多选项", 420, 820), line("内容披露与广告", 150, 2010, 400)],
  disclosure: [line("内容披露和广告设置", 300, 180, 480), line("披露商业内容", 80, 460, 400), line("保存", 490, 2140, 100)],
  "own-brand-notice": [line("内容公开设置已开启", 280, 980, 520),
    line("你的作品将被标记为“推广内容”。", 220, 1090, 640),
    line("作品上线后将无法更改此标记。", 220, 1160, 640),
    line("返回", 300, 1280, 90), line("继续", 690, 1280, 90)],
  audience: [line("谁可以看", 430, 1490, 220), line("所有人", 145, 1660, 200), line("好友", 145, 1840, 200), line("仅自己", 145, 2040, 200)],
  "share-choice": [line("在TikTok上分享", 400, 1350, 280), line("视频", 260, 2060, 90), line("消息", 730, 2060, 90)],
};

for (const [profile, lines] of Object.entries(fixtures)) {
  const { result, calls } = run(lines, { ...request, profile });
  assert.equal(result.status, "LABELS_LOCATED_ONLY");
  assert.equal(calls, 1);
  assert.equal(result.readOnly, true);
  assert.equal(result.uiActions, 0);
  assert.equal(result.networkRequests, 0);
  assert.equal(result.checkedState, "UNKNOWN");
  assert.equal(result.enabledState, "UNKNOWN");
  for (const key of ["accountIdentityVerified", "captionExactnessVerified", "audioVerified", "publicationAuthorized", "screenshotFreshnessVerified"]) assert.equal(result[key], false);
  passed++;
}

assert.equal(run(fixtures.disclosure.map(x => ({ ...x, text: x.text.split("").join(" ") }))).result.status, "LABELS_LOCATED_ONLY"); passed++;
refused("OCR_PARAMS_INVALID", () => run(fixtures.disclosure, { ...request, imagePath: "/sdcard/not-allowed.png" }));
refused("OCR_PARAMS_INVALID", () => run(fixtures.disclosure, { ...request, observationId: "../../private" }));
refused("OCR_PARAMS_INVALID", () => run(fixtures.disclosure, { ...request, expectedSha256: "" }));
refused("OCR_PARAMS_INVALID", () => run(fixtures.disclosure, { ...request, profile: "publish" }));
let detectCalls = 0;
refused("OCR_IMAGE_HASH_MISMATCH", () => c.observePhoneOcr(request, { inspect: () => ({ ...metadata, sha256: "b".repeat(64) }), detect: () => { detectCalls++; } }));
assert.equal(detectCalls, 0); passed++;
for (const meta of [{ ...metadata, bytes: 9 * 1024 * 1024 }, { ...metadata, width: 5000 }, { ...metadata, width: 4000, height: 4000 }]) refused("OCR_IMAGE_LIMIT", () => run(fixtures.disclosure, request, meta));
refused("OCR_REGION_INVALID", () => run(fixtures.disclosure, { ...request, region: [0, 0, 1081, 2340] }));
refused("OCR_REGION_INVALID", () => run(fixtures.disclosure, { ...request, region: [0.5, 0, 100, 100] }));
refused("OCR_REGION_INVALID", () => run(fixtures.disclosure, { ...request, region: [0, 0, -1, 100] }));
refused("OCR_LABEL_AMBIGUOUS", () => run([...fixtures.disclosure, line("Save", 490, 2070, 100)]));
refused("OCR_PAGE_NOT_IDENTIFIED", () => run(fixtures.audience));
refused("OCR_PAGE_NOT_IDENTIFIED", () => run([]));
refused("OCR_PAGE_NOT_IDENTIFIED", () => run(fixtures.disclosure.map(x => x.text === "保存" ? { ...x, text: "保仔" } : x)));
refused("OCR_PAGE_NOT_IDENTIFIED", () => run(fixtures.audience.map(x => x.text === "好友" ? { ...x, text: "2好友" } : x), { ...request, profile: "audience" }));
refused("OCR_PAGE_NOT_IDENTIFIED", () => run(fixtures.caption.map(x => x.text === "发布" ? line("发布", 730, 300, 140) : x), { ...request, profile: "caption" }));
refused("OCR_MODAL_BLOCKS_PAGE", () => run([...fixtures.disclosure, ...fixtures["own-brand-notice"]]));
refused("OCR_RESULT_INVALID", () => run([line("保存", -1, 2140, 100)]));
refused("OCR_RESULT_INVALID", () => run([line("保存", 490, 2140, 100.5)]));
refused("OCR_RESULT_INVALID", () => run(fixtures.disclosure, { ...request, region: [0, 1400, 1080, 800] }));
refused("OCR_RESULT_LIMIT", () => run(Array.from({ length: 129 }, () => line("text", 10, 200))));
refused("OCR_ENGINE_FAILED", () => c.observePhoneOcr(request, { inspect: () => metadata, detect: () => { throw Error("PRIVATE_PATH_AND_CONTENT_MUST_NOT_LEAK"); } }));

const cropped = run(fixtures.audience, { ...request, profile: "audience", region: [130, 1400, 700, 800] });
assert.equal(cropped.result.labels["1"].bounds.top, 1660); passed++;
assert.equal(cropped.result.inputSha256, request.expectedSha256); passed++;
assert.equal(source.includes("ocr.mlkit.detect(image, { region: region })"), true); passed++;
assert.doesNotMatch(source, /\b(?:captureScreen|requestScreenCapture|click|press|setText|launchApp|startActivity)\s*\(/); passed++;
assert.doesNotMatch(source, /\b(?:http|fetch|XMLHttpRequest)\b/); passed++;
console.log(`${passed} phone OCR observation regressions passed; synthetic data only, no device or provider used.`);
