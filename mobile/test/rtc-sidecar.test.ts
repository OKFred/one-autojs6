import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RTC_SIDECAR_INPUT_RECORD,
  RtcSidecarProcess,
  RtcSidecarRecordDecoder,
  encodeRtcSidecarRecord,
  verifyRtcSidecarExecutable,
} from "../src/rtc-sidecar-client.js";

const golden = encodeRtcSidecarRecord(
  RTC_SIDECAR_INPUT_RECORD.BINARY,
  Buffer.from([0xaa, 0xbb]),
);
assert.equal(golden.toString("hex"), "0000000304aabb");

const decoder = new RtcSidecarRecordDecoder();
assert.deepEqual(decoder.push(golden.subarray(0, 2)), []);
assert.deepEqual(decoder.push(golden.subarray(2, 6)), []);
assert.deepEqual(decoder.push(golden.subarray(6)), [
  { type: RTC_SIDECAR_INPUT_RECORD.BINARY, payload: Buffer.from([0xaa, 0xbb]) },
]);

assert.throws(() => new RtcSidecarRecordDecoder().push(Buffer.alloc(4)));

const unstartedSidecar = new RtcSidecarProcess({
  executablePath: "unused-in-empty-frame-test",
  expectedSha256: "0".repeat(64),
  callbacks: {
    onLocalDescription: () => undefined,
    onIceCandidate: () => undefined,
    onState: () => undefined,
    onBinary: () => undefined,
  },
});
assert.throws(
  () => unstartedSidecar.sendBinary(Buffer.alloc(0)),
  /1 byte to 4 MiB/,
);

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "one-autojs6-sidecar-test-"),
);
try {
  const executablePath = path.join(temporaryDirectory, "sidecar");
  const content = Buffer.from("immutable-sidecar-test", "utf8");
  fs.writeFileSync(executablePath, content);
  const expectedSha256 = crypto.createHash("sha256").update(content).digest("hex");
  verifyRtcSidecarExecutable({ executablePath, expectedSha256 });
  fs.chmodSync(executablePath, 0o600);
  fs.writeFileSync(executablePath, Buffer.from("tampered", "utf8"));
  assert.throws(
    () => verifyRtcSidecarExecutable({ executablePath, expectedSha256 }),
    /manifest verification/,
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("rtc sidecar IPC and manifest verification tests passed");
