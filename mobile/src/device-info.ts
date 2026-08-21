import { execFile } from "child_process";
import { promisify } from "util";

import {
  PROTOCOL_VERSION,
  type DeviceInfoPayload,
  type IdentifierAvailability,
} from "./protocol.js";
import type { DeploymentRuntimeInfo } from "./release-manifest.js";

const execFileAsync = promisify(execFile);

/** 执行一个无需 shell 的 Android 命令并返回去空白文本。 */
async function readCommand(
  command: string,
  args: string[] = [],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** 通过 root 执行仅由本模块定义的固定命令。 */
async function readRootCommand(command: string): Promise<string> {
  return readCommand("su", ["-c", command]);
}

/** 读取 Android property，失败时返回 unavailable。 */
async function readProperty(name: string): Promise<string> {
  return (await readCommand("getprop", [name])) || "unavailable";
}

/** 从 Android Binder service call 输出中解析 UTF-16 字符串。 */
function parseServiceCallString(output: string): string {
  const groups = [...output.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  const joined = groups.join("").replace(/\./g, "");
  return joined.replace(/[^0-9A-Za-z]/g, "");
}

/** 读取最多四个卡槽的 IMEI 并去空、去重。 */
async function collectImeis(): Promise<string[]> {
  const values = new Set<string>();
  for (let slot = 0; slot < 4; slot += 1) {
    const direct = await readRootCommand(`cmd phone get-imei ${slot}`);
    const directValue = direct.match(/\b\d{14,17}\b/)?.[0];
    if (directValue) values.add(directValue);

    if (!directValue) {
      const binder = await readRootCommand(
        `service call iphonesubinfo 1 i32 ${slot}`,
      );
      const parsed = parseServiceCallString(binder);
      const binderValue = parsed.match(/\d{14,17}/)?.[0];
      if (binderValue) values.add(binderValue);
    }
  }
  return [...values];
}

/** 读取 AutoJS6 安装版本。 */
async function collectAutojs6Version(): Promise<string> {
  const dump = await readRootCommand("dumpsys package org.autojs.autojs6");
  return dump.match(/versionName=([^\s]+)/)?.[1] || "unavailable";
}

/** 将标识值转换成状态，避免采集失败中断客户端。 */
function availability(value: string | null | string[]): IdentifierAvailability {
  return Array.isArray(value)
    ? value.length > 0
      ? "available"
      : "unavailable"
    : value
      ? "available"
      : "unavailable";
}

/**
 * 采集进程级静态设备信息。调用方应缓存返回的 Promise，禁止重复触发敏感读取。
 */
export async function collectDeviceInfo(
  deviceId: string,
  clientVersion: string,
  trustedScripts: Array<{ scriptId: string; version: number }>,
  deployment: DeploymentRuntimeInfo,
  ops: { enabled: boolean; operations: string[] },
): Promise<DeviceInfoPayload> {
  const [
    manufacturer,
    brand,
    model,
    androidVersion,
    sdkText,
    serialText,
    autojs6Version,
    imeis,
    rootUser,
  ] = await Promise.all([
    readProperty("ro.product.manufacturer"),
    readProperty("ro.product.brand"),
    readProperty("ro.product.model"),
    readProperty("ro.build.version.release"),
    readProperty("ro.build.version.sdk"),
    readRootCommand("getprop ro.serialno"),
    collectAutojs6Version(),
    collectImeis(),
    readRootCommand("id -u"),
  ]);
  const serialNumber = serialText || null;
  const parsedSdk = Number.parseInt(sdkText, 10);

  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    timestamp: Date.now(),
    manufacturer,
    brand,
    model,
    androidVersion,
    androidSdk: Number.isFinite(parsedSdk) ? parsedSdk : null,
    autojs6Version,
    clientVersion,
    identifiers: {
      imeis,
      imeiStatus: availability(imeis),
      serialNumber,
      serialStatus: availability(serialNumber),
    },
    capabilities: {
      trustedScripts,
      root: rootUser === "0",
      deployment: {
        protocolVersion: deployment.deploymentProtocolVersion,
        supervisorVersion: deployment.supervisorVersion,
      },
      ops: {
        protocolVersion: 1,
        enabled: ops.enabled,
        arbitraryShell: false,
        operations: ops.operations,
      },
    },
    reportedExtra: {
      deployment: {
        releaseVersion: deployment.releaseVersion,
        releaseDigest: deployment.releaseDigest,
        environment: deployment.environment,
        environmentRevision: deployment.environmentRevision,
        lastDeploymentId: deployment.lastDeploymentId,
      },
    },
  };
}
