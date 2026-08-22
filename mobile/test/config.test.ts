import assert from "node:assert/strict";

import { resolveReportChannels } from "../src/config.js";

assert.deepEqual(resolveReportChannels("mqtt"), {
  mqtt: true,
  http: false,
});
assert.deepEqual(
  resolveReportChannels("mqtt", "https://hodor.example.test/report"),
  {
    mqtt: true,
    http: true,
  },
);
assert.deepEqual(resolveReportChannels("http"), {
  mqtt: false,
  http: true,
});
assert.deepEqual(resolveReportChannels("both"), {
  mqtt: true,
  http: true,
});

console.log("config reporting channel tests passed");
