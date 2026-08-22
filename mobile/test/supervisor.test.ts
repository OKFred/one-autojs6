import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { prepareRuntimeDirectories } from "../bootstrap/supervisor.mjs";

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "one-autojs6-supervisor-test-"),
);
try {
  const directories = prepareRuntimeDirectories(
    {
      environment: "staging",
      deploymentId: "11111111-1111-4111-8111-111111111111",
    },
    temporaryRoot,
  );
  assert.deepEqual(Object.keys(directories).sort(), [
    "logsDirectory",
    "runtimeDirectory",
    "sharedStateDirectory",
    "stateDirectory",
  ]);
  for (const directory of Object.values(directories)) {
    assert.equal(fs.statSync(directory).isDirectory(), true);
  }
  assert.throws(
    () =>
      prepareRuntimeDirectories(
        { environment: "preview", deploymentId: "active" },
        temporaryRoot,
      ),
    /Unsupported deployment environment/,
  );
  assert.throws(
    () =>
      prepareRuntimeDirectories(
        { environment: "production", deploymentId: "../outside" },
        temporaryRoot,
      ),
    /Invalid deployment identifier/,
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("supervisor tests passed");
