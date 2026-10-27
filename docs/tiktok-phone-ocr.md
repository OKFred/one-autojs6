# Phone-only TikTok OCR observation

`mobile/task-scripts/tiktok_ocr_observe.js` is a read-only supplement for identifying menu labels from an already captured PNG. Recognition runs inside the installed Android AutoJs6 ML Kit engine. It does not use desktop OCR, a cloud OCR provider, screen-capture permission, a new APK or a second publishing service.

The script is deliberately not registered or remotely allowlisted by this change. It cannot make an existing TikTok task succeed, retry a publication, alter an approval or replace the native publication ledger. Adding a production task registration requires separate review and device acceptance. Any future PC dispatch must use the existing asynchronous task queue and ordinary task-result polling; do not add a synchronous OCR HTTP endpoint.

## Input and result

The trusted caller stages one PNG at the application's own canonical private path:

```text
<context.getFilesDir()>/one-autojs6-ocr/<observationId>/input.png
```

No user-supplied file path is accepted. The request is provided through the existing `__AUTOJS_TASK_PARAMS__` wrapper convention:

```json
{
  "observationId": "00000000-0000-4000-8000-000000000001",
  "expectedSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "profile": "audience",
  "region": [130, 1400, 700, 800]
}
```

The sample UUID and digest are synthetic. Use the actual immutable screenshot digest. `region` is optional and is `[left, top, width, height]` in original-image pixels. The dimensions and every region must be bounded before the recognizer runs. Hashing, PNG-header inspection and decoding use the same byte array, rather than reopening a file after checking its hash. A caller must own the screenshot acquisition, verify its source/currentness separately, and preserve the screenshot and result privately.

Profiles are `caption`, `more-options`, `disclosure`, `own-brand-notice`, `audience` and `share-choice`. Their portrait-screen label regions are intentionally conservative. A recognition result does not establish support for a new TikTok layout, landscape display or untested UI language. Exact aliases allow case/whitespace normalization only. Icons fused into labels, such as `2好友`, are refused; use a newly bounded text-only crop rather than changing `2` into another character. At most three aligned adjacent OCR lines may be joined to match the exact known informational paragraph.

On success `taskResult` contains JSON with `status: "LABELS_LOCATED_ONLY"`, screenshot hash/dimensions, original-image text rectangles, raw recognized lines and recognition timing. The native result's optional confidence is retained only as recognition metadata. It is not a setting-state or action-authorization score. Refusals have stable `OCR_*` codes and do not include native exception text or private file paths. The existing trusted wrapper retains responsibility for its task deadline and result file; this script creates no output file or network connection itself.

The script does not claim:

- Screenshot freshness, account identity, exact complete caption or media identity.
- Checkbox/switch selected state, whether a control is enabled, or a complete absence of unknown dialogs.
- Sound, public playback, merchant approval or permission to tap Post.

Known own-brand information dialogs block a different requested page; missing/duplicate required labels, changed hashes, wrong regions and invalid results stop observation. A caller must still inspect current UI state and stop on unknown or legal/security prompts. OCR never authorizes a click, modifies privacy/disclosure, infers a checked switch from text, selects music or publishes content.

## Limits and verification

Input limits are 8 MiB, 4096 pixels per dimension and 6 Mi pixels. Results are limited to 128 lines, 512 characters per line and 16,000 characters total. Only a fixed canonical application-private PNG is read. Explicit `ocr.mlkit.detect(image, { region })` prevents reliance on a mutable default OCR mode. No OCR call without an explicit decoded image is made.

Run focused synthetic contract/refusal checks from the repository root:

```text
node mobile/test/tiktok-ocr-observe.test.mjs
```

Synthetic tests are separate from actual-phone validation. Before operational use, verify the installed engine/version, real result fields and region-coordinate behavior on that phone, then run the completed script on retained screenshots and a fresh current page without tapping anything. Keep actual account images, recognized text, hashes, timings, failed attempts and device diagnostics private. Passing screenshot OCR does not prove unattended TikTok publication.

The device trial for this change confirmed the installed ML Kit API, byte-array decoding and original-image coordinates. A retained audience screenshot passed in a bounded text crop, and changed-hash/wrong-page requests were refused. Two disclosure screenshots and a fresh audience screenshot were also refused because required exact labels were missing. Those failed recognitions are retained; this is not acceptance of an automatic OCR fallback for the publishing flow. Continue to use independently verified accessibility state and attended observation. The separate decorative-public-icon fix passed a read-only check on real audience controls; no test publication was submitted.

Official source references consulted for the adapter:

- [AutoJs6 ML Kit adapter](https://github.com/SuperMonster003/AutoJs6/blob/master/app/src/main/java/org/autojs/autojs/runtime/api/augment/ocr/OcrMLKit.kt).
- [AutoJs6 OCR region handling](https://github.com/SuperMonster003/AutoJs6/blob/master/app/src/main/java/org/autojs/autojs/runtime/api/augment/ocr/Ocr.kt).
- [AutoJs6 OCR result fields](https://github.com/SuperMonster003/AutoJs6/blob/master/app/src/main/java/org/autojs/autojs/runtime/api/OcrResult.kt).
- [AutoJs6 image byte decoding](https://github.com/SuperMonster003/AutoJs6/blob/master/app/src/main/java/org/autojs/autojs/runtime/api/augment/images/Images.kt).
- [Google ML Kit text recognition on Android](https://developers.google.com/ml-kit/vision/text-recognition/v2/android).
