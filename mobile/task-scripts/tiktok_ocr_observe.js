var request = __AUTOJS_TASK_PARAMS__;
var OCR_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
var OCR_MAX_PIXELS = 6 * 1024 * 1024;
var OCR_MAX_LINES = 128;
var OCR_MAX_TEXT = 16000;
var OCR_PROFILES = {
  caption: [
    ["所有人可见", "谁可以观看此视频", "Who can view this post", "Who can watch this video"],
    ["更多选项", "More options"], ["发布", "Post"]
  ],
  "more-options": [["更多选项", "More options"], ["内容披露与广告", "内容披露和广告", "Content disclosure and ads"]],
  disclosure: [
    ["内容披露和广告设置", "内容披露与广告设置", "Disclosure and ads setting", "Disclosure and ads settings"],
    ["披露商业内容", "商业内容披露", "Disclose commercial content"], ["保存", "Save"]
  ],
  "own-brand-notice": [
    ["内容公开设置已开启", "Content disclosure setting is on"],
    ["你的作品将被标记为“推广内容”。作品上线后将无法更改此标记。", "Your post will be labeled as promotional content. This label cannot be changed after the post is published."],
    ["返回", "Back"], ["继续", "Continue"]
  ],
  audience: [["谁可以看", "Who can watch this video", "Who can view this post"], ["所有人", "Everyone"], ["好友", "Friends"], ["仅自己", "Only you"]],
  "share-choice": [["在TikTok上分享", "Share to TikTok"], ["视频", "Video"], ["消息", "Messages"]]
};
var OCR_LABEL_ZONES = {
  caption: [[0, 0.25, 1, 0.75], [0, 0.3, 1, 0.8], [0.45, 0.8, 1, 0.99]],
  "more-options": [[0.2, 0.15, 0.8, 0.65], [0, 0.4, 1, 0.98]],
  disclosure: [[0.1, 0.02, 0.9, 0.2], [0, 0.1, 0.95, 0.4], [0.2, 0.8, 0.8, 0.99]],
  "own-brand-notice": [[0.1, 0.25, 0.9, 0.6], [0.1, 0.3, 0.9, 0.7], [0.1, 0.4, 0.5, 0.8], [0.5, 0.4, 0.9, 0.8]],
  audience: [[0.2, 0.35, 0.8, 0.8], [0, 0.45, 0.9, 0.9], [0, 0.5, 0.9, 0.95], [0, 0.55, 0.9, 0.98]],
  "share-choice": [[0.2, 0.4, 0.8, 0.8], [0.05, 0.65, 0.5, 0.98], [0.5, 0.65, 0.95, 0.98]]
};

/** Create a stable refusal without returning platform exception contents. */
function ocrFailure(code) {
  var error = new Error(code);
  error.code = code;
  return error;
}

/** Normalize case and whitespace only; never repair confused characters or spelling. */
function normalizeOcrLabel(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

/** Validate a bounded rectangle inside the original image. */
function validateOcrRegion(value, width, height) {
  if (value === undefined || value === null) return [0, 0, width, height];
  if (Object.prototype.toString.call(value) !== "[object Array]" || value.length !== 4) throw ocrFailure("OCR_REGION_INVALID");
  for (var i = 0; i < 4; i++) if (typeof value[i] !== "number" || !isFinite(value[i]) || Math.floor(value[i]) !== value[i]) throw ocrFailure("OCR_REGION_INVALID");
  if (value[0] < 0 || value[1] < 0 || value[2] < 1 || value[3] < 1 || value[0] + value[2] > width || value[1] + value[3] > height) throw ocrFailure("OCR_REGION_INVALID");
  return value.slice();
}

/** Validate the fixed private-file contract; arbitrary paths are never accepted. */
function validateOcrRequest(value) {
  if (!value || Object.prototype.toString.call(value) !== "[object Object]") throw ocrFailure("OCR_PARAMS_INVALID");
  var allowed = { observationId: true, expectedSha256: true, profile: true, region: true };
  for (var key in value) if (!Object.prototype.hasOwnProperty.call(allowed, key)) throw ocrFailure("OCR_PARAMS_INVALID");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(String(value.observationId || "")) ||
      !/^[a-f0-9]{64}$/.test(String(value.expectedSha256 || "")) ||
      !Object.prototype.hasOwnProperty.call(OCR_PROFILES, String(value.profile || ""))) throw ocrFailure("OCR_PARAMS_INVALID");
  return { observationId: String(value.observationId), expectedSha256: String(value.expectedSha256), profile: String(value.profile), region: value.region };
}

/** Bound native per-line ML Kit results and retain original-image coordinates. */
function normalizeOcrLines(raw, width, height, region) {
  var length = Number(raw && raw.length);
  if (!isFinite(length) || Math.floor(length) !== length || length < 0 || length > OCR_MAX_LINES) throw ocrFailure("OCR_RESULT_LIMIT");
  var lines = [], total = 0;
  for (var i = 0; i < length; i++) {
    var item = raw[i], text = String(item && item.text || ""), b = item && item.bounds;
    if (!text || text.length > 512 || !b) throw ocrFailure("OCR_RESULT_INVALID");
    var left = Number(b.left), top = Number(b.top), right = Number(b.right), bottom = Number(b.bottom);
    var values = [left, top, right, bottom];
    for (var j = 0; j < values.length; j++) if (!isFinite(values[j]) || Math.floor(values[j]) !== values[j]) throw ocrFailure("OCR_RESULT_INVALID");
    if (left < 0 || top < 0 || right <= left || bottom <= top || right > width || bottom > height ||
        left < region[0] || top < region[1] || right > region[0] + region[2] || bottom > region[1] + region[3]) throw ocrFailure("OCR_RESULT_INVALID");
    total += text.length;
    if (total > OCR_MAX_TEXT) throw ocrFailure("OCR_RESULT_LIMIT");
    var confidence = Number(item.confidence);
    lines.push({ text: text, bounds: { left: left, top: top, right: right, bottom: bottom },
      confidence: isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null });
  }
  return lines;
}

/** Return true only when a label center is inside its expected portrait-page region. */
function ocrLabelInsideZone(bounds, zone, width, height) {
  var x = (bounds.left + bounds.right) / 2 / width, y = (bounds.top + bounds.bottom) / 2 / height;
  return x >= zone[0] && y >= zone[1] && x <= zone[2] && y <= zone[3];
}

/** Combine at most three adjacent, aligned lines without changing recognized characters. */
function ocrLabelCandidates(lines) {
  var sorted = lines.slice().sort(function (a, b) { return a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left; });
  var candidates = [];
  for (var i = 0; i < sorted.length; i++) {
    var text = sorted[i].text, b = sorted[i].bounds;
    var combined = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    candidates.push({ text: text, bounds: combined });
    for (var next = i + 1; next < Math.min(i + 3, sorted.length); next++) {
      var last = sorted[next - 1].bounds, n = sorted[next].bounds;
      var overlap = Math.min(last.right, n.right) - Math.max(last.left, n.left);
      if (n.top < last.bottom || n.top - last.bottom > Math.max(last.bottom - last.top, n.bottom - n.top) * 1.8 ||
          overlap < Math.min(last.right - last.left, n.right - n.left) * 0.5) break;
      text += " " + sorted[next].text;
      combined = { left: Math.min(combined.left, n.left), top: combined.top, right: Math.max(combined.right, n.right), bottom: n.bottom };
      candidates.push({ text: text, bounds: combined });
    }
  }
  return candidates;
}

/** Match every required label once without turning text into state or action authority. */
function classifyOcrLines(lines, expectedProfile, width, height) {
  var matches = {}, fullText = lines.map(function (line) { return normalizeOcrLabel(line.text); }).join("\n");
  var modal = /内容公开设置已开启|contentdisclosuresettingison/.test(fullText);
  if (modal && expectedProfile !== "own-brand-notice") throw ocrFailure("OCR_MODAL_BLOCKS_PAGE");
  var groups = OCR_PROFILES[expectedProfile], candidates = ocrLabelCandidates(lines);
  for (var group = 0; group < groups.length; group++) {
    var labels = groups[group], found = [];
    for (var i = 0; i < candidates.length; i++) {
      var normalized = normalizeOcrLabel(candidates[i].text);
      for (var alias = 0; alias < labels.length; alias++) {
        if (normalized === normalizeOcrLabel(labels[alias]) && ocrLabelInsideZone(candidates[i].bounds, OCR_LABEL_ZONES[expectedProfile][group], width, height)) {
          found.push({ text: candidates[i].text, bounds: candidates[i].bounds });
          break;
        }
      }
    }
    if (found.length !== 1) throw ocrFailure(found.length > 1 ? "OCR_LABEL_AMBIGUOUS" : "OCR_PAGE_NOT_IDENTIFIED");
    matches[String(group)] = found[0];
  }
  return matches;
}

/** Read a staged private PNG and obtain one bounded phone-only observation. */
function observePhoneOcr(value, adapter) {
  var params = validateOcrRequest(value), metadata = adapter.inspect(params.observationId);
  if (metadata.bytes < 24 || metadata.bytes > OCR_MAX_IMAGE_BYTES || metadata.width < 1 || metadata.height < 1 ||
      metadata.width > 4096 || metadata.height > 4096 || metadata.width * metadata.height > OCR_MAX_PIXELS) throw ocrFailure("OCR_IMAGE_LIMIT");
  if (metadata.sha256 !== params.expectedSha256) throw ocrFailure("OCR_IMAGE_HASH_MISMATCH");
  var region = validateOcrRegion(params.region, metadata.width, metadata.height), started = Date.now();
  var raw;
  try { raw = adapter.detect(region); } catch (engineError) { throw ocrFailure("OCR_ENGINE_FAILED"); }
  var lines = normalizeOcrLines(raw, metadata.width, metadata.height, region), labels = classifyOcrLines(lines, params.profile, metadata.width, metadata.height);
  return { schemaVersion: 1, status: "LABELS_LOCATED_ONLY", readOnly: true, backend: "phone-autojs6-mlkit",
    observationId: params.observationId, inputSha256: metadata.sha256, imageWidth: metadata.width, imageHeight: metadata.height,
    region: region, expectedProfile: params.profile, recognizedAt: Date.now(), recognitionMs: Date.now() - started,
    lines: lines, labels: labels, uiActions: 0, networkRequests: 0, checkedState: "UNKNOWN", enabledState: "UNKNOWN",
    accountIdentityVerified: false, captionExactnessVerified: false, audioVerified: false, publicationAuthorized: false,
    screenshotFreshnessVerified: false, nextStep: "Independently verify current UI state before any action" };
}

/** Construct the local ML Kit adapter without screen capture or permission requests. */
function createPhoneOcrAdapter() {
  var imageBytes = null;
  return {
    inspect: function (id) {
      var root = String(context.getFilesDir().getCanonicalPath()) + "/one-autojs6-ocr/" + id;
      var file = new java.io.File(root + "/input.png");
      if (String(file.getCanonicalPath()) !== root + "/input.png" || !file.isFile()) throw ocrFailure("OCR_INPUT_UNAVAILABLE");
      var bytes = Number(file.length());
      if (bytes < 24 || bytes > OCR_MAX_IMAGE_BYTES) throw ocrFailure("OCR_IMAGE_LIMIT");
      var stream = new java.io.FileInputStream(file), digest = java.security.MessageDigest.getInstance("SHA-256");
      var content = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, bytes), count, total = 0;
      try {
        while (total < bytes && (count = stream.read(content, total, bytes - total)) > 0) total += count;
        if (total !== bytes || stream.read() !== -1) throw ocrFailure("OCR_INPUT_CHANGED");
      } finally { stream.close(); }
      var hashed = digest.digest(content), sha = "";
      for (var i = 0; i < hashed.length; i++) sha += ("0" + ((Number(hashed[i]) + 256) % 256).toString(16)).slice(-2);
      var header = new java.io.DataInputStream(new java.io.ByteArrayInputStream(content));
      try {
        if (header.readInt() !== -1991225785 || header.readInt() !== 218765834 || header.readInt() !== 13 || header.readInt() !== 1229472850) throw ocrFailure("OCR_PNG_INVALID");
        var width = Number(header.readInt()), height = Number(header.readInt());
      } finally { header.close(); }
      imageBytes = content;
      return { bytes: bytes, sha256: sha, width: width, height: height };
    },
    detect: function (region) {
      if (!imageBytes) throw ocrFailure("OCR_INPUT_UNAVAILABLE");
      var image = images.fromBytes(imageBytes);
      if (!image) throw ocrFailure("OCR_PNG_INVALID");
      try { return ocr.mlkit.detect(image, { region: region }); }
      finally { imageBytes = null; try { image.recycle(); } catch (alreadyRecycled) {} }
    }
  };
}

try {
  taskResult = JSON.stringify(observePhoneOcr(request, createPhoneOcrAdapter()));
} catch (error) {
  taskStatus = "FAILURE";
  taskCode = error && /^OCR_[A-Z_]+$/.test(String(error.code)) ? String(error.code) : "OCR_OBSERVATION_FAILED";
  taskMessage = "Phone OCR observation refused";
  taskResult = JSON.stringify({ schemaVersion: 1, status: "REFUSED", code: taskCode, readOnly: true, uiActions: 0,
    checkedState: "UNKNOWN", enabledState: "UNKNOWN", accountIdentityVerified: false,
    captionExactnessVerified: false, audioVerified: false, publicationAuthorized: false });
}
