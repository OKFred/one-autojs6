import assert from "assert/strict";
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import {
  DeploymentManager,
  isSafeArchiveSymlink,
  type PendingActivation,
} from "../src/deployment-manager.js";
import { parseDeviceDeploymentCommand } from "../src/deployment-protocol.js";

/** 计算内存或文件内容摘要。 */
function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** 创建最小可信发布归档。 */
function createArtifact(
  root: string,
  extraFile = false,
): {
  body: Buffer;
  digest: string;
} {
  const releaseRoot = path.join(root, "artifact-root");
  const entrypoint = path.join(releaseRoot, "dist", "client.js");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, "console.log('release');\n", "utf8");
  if (extraFile) {
    fs.writeFileSync(path.join(releaseRoot, "undeclared.txt"), "unexpected\n");
  }
  const manifest = {
    formatVersion: 1,
    releaseVersion: "v2.0.0",
    packageVersion: "2.0.0",
    gitCommit: "a5c1ed4",
    createdAt: "2026-08-14T00:00:00.000Z",
    protocolVersion: 2,
    deploymentProtocolVersion: 1,
    minimumSupervisorVersion: "1.0.0",
    entrypoint: "dist/client.js",
    files: { "dist/client.js": sha256(fs.readFileSync(entrypoint)) },
  };
  fs.writeFileSync(
    path.join(releaseRoot, "release-manifest.json"),
    JSON.stringify(manifest),
  );
  const archivePath = path.join(root, "release.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", releaseRoot, "."]);
  const body = fs.readFileSync(archivePath);
  return { body, digest: sha256(body) };
}

/** 构造合法部署命令。 */
function command(artifact: { body: Buffer; digest: string }) {
  return {
    protocolVersion: 1,
    deploymentId: "11111111-1111-4111-8111-111111111111",
    deviceId: "phone-001",
    release: {
      version: "v2.0.0",
      artifactUrl: "https://storage.example/release.tar.gz",
      artifactSha256: artifact.digest,
      artifactSize: artifact.body.byteLength,
    },
    environment: {
      name: "production",
      revision: 1,
      config: { tasks: { queueLimit: 20 } },
      requiredSecretKeys: ["BUSINESS_API_KEY"],
    },
    activationMode: "GRACEFUL",
    drainTimeoutMs: 900_000,
    createdAt: 1_000,
    expiresAt: 2_000_000,
  };
}

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "one-autojs6-deployment-test-"),
);
try {
  assert.equal(
    isSafeArchiveSymlink(
      "./node_modules/.pnpm/mqtt/node_modules/debug",
      "../../debug/node_modules/debug",
    ),
    true,
  );
  assert.equal(
    isSafeArchiveSymlink("./node_modules/mqtt", "../../../outside"),
    false,
  );
  assert.equal(
    isSafeArchiveSymlink("./node_modules/mqtt", "/system/bin/sh"),
    false,
  );

  const artifact = createArtifact(temporaryRoot);
  const deploymentRoot = path.join(temporaryRoot, "runtime");
  fs.mkdirSync(path.join(deploymentRoot, "secrets"), { recursive: true });
  fs.writeFileSync(
    path.join(deploymentRoot, "secrets", "production.env"),
    "BUSINESS_API_KEY=local-only\n",
    { mode: 0o600 },
  );
  const events: Array<{ phase: string; code: string }> = [];
  let activation: PendingActivation | null = null;
  const manager = new DeploymentManager({
    deviceId: "phone-001",
    rootDirectory: deploymentRoot,
    now: () => 1_500,
    fetchArtifact: async () =>
      new Response(artifact.body, {
        status: 200,
        headers: { "Content-Type": "application/gzip" },
      }),
    hooks: {
      blockTaskIntake: () => undefined,
      unblockTaskIntake: () => undefined,
      cancelQueuedTasks: () => undefined,
      isTaskExecutorIdle: () => true,
      forceStopActiveTask: async () => true,
      publishEvent: async (event) => {
        events.push({ phase: event.phase, code: event.code });
      },
      activate: async (pending) => {
        activation = pending;
      },
    },
  });
  await manager.handle(command(artifact));
  assert.ok(activation, JSON.stringify(events));
  assert.equal(activation?.releaseVersion, "v2.0.0");
  assert.equal(activation?.environment, "production");
  assert.deepEqual(
    events.map((event) => event.phase),
    ["STAGING", "DRAINING", "ACTIVATING"],
  );
  assert.equal(
    fs.existsSync(
      path.join(deploymentRoot, "releases", "v2.0.0", "dist", "client.js"),
    ),
    true,
  );

  assert.throws(
    () =>
      parseDeviceDeploymentCommand({
        ...command(artifact),
        environment: {
          ...command(artifact).environment,
          config: { apiToken: "must-not-be-centralized" },
        },
      }),
    /sensitive key/,
  );

  const missingSecretEvents: Array<{ phase: string; code: string }> = [];
  const missingSecretRoot = path.join(temporaryRoot, "missing-secret-runtime");
  const missingSecretManager = new DeploymentManager({
    deviceId: "phone-001",
    rootDirectory: missingSecretRoot,
    now: () => 1_500,
    fetchArtifact: async () => new Response(artifact.body, { status: 200 }),
    hooks: {
      blockTaskIntake: () => undefined,
      unblockTaskIntake: () => undefined,
      cancelQueuedTasks: () => undefined,
      isTaskExecutorIdle: () => true,
      forceStopActiveTask: async () => true,
      publishEvent: async (event) => {
        missingSecretEvents.push({ phase: event.phase, code: event.code });
      },
      activate: async () => assert.fail("missing secrets must not activate"),
    },
  });
  await missingSecretManager.handle(command(artifact));
  assert.equal(missingSecretEvents.at(-1)?.code, "ENVIRONMENT_SECRETS_MISSING");

  const tamperedEvents: Array<{ phase: string; code: string }> = [];
  const tamperedManager = new DeploymentManager({
    deviceId: "phone-001",
    rootDirectory: path.join(temporaryRoot, "tampered-runtime"),
    now: () => 1_500,
    fetchArtifact: async () => new Response(artifact.body, { status: 200 }),
    hooks: {
      blockTaskIntake: () => undefined,
      unblockTaskIntake: () => undefined,
      cancelQueuedTasks: () => undefined,
      isTaskExecutorIdle: () => true,
      forceStopActiveTask: async () => true,
      publishEvent: async (event) => {
        tamperedEvents.push({ phase: event.phase, code: event.code });
      },
      activate: async () => assert.fail("tampered artifacts must not activate"),
    },
  });
  const tamperedCommand = command(artifact);
  tamperedCommand.release.artifactSha256 = "0".repeat(64);
  await tamperedManager.handle(tamperedCommand);
  assert.equal(tamperedEvents.at(-1)?.code, "ARTIFACT_DIGEST_MISMATCH");

  const undeclaredArtifact = createArtifact(
    path.join(temporaryRoot, "undeclared-artifact"),
    true,
  );
  const undeclaredEvents: Array<{ phase: string; code: string }> = [];
  const undeclaredRoot = path.join(temporaryRoot, "undeclared-runtime");
  fs.mkdirSync(path.join(undeclaredRoot, "secrets"), { recursive: true });
  fs.writeFileSync(
    path.join(undeclaredRoot, "secrets", "production.env"),
    "BUSINESS_API_KEY=local-only\n",
  );
  const undeclaredManager = new DeploymentManager({
    deviceId: "phone-001",
    rootDirectory: undeclaredRoot,
    now: () => 1_500,
    fetchArtifact: async () =>
      new Response(undeclaredArtifact.body, { status: 200 }),
    hooks: {
      blockTaskIntake: () => undefined,
      unblockTaskIntake: () => undefined,
      cancelQueuedTasks: () => undefined,
      isTaskExecutorIdle: () => true,
      forceStopActiveTask: async () => true,
      publishEvent: async (event) => {
        undeclaredEvents.push({ phase: event.phase, code: event.code });
      },
      activate: async () => assert.fail("undeclared files must not activate"),
    },
  });
  await undeclaredManager.handle(command(undeclaredArtifact));
  assert.equal(undeclaredEvents.at(-1)?.code, "MANIFEST_FILE_SET_MISMATCH");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("deployment tests passed");
