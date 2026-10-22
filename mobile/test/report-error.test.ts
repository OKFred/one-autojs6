import assert from "node:assert/strict";

import { createHttpReportError } from "../src/report-error.js";

assert.equal(
  createHttpReportError(422, {
    ok: false,
    message: "contains a device identifier and must never be logged",
    data: {
      code: "VALIDATION_FAILED",
      details: [{ type: "detail_error", message: "sensitive reason" }],
    },
  }).message,
  "HTTP_REPORT_REJECTED status=422 code=VALIDATION_FAILED details=array:1",
);

assert.equal(
  createHttpReportError(401, {
    data: { code: "bad token value", details: "sensitive text" },
  }).message,
  "HTTP_REPORT_REJECTED status=401 details=string",
);

assert.equal(
  createHttpReportError(500, null).message,
  "HTTP_REPORT_REJECTED status=500 details=none",
);

console.log("report error tests passed");
