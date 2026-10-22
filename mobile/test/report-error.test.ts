import assert from "node:assert/strict";

import { createHttpReportError } from "../src/report-error.js";

assert.equal(
  createHttpReportError(422, {
    ok: false,
    message: "contains a device identifier and must never be logged",
    data: {
      code: "VALIDATION_FAILED",
      details: [
        { type: "detail_error", message: "Missing device report token" },
      ],
    },
  }).message,
  "HTTP_REPORT_REJECTED status=422 code=VALIDATION_FAILED reason=MISSING_DEVICE_REPORT_TOKEN details=array:1",
);

assert.equal(
  createHttpReportError(401, {
    data: { code: "bad token value", details: "sensitive text" },
  }).message,
  "HTTP_REPORT_REJECTED status=401 reason=unknown details=string",
);

assert.equal(
  createHttpReportError(500, null).message,
  "HTTP_REPORT_REJECTED status=500 reason=unknown details=none",
);

assert.equal(
  createHttpReportError(422, {
    data: {
      code: "VALIDATION_FAILED",
      details: [
        {
          type: "detail_error",
          message: "Unknown or disabled device",
          params: { deviceId: "must-not-appear" },
        },
      ],
    },
  }).message,
  "HTTP_REPORT_REJECTED status=422 code=VALIDATION_FAILED reason=UNKNOWN_OR_DISABLED_DEVICE details=array:1",
);

assert.equal(
  createHttpReportError(422, {
    data: {
      code: "VALIDATION_FAILED",
      details: [
        {
          type: "detail_error",
          message: "Invalid or expired device report token",
        },
      ],
    },
  }).message,
  "HTTP_REPORT_REJECTED status=422 code=VALIDATION_FAILED reason=INVALID_OR_EXPIRED_DEVICE_REPORT_TOKEN details=array:1",
);

assert.equal(
  createHttpReportError(422, {
    data: {
      code: "VALIDATION_FAILED",
      details: [
        {
          type: "detail_error",
          message: "Invalid operations capability",
        },
      ],
    },
  }).message,
  "HTTP_REPORT_REJECTED status=422 code=VALIDATION_FAILED reason=INVALID_OPERATIONS_CAPABILITY details=array:1",
);

assert.equal(
  createHttpReportError(422, {
    data: {
      code: "VALIDATION_FAILED",
      details: [
        {
          type: "detail_error",
          message: "Invalid operations capability: device.telephony.get",
        },
      ],
    },
  }).message,
  "HTTP_REPORT_REJECTED status=422 code=VALIDATION_FAILED reason=unknown details=array:1",
);

assert.equal(
  createHttpReportError(422, {
    data: {
      code: "VALIDATION_FAILED",
      details: [
        { type: "timestamp", message: "translated arbitrary text" },
        { type: "identifiers/imeis", message: "contains a raw IMEI" },
        {
          type: "identifiers.imeiStatus",
          message: "required property error",
        },
      ],
    },
  }).message,
  "HTTP_REPORT_REJECTED status=422 code=VALIDATION_FAILED reason=unknown fields=identifiers.imeiStatus,identifiers.imeis,timestamp details=array:3",
);

assert.equal(
  createHttpReportError(200, {
    ok: false,
    message: "logical rejection",
    data: {
      code: "VALIDATION_FAILED",
      details: [{ type: "detail_error", message: "unrecognized reason" }],
    },
  }).message,
  "HTTP_REPORT_REJECTED status=200 code=VALIDATION_FAILED reason=unknown details=array:1",
);

assert.equal(
  createHttpReportError(502, "not json").message,
  "HTTP_REPORT_REJECTED status=502 reason=unknown details=none",
);

assert.equal(
  createHttpReportError(422, {
    data: {
      code: "EVIL_DEVICE_1234",
      details: [
        {
          type: "deviceId=raw-device-id",
          message: "Missing device report token ",
          nested: {
            type: "deviceId",
            message: "Unknown or disabled device",
          },
        },
        { type: "identifiers/imeis/0", message: "indexed raw value" },
        { type: "identifiers/unknown", message: "unknown child" },
        ["Invalid or expired device report token"],
      ],
    },
  }).message,
  "HTTP_REPORT_REJECTED status=422 reason=unknown details=array:4",
);

console.log("report error tests passed");
