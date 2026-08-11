import { execFile } from "child_process";
import { promisify } from "util";

import { loadConfig } from "./config.js";
import {
  attestTikTokNetwork,
  TikTokNetworkPolicyError,
} from "./tiktok-network-policy.js";

const execFileAsync = promisify(execFile);
const SAMPLE_COUNT = 5;
const SAMPLE_INTERVAL_MS = 30000;

/** 等待固定时长，不阻塞 Node.js 事件循环。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 读取 Android 主网络状态；命令和参数均为本地固定值。 */
async function readConnectivityState(): Promise<string> {
  const { stdout } = await execFileAsync("su", [
    "-c",
    "dumpsys connectivity | grep 'NetworkAgentInfo'",
  ]);
  return stdout;
}

/** 连续五次验证手机真实出口，输出中不包含完整公网 IP。 */
async function main(): Promise<void> {
  const { config } = loadConfig();
  for (let sample = 1; sample <= SAMPLE_COUNT; sample += 1) {
    try {
      const result = await attestTikTokNetwork(
        { ...config.tiktok.networkPolicy, enabled: true },
        { readConnectivityState },
      );
      if (!result) throw new Error("NETWORK_ATTESTATION_DISABLED");
      console.log(
        JSON.stringify({
          sample,
          checkedAt: new Date(result.checkedAt).toISOString(),
          ipv4Countries: result.ipv4Countries,
          ipv6Status: result.ipv6.status,
          ipv6Countries: result.ipv6.countries,
          ip111Reachable: result.ip111Reachable,
          durationMs: result.durationMs,
          ok: true,
        }),
      );
    } catch (error) {
      const code =
        error instanceof TikTokNetworkPolicyError
          ? error.code
          : "TIKTOK_NETWORK_PROBE_FAILED";
      console.error(JSON.stringify({ sample, code, ok: false }));
      process.exitCode = 1;
      return;
    }
    if (sample < SAMPLE_COUNT) await delay(SAMPLE_INTERVAL_MS);
  }
}

await main();
