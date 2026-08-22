import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";

import {
  parseDeviceDeploymentCommand,
  type DeviceDeploymentCommand,
  type DeviceDeploymentEvent,
  type DeploymentPhase,
} from "./deployment-protocol.js";
import {
  isSupervisorCompatible,
  parseReleaseManifest,
} from "./release-manifest.js";

const execFileAsync = promisify(execFile);

/** supervisor 消费的待激活描述。 */
export interface PendingActivation {
  formatVersion: 1;
  deploymentId: string;
  releaseVersion: string;
  releaseDigest: string;
  releaseDirectory: string;
  entrypoint: string;
  environment: string;
  environmentRevision: number;
  environmentConfigPath: string;
  secretPath: string;
  createdAt: number;
}

/** 部署管理器访问当前任务执行器的受限钩子。 */
export interface DeploymentHooks {
  blockTaskIntake(deploymentId: string): void;
  unblockTaskIntake(deploymentId: string): void;
  cancelQueuedTasks(deploymentId: string): void;
  isTaskExecutorIdle(): boolean;
  forceStopActiveTask(deploymentId: string): Promise<boolean>;
  publishEvent(event: DeviceDeploymentEvent): Promise<void>;
  activate(pending: PendingActivation): Promise<void>;
}

/** 部署管理器运行参数。 */
export interface DeploymentManagerOptions {
  deviceId: string;
  rootDirectory: string;
  hooks: DeploymentHooks;
  now?: () => number;
  fetchArtifact?: typeof fetch;
}

/** 部署过程中带稳定错误码的异常。 */
class DeploymentFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly phase: DeploymentPhase = "FAILED",
  ) {
    super(message);
    this.name = "DeploymentFailure";
  }
}

/** 原子写入 UTF-8 文本。 */
function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

/** 计算文件 SHA-256。 */
async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

/** 将 HTTP 响应流写入受限文件，避免在手机内存中缓存整个制品。 */
async function writeArtifactStream(
  response: Response,
  filePath: string,
  expectedSize: number,
): Promise<void> {
  if (!response.body) {
    throw new DeploymentFailure(
      "ARTIFACT_DOWNLOAD_FAILED",
      "Artifact response has no body",
    );
  }
  const handle = fs.openSync(filePath, "wx", 0o600);
  let written = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > expectedSize || written > 100 * 1024 * 1024) {
        throw new DeploymentFailure(
          "ARTIFACT_SIZE_MISMATCH",
          "Artifact exceeded declared size",
        );
      }
      fs.writeSync(handle, value);
    }
  } finally {
    fs.closeSync(handle);
    reader.releaseLock();
  }
  if (written !== expectedSize) {
    throw new DeploymentFailure(
      "ARTIFACT_SIZE_MISMATCH",
      "Artifact size does not match release metadata",
    );
  }
}

/** 判断归档路径是否始终位于发布根目录内。 */
function safeArchivePath(value: string): boolean {
  if (!value || path.posix.isAbsolute(value) || /[\0-\x1f]/.test(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value.replace(/^\.\//, ""));
  return normalized !== ".." && !normalized.startsWith("../");
}

/**
 * 判断归档链接目标按链接所在目录解析后是否仍位于发布根目录内。
 *
 * @param entry 归档中的链接条目路径。
 * @param target 归档声明的链接目标。
 * @returns 链接最终目标位于发布根目录内时返回 true。
 */
export function isSafeArchiveSymlink(entry: string, target: string): boolean {
  if (
    !safeArchivePath(entry) ||
    !target ||
    path.posix.isAbsolute(target) ||
    /[\0-\x1f]/.test(target)
  ) {
    return false;
  }
  const normalizedEntry = path.posix.normalize(entry.replace(/^\.\//, ""));
  const resolvedTarget = path.posix.normalize(
    path.posix.join(path.posix.dirname(normalizedEntry), target),
  );
  return safeArchivePath(resolvedTarget);
}

/** 在解包前校验归档条目和软链目标。 */
async function validateArchive(archivePath: string): Promise<void> {
  const { stdout: names } = await execFileAsync("tar", ["-tzf", archivePath], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const entries = names
    .split("\n")
    .map((entry) => entry.replace(/\r$/, ""))
    .filter(Boolean);
  if (entries.length === 0 || entries.length > 100_000) {
    throw new DeploymentFailure(
      "ARCHIVE_INVALID",
      "Release archive is empty or too large",
    );
  }
  for (const entry of entries) {
    if (!safeArchivePath(entry)) {
      throw new DeploymentFailure(
        "ARCHIVE_PATH_UNSAFE",
        "Release archive contains an unsafe path",
      );
    }
  }
  const { stdout: verbose } = await execFileAsync(
    "tar",
    ["-tvzf", archivePath],
    {
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const verboseLines = verbose
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean);
  if (verboseLines.length !== entries.length) {
    throw new DeploymentFailure(
      "ARCHIVE_INVALID",
      "Release archive listing is inconsistent",
    );
  }
  for (const [index, line] of verboseLines.entries()) {
    const type = line[0];
    if (type === "b" || type === "c" || type === "p") {
      throw new DeploymentFailure(
        "ARCHIVE_TYPE_UNSAFE",
        "Release archive contains a special file",
      );
    }
    if (type === "l" || type === "h") {
      const separator = type === "l" ? " -> " : " link to ";
      const target = line.split(separator).at(-1) || "";
      const safe =
        type === "l"
          ? isSafeArchiveSymlink(entries[index], target)
          : safeArchivePath(target);
      if (!safe) {
        throw new DeploymentFailure(
          "ARCHIVE_LINK_UNSAFE",
          "Release archive contains an unsafe link",
        );
      }
    }
  }
}

/** 读取本地密钥文件中的键名，不返回密钥值。 */
function readSecretKeys(secretPath: string): Set<string> {
  if (!fs.existsSync(secretPath)) return new Set();
  const keys = new Set<string>();
  for (const line of fs.readFileSync(secretPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const matched = /^([A-Z][A-Z0-9_]*)=/.exec(trimmed);
    if (matched) keys.add(matched[1]);
  }
  return keys;
}

/** 递归列出发布目录中的普通文件相对路径。 */
function listReleaseFiles(directory: string, prefix = ""): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...listReleaseFiles(absolutePath, relativePath));
    } else if (entry.isFile() && relativePath !== "release-manifest.json") {
      result.push(relativePath);
    }
  }
  return result.sort();
}

/** 负责单台设备的部署预检、排空和 supervisor 交接。 */
export class DeploymentManager {
  private readonly now: () => number;
  private readonly fetchArtifact: typeof fetch;
  private currentDeploymentId: string | null = null;

  constructor(private readonly options: DeploymentManagerOptions) {
    this.now = options.now || Date.now;
    this.fetchArtifact = options.fetchArtifact || fetch;
  }

  /** 当前是否因部署拒绝新业务任务。 */
  isTaskIntakeBlocked(): boolean {
    return this.currentDeploymentId !== null;
  }

  /** 上报不包含密钥或签名 URL 的部署事件。 */
  private async event(
    command: DeviceDeploymentCommand,
    phase: DeploymentPhase,
    code: string,
    message: string,
  ): Promise<void> {
    await this.options.hooks.publishEvent({
      protocolVersion: 1,
      deploymentId: command.deploymentId,
      deviceId: command.deviceId,
      phase,
      code,
      message,
      releaseVersion: command.release.version,
      environment: command.environment.name,
      environmentRevision: command.environment.revision,
      timestamp: this.now(),
    });
  }

  /** 下载、校验并安装不可变发布目录和环境修订。 */
  private async stage(
    command: DeviceDeploymentCommand,
  ): Promise<PendingActivation> {
    const root = this.options.rootDirectory;
    const downloadsDirectory = path.join(root, "downloads");
    const releasesDirectory = path.join(root, "releases");
    const archivePath = path.join(
      downloadsDirectory,
      `${command.deploymentId}.tar.gz`,
    );
    const releaseDirectory = path.join(
      releasesDirectory,
      command.release.version,
    );
    const digestPath = path.join(releaseDirectory, ".artifact-sha256");
    fs.mkdirSync(downloadsDirectory, { recursive: true });
    fs.mkdirSync(releasesDirectory, { recursive: true });

    if (fs.existsSync(releaseDirectory)) {
      const installedDigest = fs.existsSync(digestPath)
        ? fs.readFileSync(digestPath, "utf8").trim()
        : "";
      if (installedDigest !== command.release.artifactSha256) {
        throw new DeploymentFailure(
          "RELEASE_IMMUTABILITY_VIOLATION",
          "The installed release version has a different digest",
        );
      }
    } else {
      const response = await this.fetchArtifact(command.release.artifactUrl, {
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      if (!response.ok || !response.body) {
        throw new DeploymentFailure(
          "ARTIFACT_DOWNLOAD_FAILED",
          `Artifact download failed with HTTP ${response.status}`,
        );
      }
      fs.rmSync(archivePath, { force: true });
      await writeArtifactStream(
        response,
        archivePath,
        command.release.artifactSize,
      );
      const archiveDigest = await sha256File(archivePath);
      if (archiveDigest !== command.release.artifactSha256) {
        throw new DeploymentFailure(
          "ARTIFACT_DIGEST_MISMATCH",
          "Artifact SHA-256 verification failed",
        );
      }
      await validateArchive(archivePath);
      const temporaryDirectory = `${releaseDirectory}.${command.deploymentId}.tmp`;
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      fs.mkdirSync(temporaryDirectory, { recursive: true });
      try {
        await execFileAsync("tar", [
          "-xzf",
          archivePath,
          "-C",
          temporaryDirectory,
          "--no-same-owner",
        ]);
        const manifestPath = path.join(
          temporaryDirectory,
          "release-manifest.json",
        );
        const manifest = parseReleaseManifest(
          JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown,
        );
        if (manifest.releaseVersion !== command.release.version) {
          throw new DeploymentFailure(
            "RELEASE_VERSION_MISMATCH",
            "Artifact manifest version does not match command",
          );
        }
        if (!isSupervisorCompatible(manifest.minimumSupervisorVersion)) {
          throw new DeploymentFailure(
            "SUPERVISOR_VERSION_UNSUPPORTED",
            `Release requires supervisor ${manifest.minimumSupervisorVersion}`,
          );
        }
        const actualFiles = listReleaseFiles(temporaryDirectory);
        const declaredFiles = Object.keys(manifest.files).sort();
        if (
          actualFiles.length !== declaredFiles.length ||
          actualFiles.some(
            (filePath, index) => filePath !== declaredFiles[index],
          )
        ) {
          throw new DeploymentFailure(
            "MANIFEST_FILE_SET_MISMATCH",
            "Release manifest does not cover every regular file",
          );
        }
        for (const [relativePath, expectedDigest] of Object.entries(
          manifest.files,
        )) {
          const absolutePath = path.resolve(temporaryDirectory, relativePath);
          if (
            !absolutePath.startsWith(
              `${path.resolve(temporaryDirectory)}${path.sep}`,
            )
          ) {
            throw new DeploymentFailure(
              "MANIFEST_PATH_UNSAFE",
              "Manifest path escapes release directory",
            );
          }
          if (
            !fs.statSync(absolutePath).isFile() ||
            (await sha256File(absolutePath)) !== expectedDigest
          ) {
            throw new DeploymentFailure(
              "RELEASE_FILE_DIGEST_MISMATCH",
              `Release file verification failed: ${relativePath}`,
            );
          }
        }
        writeAtomic(
          path.join(temporaryDirectory, ".artifact-sha256"),
          `${command.release.artifactSha256}\n`,
        );
        fs.renameSync(temporaryDirectory, releaseDirectory);
      } catch (error) {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        throw error;
      } finally {
        fs.rmSync(archivePath, { force: true });
      }
    }

    const secretPath = path.join(
      root,
      "secrets",
      `${command.environment.name}.env`,
    );
    const availableSecrets = readSecretKeys(secretPath);
    const missingSecrets = command.environment.requiredSecretKeys.filter(
      (key) => !availableSecrets.has(key),
    );
    if (missingSecrets.length > 0) {
      throw new DeploymentFailure(
        "ENVIRONMENT_SECRETS_MISSING",
        `Required local environment secret keys are missing: ${missingSecrets.join(",")}`,
      );
    }
    const environmentConfigPath = path.join(
      root,
      "environments",
      command.environment.name,
      "revisions",
      `${command.environment.revision}.json`,
    );
    writeAtomic(
      environmentConfigPath,
      `${JSON.stringify(command.environment.config, null, 2)}\n`,
    );
    const manifest = parseReleaseManifest(
      JSON.parse(
        fs.readFileSync(
          path.join(releaseDirectory, "release-manifest.json"),
          "utf8",
        ),
      ) as unknown,
    );
    return {
      formatVersion: 1,
      deploymentId: command.deploymentId,
      releaseVersion: command.release.version,
      releaseDigest: command.release.artifactSha256,
      releaseDirectory,
      entrypoint: manifest.entrypoint,
      environment: command.environment.name,
      environmentRevision: command.environment.revision,
      environmentConfigPath,
      secretPath,
      createdAt: this.now(),
    };
  }

  /** 等待当前任务排空。 */
  private async waitForIdle(command: DeviceDeploymentCommand): Promise<void> {
    const deadline = this.now() + command.drainTimeoutMs;
    while (!this.options.hooks.isTaskExecutorIdle()) {
      if (this.now() >= deadline) {
        throw new DeploymentFailure(
          "DEPLOYMENT_DRAIN_TIMEOUT",
          "Current task did not finish before the deployment drain timeout",
          "TIMED_OUT",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** 接收一个未知部署命令并完成到 supervisor 的交接。 */
  async handle(value: unknown): Promise<void> {
    let command: DeviceDeploymentCommand;
    try {
      command = parseDeviceDeploymentCommand(value);
    } catch (error) {
      throw new DeploymentFailure(
        "DEPLOYMENT_COMMAND_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (command.deviceId !== this.options.deviceId) {
      await this.event(
        command,
        "FAILED",
        "DEVICE_MISMATCH",
        "Deployment targets another device",
      );
      return;
    }
    if (command.expiresAt <= this.now()) {
      await this.event(
        command,
        "TIMED_OUT",
        "DEPLOYMENT_EXPIRED",
        "Deployment command expired before processing",
      );
      return;
    }
    if (this.currentDeploymentId) {
      if (this.currentDeploymentId !== command.deploymentId) {
        await this.event(
          command,
          "FAILED",
          "DEPLOYMENT_BUSY",
          "Another deployment is already active",
        );
      }
      return;
    }
    this.currentDeploymentId = command.deploymentId;
    this.options.hooks.blockTaskIntake(command.deploymentId);
    this.options.hooks.cancelQueuedTasks(command.deploymentId);
    try {
      await this.event(
        command,
        "STAGING",
        "STAGING_STARTED",
        "Release staging started",
      );
      const pending = await this.stage(command);
      if (command.activationMode === "FORCE") {
        await this.event(
          command,
          "PREEMPTING",
          "PREEMPTING_ACTIVE_TASK",
          "Force activation is stopping the active task",
        );
        if (
          !(await this.options.hooks.forceStopActiveTask(command.deploymentId))
        ) {
          throw new DeploymentFailure(
            "PREEMPT_CLEANUP_FAILED",
            "Active task cleanup failed; deployment was not activated",
          );
        }
      } else {
        await this.event(
          command,
          "DRAINING",
          "DRAINING_ACTIVE_TASK",
          "Waiting for the active task to finish",
        );
        await this.waitForIdle(command);
      }
      await this.event(
        command,
        "ACTIVATING",
        "ACTIVATION_REQUESTED",
        "Supervisor activation requested",
      );
      await this.options.hooks.activate(pending);
    } catch (error) {
      const failure =
        error instanceof DeploymentFailure
          ? error
          : new DeploymentFailure(
              "DEPLOYMENT_FAILED",
              error instanceof Error ? error.message : String(error),
            );
      await this.event(
        command,
        failure.phase,
        failure.code,
        failure.message,
      ).catch(() => undefined);
      this.options.hooks.unblockTaskIntake(command.deploymentId);
      this.currentDeploymentId = null;
    }
  }
}
