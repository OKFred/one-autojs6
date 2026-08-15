import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** 发布包清单格式版本。 */
export const RELEASE_MANIFEST_FORMAT_VERSION = 1 as const;

/** 客户端部署协议版本。 */
export const DEPLOYMENT_PROTOCOL_VERSION = 1 as const;

/** 稳定 supervisor 的首个兼容版本。 */
export const SUPERVISOR_VERSION = "1.0.0";

/** 比较仅用于 supervisor 兼容门禁的三段 SemVer。 */
export function isSupervisorCompatible(minimumVersion: string): boolean {
  const parse = (value: string): number[] | null => {
    const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    return matched ? matched.slice(1).map(Number) : null;
  };
  const minimum = parse(minimumVersion);
  const current = parse(SUPERVISOR_VERSION);
  if (!minimum || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== minimum[index]) {
      return current[index] > minimum[index];
    }
  }
  return true;
}

/** 不可变客户端发布包清单。 */
export interface ReleaseManifest {
  formatVersion: 1;
  releaseVersion: string;
  packageVersion: string;
  gitCommit: string;
  createdAt: string;
  protocolVersion: 2;
  deploymentProtocolVersion: 1;
  minimumSupervisorVersion: string;
  entrypoint: string;
  files: Record<string, string>;
}

/** 当前进程观察到的部署运行信息。 */
export interface DeploymentRuntimeInfo {
  releaseVersion: string;
  releaseDigest: string;
  environment: string;
  environmentRevision: number;
  supervisorVersion: string;
  deploymentProtocolVersion: 1;
  lastDeploymentId: string | null;
}

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验发布版本字符串。 */
export function isReleaseVersion(value: string): boolean {
  return /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
    value,
  );
}

/** 解析并严格校验发布清单。 */
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value) || value.formatVersion !== 1) {
    throw new Error("Unsupported release manifest format");
  }
  if (
    typeof value.releaseVersion !== "string" ||
    !isReleaseVersion(value.releaseVersion) ||
    typeof value.packageVersion !== "string" ||
    `v${value.packageVersion}` !== value.releaseVersion ||
    typeof value.gitCommit !== "string" ||
    !/^[0-9a-f]{7,40}$/.test(value.gitCommit) ||
    typeof value.createdAt !== "string" ||
    value.protocolVersion !== 2 ||
    value.deploymentProtocolVersion !== 1 ||
    typeof value.minimumSupervisorVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.minimumSupervisorVersion) ||
    typeof value.entrypoint !== "string" ||
    !value.entrypoint.startsWith("dist/") ||
    !isRecord(value.files)
  ) {
    throw new Error("Invalid release manifest");
  }
  const files: Record<string, string> = {};
  for (const [filePath, digest] of Object.entries(value.files)) {
    if (
      !filePath ||
      path.isAbsolute(filePath) ||
      filePath.split(/[\\/]/).includes("..") ||
      typeof digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(digest)
    ) {
      throw new Error("Invalid release manifest file entry");
    }
    files[filePath] = digest;
  }
  if (!files[value.entrypoint]) {
    throw new Error("Release entrypoint is not covered by the manifest");
  }
  return {
    formatVersion: RELEASE_MANIFEST_FORMAT_VERSION,
    releaseVersion: value.releaseVersion,
    packageVersion: value.packageVersion,
    gitCommit: value.gitCommit,
    createdAt: value.createdAt,
    protocolVersion: 2,
    deploymentProtocolVersion: DEPLOYMENT_PROTOCOL_VERSION,
    minimumSupervisorVersion: value.minimumSupervisorVersion,
    entrypoint: value.entrypoint,
    files,
  };
}

/** 返回 mobile 发布根目录。 */
function mobileRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** 读取发布清单；源码开发模式退化为 package.json 版本。 */
export function loadReleaseManifest(): ReleaseManifest {
  const root = mobileRoot();
  const manifestPath =
    process.env.AUTOJS6_RELEASE_MANIFEST_PATH ||
    path.join(root, "release-manifest.json");
  if (fs.existsSync(manifestPath)) {
    return parseReleaseManifest(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown,
    );
  }
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ) as { version?: unknown };
  const packageVersion =
    typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  return {
    formatVersion: RELEASE_MANIFEST_FORMAT_VERSION,
    releaseVersion: `v${packageVersion}`,
    packageVersion,
    gitCommit: "0000000",
    createdAt: new Date(0).toISOString(),
    protocolVersion: 2,
    deploymentProtocolVersion: DEPLOYMENT_PROTOCOL_VERSION,
    minimumSupervisorVersion: SUPERVISOR_VERSION,
    entrypoint: "dist/client.js",
    files: { "dist/client.js": "0".repeat(64) },
  };
}

/** 从 supervisor 注入的非敏感变量构造部署运行信息。 */
export function deploymentRuntimeInfo(
  manifest: ReleaseManifest,
): DeploymentRuntimeInfo {
  const parsedRevision = Number.parseInt(
    process.env.AUTOJS6_ENVIRONMENT_REVISION || "0",
    10,
  );
  return {
    releaseVersion: manifest.releaseVersion,
    releaseDigest: process.env.AUTOJS6_RELEASE_DIGEST || "development",
    environment: process.env.AUTOJS6_ENVIRONMENT || "development",
    environmentRevision: Number.isInteger(parsedRevision) ? parsedRevision : 0,
    supervisorVersion:
      process.env.AUTOJS6_SUPERVISOR_VERSION || SUPERVISOR_VERSION,
    deploymentProtocolVersion: DEPLOYMENT_PROTOCOL_VERSION,
    lastDeploymentId: process.env.AUTOJS6_DEPLOYMENT_ID || null,
  };
}
