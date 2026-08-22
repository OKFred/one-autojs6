import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform === "win32") {
  console.log("supervisor rollback integration skipped on Windows");
  process.exit(0);
}

const supervisorPath = path.resolve(
  process.argv[2] ||
    new URL("../bootstrap/supervisor.mjs", import.meta.url).pathname,
);
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "one-autojs6-supervisor-rollback-"),
);
const healthyRelease = path.join(temporaryRoot, "releases", "v-good");
const failingRelease = path.join(temporaryRoot, "releases", "v-bad");
const healthyDeploymentId = "11111111-1111-4111-8111-111111111111";
const failingDeploymentId = "22222222-2222-4222-8222-222222222222";
const healthyRestartedPath = path.join(temporaryRoot, "healthy-restarted");

function descriptor(
  deploymentId,
  releaseVersion,
  releaseDirectory,
  environment,
) {
  return {
    formatVersion: 1,
    deploymentId,
    releaseVersion,
    releaseDigest: "a".repeat(64),
    releaseDirectory,
    entrypoint: "entrypoint.mjs",
    environment,
    environmentRevision: 1,
    environmentConfigPath: path.join(
      temporaryRoot,
      "environments",
      environment,
      "revisions",
      "1.json",
    ),
    secretPath: path.join(temporaryRoot, "secrets", `${environment}.env`),
    createdAt: Date.now(),
  };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for supervisor rollback");
}

let supervisor;
try {
  fs.mkdirSync(healthyRelease, { recursive: true });
  fs.mkdirSync(failingRelease, { recursive: true });
  fs.mkdirSync(path.join(temporaryRoot, "run"), { recursive: true });
  fs.writeFileSync(
    path.join(healthyRelease, "entrypoint.mjs"),
    `import fs from "node:fs";
const root = process.env.AUTOJS6_DEPLOYMENT_ROOT;
const triggered = root + "/activation-triggered";
if (!fs.existsSync(triggered)) {
  fs.writeFileSync(triggered, "1");
  process.exit(98);
}
fs.writeFileSync(root + "/healthy-restarted", "1");
setInterval(() => {}, 1000);
`,
  );
  fs.writeFileSync(
    path.join(failingRelease, "entrypoint.mjs"),
    "process.exit(1);\n",
  );
  const healthy = descriptor(
    healthyDeploymentId,
    "v-good",
    healthyRelease,
    "production",
  );
  const failing = descriptor(
    failingDeploymentId,
    "v-bad",
    failingRelease,
    "staging",
  );
  fs.writeFileSync(
    path.join(temporaryRoot, "active.json"),
    `${JSON.stringify(healthy)}\n`,
  );
  fs.writeFileSync(
    path.join(temporaryRoot, "run", "pending-activation.json"),
    `${JSON.stringify(failing)}\n`,
  );

  supervisor = spawn(process.execPath, [supervisorPath], {
    detached: true,
    env: {
      ...process.env,
      AUTOJS6_DEPLOYMENT_ROOT: temporaryRoot,
      HOME: temporaryRoot,
    },
    stdio: "ignore",
  });
  const outcomePath = path.join(
    temporaryRoot,
    "run",
    "deployment-outcomes",
    `${failingDeploymentId}.json`,
  );
  await waitFor(
    () => fs.existsSync(outcomePath) && fs.existsSync(healthyRestartedPath),
  );
  const outcome = JSON.parse(fs.readFileSync(outcomePath, "utf8"));
  const active = JSON.parse(
    fs.readFileSync(path.join(temporaryRoot, "active.json"), "utf8"),
  );
  assert.equal(outcome.phase, "ROLLED_BACK");
  assert.equal(outcome.code, "HEALTH_CHECK_FAILED");
  assert.equal(active.releaseVersion, "v-good");
  assert.equal(
    fs.realpathSync(path.join(temporaryRoot, "current")),
    healthyRelease,
  );
  for (const directory of [
    "state/production",
    "state/staging",
    "state/shared",
    "logs/production",
    "logs/staging",
  ]) {
    assert.equal(
      fs.statSync(path.join(temporaryRoot, directory)).isDirectory(),
      true,
    );
  }
  console.log("supervisor rollback integration passed");
} finally {
  if (supervisor?.pid) {
    try {
      process.kill(-supervisor.pid, "SIGTERM");
      await Promise.race([
        once(supervisor, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      // The isolated supervisor may already have exited.
    }
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
