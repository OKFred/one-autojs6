import assert from "assert";
import {
  attestTikTokNetwork,
  TikTokNetworkPolicyError,
  type TikTokNetworkPolicyConfig,
} from "../src/tiktok-network-policy.js";

const PRIMARY_WIFI =
  "NetworkAgentInfo TRANSPORT_PRIMARY IS_VALIDATED Transports: WIFI";
const CONFIG: TikTokNetworkPolicyConfig = {
  enabled: true,
  allowedCountries: ["GB"],
  requireWifi: true,
  probeTimeoutMs: 5000,
};

/** 构造只返回国家代码且不包含公网 IP 的测试探针。 */
function probeFor(
  ipv4: string[],
  ipv6: Array<string | Error>,
  ip111Error?: Error,
) {
  let ipv4Index = 0;
  let ipv6Index = 0;
  return async (url: URL, family: 4 | 6): Promise<string> => {
    if (url.hostname === "ip111.cn") {
      if (ip111Error) throw ip111Error;
      return "ok";
    }
    const value =
      family === 4 ? ipv4[ipv4Index++] : ipv6[ipv6Index++];
    if (value instanceof Error) throw value;
    return url.hostname === "www.cloudflare.com"
      ? `loc=${value}\n`
      : JSON.stringify({ country: value, ip: "discarded-by-parser" });
  };
}

/** 断言网络验证以指定稳定错误码失败。 */
async function rejectsWithCode(
  expectedCode: string,
  action: () => Promise<unknown>,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    return (
      error instanceof TikTokNetworkPolicyError && error.code === expectedCode
    );
  });
}

/** 运行 TikTok 网络策略单元测试。 */
async function main(): Promise<void> {
  const disabled = await attestTikTokNetwork(
    { ...CONFIG, enabled: false },
    {
      readConnectivityState: async () => "",
      requestText: probeFor(["CN", "CN"], [new Error(), new Error()]),
    },
  );
  assert.equal(disabled, null);

  const passed = await attestTikTokNetwork(CONFIG, {
    readConnectivityState: async () => PRIMARY_WIFI,
    requestText: probeFor(["GB", "GB"], [new Error(), new Error()]),
  });
  assert.deepEqual(passed?.ipv4Countries, ["GB", "GB"]);
  assert.equal(passed?.ipv6.status, "UNAVAILABLE");
  assert.equal(passed?.ip111Reachable, true);

  const passedWithoutIp111 = await attestTikTokNetwork(CONFIG, {
    readConnectivityState: async () => PRIMARY_WIFI,
    requestText: probeFor(
      ["GB", "GB"],
      [new Error(), new Error()],
      new Error("timeout"),
    ),
  });
  assert.equal(passedWithoutIp111?.ip111Reachable, false);

  await rejectsWithCode("TIKTOK_WIFI_REQUIRED", () =>
    attestTikTokNetwork(CONFIG, {
      readConnectivityState: async () => "Transports: CELLULAR",
      requestText: probeFor(["GB", "GB"], [new Error(), new Error()]),
    }),
  );
  await rejectsWithCode("TIKTOK_IPV4_REGION_MISMATCH", () =>
    attestTikTokNetwork(CONFIG, {
      readConnectivityState: async () => PRIMARY_WIFI,
      requestText: probeFor(["GB", "SG"], [new Error(), new Error()]),
    }),
  );
  await rejectsWithCode("TIKTOK_IPV6_REGION_MISMATCH", () =>
    attestTikTokNetwork(CONFIG, {
      readConnectivityState: async () => PRIMARY_WIFI,
      requestText: probeFor(["GB", "GB"], ["CN", "CN"]),
    }),
  );
  await rejectsWithCode("TIKTOK_IPV6_PROBE_INCONSISTENT", () =>
    attestTikTokNetwork(CONFIG, {
      readConnectivityState: async () => PRIMARY_WIFI,
      requestText: probeFor(["GB", "GB"], ["GB", new Error()]),
    }),
  );

  console.log("TikTok network policy tests passed");
}

await main();
