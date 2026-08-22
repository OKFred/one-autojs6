import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SUPERVISOR_VERSION = "1.0.1";
const HEALTH_TIMEOUT_MS = 90_000;
const RESTART_DELAY_MS = 5_000;
const rootDirectory = path.resolve(
  process.env.AUTOJS6_DEPLOYMENT_ROOT ||
    path.join(process.env.HOME || ".", ".local", "share", "one-autojs6"),
);
const runDirectory = path.join(rootDirectory, "run");
const activePath = path.join(rootDirectory, "active.json");
const previousPath = path.join(rootDirectory, "previous-healthy.json");
const pendingPath = path.join(runDirectory, "pending-activation.json");
const currentLink = path.join(rootDirectory, "current");
const configuredNodeExecutable = process.env.PREFIX
  ? path.join(process.env.PREFIX, "bin", "node")
  : "";
const nodeExecutable =
  configuredNodeExecutable && fs.existsSync(configuredNodeExecutable)
    ? configuredNodeExecutable
    : process.execPath;

/** 等待固定时长。 */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 原子写入 JSON 文件。 */
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
}

/** 读取并校验对象 JSON。 */
function readJson(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid supervisor JSON: ${filePath}`);
  }
  return value;
}

/** 读取受限 KEY=VALUE 文件。 */
function readEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const result = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const matched = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!matched) throw new Error(`Invalid environment line in ${filePath}`);
    let value = matched[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[matched[1]] = value;
  }
  return result;
}

/** 为目标环境创建互相隔离的持久化和运行目录。 */
export function prepareRuntimeDirectories(
  descriptor,
  deploymentRoot = rootDirectory,
) {
  if (
    descriptor.environment !== "development" &&
    descriptor.environment !== "staging" &&
    descriptor.environment !== "production"
  ) {
    throw new Error("Unsupported deployment environment");
  }
  const deploymentId = descriptor.deploymentId || "active";
  if (deploymentId !== "active" && !/^[0-9a-fA-F-]{36}$/.test(deploymentId)) {
    throw new Error("Invalid deployment identifier");
  }
  const directories = {
    stateDirectory: path.join(deploymentRoot, "state", descriptor.environment),
    sharedStateDirectory: path.join(deploymentRoot, "state", "shared"),
    logsDirectory: path.join(deploymentRoot, "logs", descriptor.environment),
    runtimeDirectory: path.join(deploymentRoot, "run", deploymentId),
  };
  for (const directory of Object.values(directories)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return directories;
}

/** 安全替换当前发布目录软链。 */
function switchCurrentLink(releaseDirectory) {
  const releasesRoot = path.resolve(rootDirectory, "releases");
  const resolvedRelease = path.resolve(releaseDirectory);
  if (!resolvedRelease.startsWith(`${releasesRoot}${path.sep}`)) {
    throw new Error("Release directory escapes supervisor release root");
  }
  if (!fs.statSync(resolvedRelease).isDirectory()) {
    throw new Error("Release directory is unavailable");
  }
  const temporaryLink = `${currentLink}.${process.pid}.tmp`;
  fs.rmSync(temporaryLink, { force: true });
  fs.symlinkSync(resolvedRelease, temporaryLink, "dir");
  fs.renameSync(temporaryLink, currentLink);
}

/** 构造客户端子进程环境，管理通道优先且不可被环境密钥覆盖。 */
function childEnvironment(descriptor, readyFile) {
  const runtimeDirectories = prepareRuntimeDirectories(descriptor);
  const management = readEnvFile(
    path.join(rootDirectory, "device", "management.env"),
  );
  const environmentSecrets = readEnvFile(descriptor.secretPath);
  const protectedManagementKeys = new Set([
    "EMQX_PROTOCOL",
    "EMQX_USERNAME",
    "EMQX_PASSWORD",
    "EMQX_HOST",
    "EMQX_PORT",
    "AUTOJS6_REPORT_URL",
    "AUTOJS6_REPORT_TOKEN",
  ]);
  for (const key of protectedManagementKeys) {
    if (Object.hasOwn(environmentSecrets, key)) {
      throw new Error(
        `Environment secret cannot override management key ${key}`,
      );
    }
  }
  return {
    ...process.env,
    ...management,
    ...environmentSecrets,
    AUTOJS6_DEPLOYMENT_ROOT: rootDirectory,
    AUTOJS6_RELEASE_MANIFEST_PATH: path.join(
      descriptor.releaseDirectory,
      "release-manifest.json",
    ),
    AUTOJS6_CONFIG_PATH: descriptor.environmentConfigPath,
    AUTOJS6_STATE_DIR: runtimeDirectories.stateDirectory,
    AUTOJS6_SHARED_STATE_DIR: runtimeDirectories.sharedStateDirectory,
    AUTOJS6_LOG_DIR: runtimeDirectories.logsDirectory,
    AUTOJS6_RUNTIME_DIR: runtimeDirectories.runtimeDirectory,
    AUTOJS6_ENVIRONMENT: descriptor.environment,
    AUTOJS6_ENVIRONMENT_REVISION: String(descriptor.environmentRevision),
    AUTOJS6_RELEASE_DIGEST: descriptor.releaseDigest,
    AUTOJS6_DEPLOYMENT_ID: descriptor.deploymentId || "",
    AUTOJS6_SUPERVISOR_VERSION: SUPERVISOR_VERSION,
    AUTOJS6_DEPLOYMENT_READY_FILE: readyFile || "",
  };
}

/** 启动当前描述指定的客户端进程。 */
function spawnClient(descriptor, readyFile = "") {
  const entrypoint = path.resolve(
    descriptor.releaseDirectory,
    descriptor.entrypoint,
  );
  if (
    !entrypoint.startsWith(
      `${path.resolve(descriptor.releaseDirectory)}${path.sep}`,
    )
  ) {
    throw new Error("Release entrypoint escapes release directory");
  }
  return spawn(nodeExecutable, [entrypoint], {
    cwd: descriptor.releaseDirectory,
    env: childEnvironment(descriptor, readyFile),
    stdio: "inherit",
  });
}

/** 等待子进程退出。 */
function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/** 等待新客户端写入健康标记或提前退出。 */
async function verifyClient(child, readyFile) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) return true;
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await delay(250);
  }
  return false;
}

/** 保存供恢复后客户端上报的 supervisor 结果。 */
function writeOutcome(descriptor, phase, code, message) {
  const outcomePath = path.join(
    runDirectory,
    "deployment-outcomes",
    `${descriptor.deploymentId}.json`,
  );
  writeJson(outcomePath, {
    protocolVersion: 1,
    deploymentId: descriptor.deploymentId,
    phase,
    code,
    message,
    releaseVersion: descriptor.releaseVersion,
    environment: descriptor.environment,
    environmentRevision: descriptor.environmentRevision,
    timestamp: Date.now(),
  });
}

/** 清理发布目录，仅保留当前和两个历史版本。 */
function pruneReleases(active, previous) {
  const releasesRoot = path.join(rootDirectory, "releases");
  if (!fs.existsSync(releasesRoot)) return;
  const pinned = new Set([
    path.resolve(active.releaseDirectory),
    previous ? path.resolve(previous.releaseDirectory) : "",
  ]);
  const directories = fs
    .readdirSync(releasesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(releasesRoot, entry.name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const keep = new Set([...pinned].filter(Boolean));
  for (const item of directories) {
    if (keep.size >= 3) break;
    keep.add(path.resolve(item.fullPath));
  }
  for (const item of directories) {
    if (!keep.has(path.resolve(item.fullPath))) {
      fs.rmSync(item.fullPath, { recursive: true, force: true });
    }
  }
}

/** 激活待部署版本并执行 90 秒健康门禁。 */
async function activatePending(previous) {
  const pending = readJson(pendingPath);
  const readyFile = path.join(
    runDirectory,
    "ready",
    `${pending.deploymentId}.ready`,
  );
  fs.rmSync(readyFile, { force: true });
  writeJson(previousPath, previous);
  switchCurrentLink(pending.releaseDirectory);
  writeJson(activePath, pending);
  const child = spawnClient(pending, readyFile);
  if (await verifyClient(child, readyFile)) {
    fs.rmSync(pendingPath, { force: true });
    pruneReleases(pending, previous);
    return { descriptor: pending, child, healthy: true };
  }
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  await Promise.race([waitForExit(child), delay(5_000)]);
  switchCurrentLink(previous.releaseDirectory);
  writeJson(activePath, previous);
  fs.rmSync(pendingPath, { force: true });
  writeOutcome(
    pending,
    "ROLLED_BACK",
    "HEALTH_CHECK_FAILED",
    "New client did not become ready within 90 seconds; previous deployment restored",
  );
  return { descriptor: previous, child: spawnClient(previous), healthy: false };
}

/** supervisor 主循环。 */
async function main() {
  fs.mkdirSync(runDirectory, { recursive: true });
  if (!fs.existsSync(activePath)) {
    throw new Error(`Active deployment descriptor is missing: ${activePath}`);
  }
  let descriptor = readJson(activePath);
  switchCurrentLink(descriptor.releaseDirectory);
  let child = spawnClient(descriptor);
  while (true) {
    const result = await waitForExit(child);
    if (result.code === 98 && fs.existsSync(pendingPath)) {
      const activated = await activatePending(descriptor);
      descriptor = activated.descriptor;
      child = activated.child;
      continue;
    }
    if (result.code === 0) return;
    await delay(RESTART_DELAY_MS);
    descriptor = readJson(activePath);
    child = spawnClient(descriptor);
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error("[SUPERVISOR] Fatal error", error);
    process.exitCode = 1;
  });
}
