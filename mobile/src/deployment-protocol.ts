import { isRecord } from "./protocol.js";
import { isReleaseVersion } from "./release-manifest.js";

/** 部署切换模式。 */
export type DeploymentActivationMode = "GRACEFUL" | "FORCE";

/** 部署过程阶段。 */
export type DeploymentPhase =
  | "PENDING"
  | "STAGING"
  | "DRAINING"
  | "PREEMPTING"
  | "ACTIVATING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "ROLLED_BACK"
  | "TIMED_OUT"
  | "CANCELLED";

/** Node Server 下发的独立部署命令。 */
export interface DeviceDeploymentCommand {
  protocolVersion: 1;
  deploymentId: string;
  deviceId: string;
  release: {
    version: string;
    artifactUrl: string;
    artifactSha256: string;
    artifactSize: number;
  };
  environment: {
    name: "development" | "staging" | "production";
    revision: number;
    config: Record<string, unknown>;
    requiredSecretKeys: string[];
  };
  activationMode: DeploymentActivationMode;
  drainTimeoutMs: number;
  createdAt: number;
  expiresAt: number;
}

/** 手机端上报的部署进度事件。 */
export interface DeviceDeploymentEvent {
  protocolVersion: 1;
  deploymentId: string;
  deviceId: string;
  phase: DeploymentPhase;
  code: string;
  message: string;
  releaseVersion: string;
  environment: string;
  environmentRevision: number;
  timestamp: number;
}

/** 校验部署标识。 */
function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F-]{36}$/.test(value);
}

/** 校验环境配置不夹带常见密钥字段。 */
function assertNonSensitiveConfig(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error("Environment config is too deeply nested");
  if (Array.isArray(value)) {
    value.forEach((item) => assertNonSensitiveConfig(item, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(password|token|secret|credential)/i.test(key)) {
      throw new Error(`Environment config contains sensitive key: ${key}`);
    }
    assertNonSensitiveConfig(child, depth + 1);
  }
}

/** 解析并严格校验部署命令。 */
export function parseDeviceDeploymentCommand(
  value: unknown,
): DeviceDeploymentCommand {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 1 ||
    !validId(value.deploymentId) ||
    typeof value.deviceId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(value.deviceId) ||
    !isRecord(value.release) ||
    !isRecord(value.environment)
  ) {
    throw new Error("Invalid deployment command envelope");
  }
  const release = value.release;
  const environment = value.environment;
  if (
    typeof release.version !== "string" ||
    !isReleaseVersion(release.version) ||
    typeof release.artifactUrl !== "string" ||
    new URL(release.artifactUrl).protocol !== "https:" ||
    typeof release.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(release.artifactSha256) ||
    typeof release.artifactSize !== "number" ||
    !Number.isInteger(release.artifactSize) ||
    release.artifactSize < 1 ||
    release.artifactSize > 100 * 1024 * 1024
  ) {
    throw new Error("Invalid deployment release descriptor");
  }
  if (
    environment.name !== "development" &&
    environment.name !== "staging" &&
    environment.name !== "production"
  ) {
    throw new Error("Unsupported deployment environment");
  }
  if (
    typeof environment.revision !== "number" ||
    !Number.isInteger(environment.revision) ||
    environment.revision < 1 ||
    !isRecord(environment.config) ||
    !Array.isArray(environment.requiredSecretKeys) ||
    !environment.requiredSecretKeys.every(
      (item) => typeof item === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(item),
    )
  ) {
    throw new Error("Invalid deployment environment descriptor");
  }
  for (const forbiddenKey of ["deviceId", "mqtt", "report"]) {
    if (Object.hasOwn(environment.config, forbiddenKey)) {
      throw new Error(
        `Environment config cannot override management field: ${forbiddenKey}`,
      );
    }
  }
  const protectedSecretKeys = new Set([
    "EMQX_PROTOCOL",
    "EMQX_USERNAME",
    "EMQX_PASSWORD",
    "EMQX_HOST",
    "EMQX_PORT",
    "AUTOJS6_REPORT_URL",
    "AUTOJS6_REPORT_TOKEN",
  ]);
  if (
    environment.requiredSecretKeys.some((key) => protectedSecretKeys.has(key))
  ) {
    throw new Error(
      "Environment secrets cannot include management credentials",
    );
  }
  assertNonSensitiveConfig(environment.config);
  if (value.activationMode !== "GRACEFUL" && value.activationMode !== "FORCE") {
    throw new Error("Unsupported deployment activation mode");
  }
  if (
    typeof value.drainTimeoutMs !== "number" ||
    !Number.isInteger(value.drainTimeoutMs) ||
    value.drainTimeoutMs < 1_000 ||
    value.drainTimeoutMs > 30 * 60 * 1000 ||
    typeof value.createdAt !== "number" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= value.createdAt
  ) {
    throw new Error("Invalid deployment timing policy");
  }
  return {
    protocolVersion: 1,
    deploymentId: value.deploymentId,
    deviceId: value.deviceId,
    release: {
      version: release.version,
      artifactUrl: release.artifactUrl,
      artifactSha256: release.artifactSha256,
      artifactSize: release.artifactSize,
    },
    environment: {
      name: environment.name,
      revision: environment.revision,
      config: environment.config,
      requiredSecretKeys: [...new Set(environment.requiredSecretKeys)],
    },
    activationMode: value.activationMode,
    drainTimeoutMs: value.drainTimeoutMs,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}
