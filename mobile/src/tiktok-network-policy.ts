import https from "https";

/** TikTok 发布前使用的本机网络策略。 */
export interface TikTokNetworkPolicyConfig {
  enabled: boolean;
  allowedCountries: string[];
  requireWifi: boolean;
  probeTimeoutMs: number;
}

/** 单个网络探针的最小结果。 */
export interface TikTokCountryProbeResult {
  countryCode: string;
  latencyMs: number;
}

/** 不包含公网 IP 的 TikTok 网络验证结果。 */
export interface TikTokNetworkAttestation {
  checkedAt: number;
  durationMs: number;
  transport: "WIFI";
  ipv4Countries: string[];
  ipv6: {
    status: "ALLOWED" | "UNAVAILABLE";
    countries: string[];
  };
  ip111Reachable: boolean;
}

/** 允许测试注入的网络探针依赖。 */
export interface TikTokNetworkPolicyDependencies {
  readConnectivityState: () => Promise<string>;
  requestText?: (
    url: URL,
    family: 4 | 6,
    timeoutMs: number,
  ) => Promise<string>;
  now?: () => number;
}

/** 带稳定错误码的 TikTok 网络策略异常。 */
export class TikTokNetworkPolicyError extends Error {
  /** 创建不包含公网 IP 的网络策略异常。 */
  constructor(public readonly code: string) {
    super(code);
    this.name = "TikTokNetworkPolicyError";
  }
}

const IPV4_PROBES = [
  {
    url: new URL("https://api.country.is/"),
    parse: (body: string) => {
      const parsed: unknown = JSON.parse(body);
      return typeof parsed === "object" && parsed !== null && "country" in parsed
        ? String(parsed.country)
        : "";
    },
  },
  {
    url: new URL("https://www.cloudflare.com/cdn-cgi/trace"),
    parse: (body: string) =>
      body
        .split("\n")
        .find((line) => line.startsWith("loc="))
        ?.slice(4)
        .trim() || "",
  },
] as const;

const IP111_URL = new URL("https://ip111.cn/");
const MAX_RESPONSE_BYTES = 64 * 1024;
const AUXILIARY_PROBE_TIMEOUT_MS = 3000;

/** 将国家代码规范化为 ISO 3166-1 alpha-2 大写形式。 */
function normalizeCountryCode(value: string): string {
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

/** 判断 Android connectivity 输出中的主网络是否为已验证 Wi-Fi。 */
export function isValidatedPrimaryWifi(connectivityState: string): boolean {
  return connectivityState.split("\n").some(
    (line) =>
      line.includes("NetworkAgentInfo") &&
      line.includes("TRANSPORT_PRIMARY") &&
      line.includes("IS_VALIDATED") &&
      line.includes("Transports: WIFI"),
  );
}

/** 通过固定 HTTPS URL 发起限定地址族的文本请求。 */
function requestText(
  url: URL,
  family: 4 | 6,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        family,
        headers: {
          Accept: "text/plain,application/json;q=0.9,*/*;q=0.1",
          "User-Agent": "one-autojs6-network-attestation/1",
        },
      },
      (response) => {
        if (
          response.statusCode === undefined ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          response.resume();
          reject(new Error(`HTTP_${response.statusCode ?? 0}`));
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("RESPONSE_TOO_LARGE"));
          }
        });
        response.on("end", () => resolve(body));
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("TIMEOUT")));
    request.on("error", reject);
  });
}

/** 执行单个固定国家探针并丢弃响应中的任何公网 IP 字段。 */
async function runCountryProbe(
  probe: (typeof IPV4_PROBES)[number],
  family: 4 | 6,
  timeoutMs: number,
  fetchText: NonNullable<TikTokNetworkPolicyDependencies["requestText"]>,
  now: () => number,
): Promise<TikTokCountryProbeResult> {
  const startedAt = now();
  const countryCode = normalizeCountryCode(
    probe.parse(await fetchText(probe.url, family, timeoutMs)),
  );
  if (!countryCode) throw new Error("INVALID_COUNTRY_RESPONSE");
  return { countryCode, latencyMs: Math.max(0, now() - startedAt) };
}

/** 检查一组探针是否全部返回同一个允许国家。 */
function requireAllowedCountries(
  results: TikTokCountryProbeResult[],
  allowedCountries: Set<string>,
  mismatchCode: string,
): string[] {
  const countries = results.map((result) => result.countryCode);
  if (
    countries.length !== IPV4_PROBES.length ||
    new Set(countries).size !== 1 ||
    !countries.every((country) => allowedCountries.has(country))
  ) {
    throw new TikTokNetworkPolicyError(mismatchCode);
  }
  return countries;
}

/**
 * 在打开 TikTok 前验证手机实际 IPv4、IPv6 与基础探针出口。
 * 返回值和错误均不会包含完整公网 IP。
 */
export async function attestTikTokNetwork(
  config: TikTokNetworkPolicyConfig,
  dependencies: TikTokNetworkPolicyDependencies,
): Promise<TikTokNetworkAttestation | null> {
  if (!config.enabled) return null;
  const now = dependencies.now ?? Date.now;
  const fetchText = dependencies.requestText ?? requestText;
  const startedAt = now();
  const allowedCountries = new Set(
    config.allowedCountries.map(normalizeCountryCode).filter(Boolean),
  );
  if (allowedCountries.size === 0) {
    throw new TikTokNetworkPolicyError("TIKTOK_NETWORK_POLICY_INVALID");
  }
  if (
    config.requireWifi &&
    !isValidatedPrimaryWifi(await dependencies.readConnectivityState())
  ) {
    throw new TikTokNetworkPolicyError("TIKTOK_WIFI_REQUIRED");
  }

  let ipv4Results: TikTokCountryProbeResult[];
  try {
    ipv4Results = await Promise.all(
      IPV4_PROBES.map((probe) =>
        runCountryProbe(
          probe,
          4,
          config.probeTimeoutMs,
          fetchText,
          now,
        ),
      ),
    );
  } catch {
    throw new TikTokNetworkPolicyError("TIKTOK_IPV4_PROBE_FAILED");
  }
  const ipv4Countries = requireAllowedCountries(
    ipv4Results,
    allowedCountries,
    "TIKTOK_IPV4_REGION_MISMATCH",
  );

  const ipv6Settled = await Promise.allSettled(
    IPV4_PROBES.map((probe) =>
      runCountryProbe(
        probe,
        6,
        config.probeTimeoutMs,
        fetchText,
        now,
      ),
    ),
  );
  const ipv6Results = ipv6Settled
    .filter(
      (result): result is PromiseFulfilledResult<TikTokCountryProbeResult> =>
        result.status === "fulfilled",
    )
    .map((result) => result.value);
  let ipv6: TikTokNetworkAttestation["ipv6"];
  if (ipv6Results.length === 0) {
    ipv6 = { status: "UNAVAILABLE", countries: [] };
  } else if (ipv6Results.length !== IPV4_PROBES.length) {
    throw new TikTokNetworkPolicyError("TIKTOK_IPV6_PROBE_INCONSISTENT");
  } else {
    const countries = requireAllowedCountries(
      ipv6Results,
      allowedCountries,
      "TIKTOK_IPV6_REGION_MISMATCH",
    );
    ipv6 = { status: "ALLOWED", countries };
  }

  let ip111Reachable = true;
  try {
    await fetchText(
      IP111_URL,
      4,
      Math.min(config.probeTimeoutMs, AUXILIARY_PROBE_TIMEOUT_MS),
    );
  } catch {
    // ip111 在部分可信代理节点会超时，只作为辅助诊断；发布仍由两个
    // 独立国家探针、Wi-Fi 主网络和 IPv6 防泄漏检查共同决定。
    ip111Reachable = false;
  }

  return {
    checkedAt: now(),
    durationMs: Math.max(0, now() - startedAt),
    transport: "WIFI",
    ipv4Countries,
    ipv6,
    ip111Reachable,
  };
}
