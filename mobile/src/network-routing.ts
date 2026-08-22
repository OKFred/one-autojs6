import { execFile } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";

export const NETWORK_ROUTING_SCRIPT_IDS = [
  "device.network.routing.apply",
  "device.network.routing.disable",
] as const;

export type NetworkRoutingScriptId =
  (typeof NETWORK_ROUTING_SCRIPT_IDS)[number];
export type InternetTarget = "wifi" | "carrier";

export interface NetworkRoutingPolicy {
  generation: number;
  policyRevision: number;
  internetTarget: InternetTarget;
  lanCidrs: string[];
  lanProbeUrls: string[];
  internetProbeUrl: string;
  probeTimeoutMs: number;
}

export interface NetworkRoutingResult {
  status: "SUCCESS" | "FAILURE" | "REJECTED";
  code: string;
  message: string;
  data: {
    generation: number;
    policyRevision?: number;
    target?: InternetTarget;
    wifiInterface?: string;
    carrierInterface?: string;
    probes?: { lan: boolean; internet: boolean };
    rollback?: { attempted: boolean; succeeded: boolean };
  };
}

interface AndroidNetwork {
  netId: number;
  interfaceName: string;
  transport: "wifi" | "carrier" | "vpn";
  validated: boolean;
  connected: boolean;
  ipv4Table?: string;
  ipv6Table?: string;
  ipv6Default: boolean;
}

interface NetworkSnapshot {
  defaultNetId: number | null;
  wifi: AndroidNetwork;
  carrier: AndroidNetwork;
  managementRoutes: Array<{ family: 4 | 6; cidr: string; table: string }>;
  ipv4Rules: string;
  ipv6Rules: string;
}

interface PersistedRoutingState {
  formatVersion: 1;
  active: boolean;
  generation: number;
  policy?: NetworkRoutingPolicy;
  baselineDefaultNetId?: number | null;
  verifiedAt?: number;
  status: "DISABLED" | "ACTIVE" | "DEGRADED";
}

export interface NetworkRoutingDependencies {
  readRoot(command: string): Promise<string>;
  runRoot(command: string): Promise<void>;
  reconnectManagement(): Promise<void>;
  probe(input: {
    url: string;
    interfaceName?: string;
    timeoutMs: number;
    expectPublicIpv4: boolean;
  }): Promise<string | void>;
  now(): number;
}

const BOUND_INTERFACE_RULE_START = 10_400;
const IPV4_LAN_RULE_START = 10_500;
const IPV4_DEFAULT_RULE = 10_600;
const IPV6_DEFAULT_RULE = 10_600;
const IPV6_BLOCK_TABLE = 16_661;
const HTTP_STATUS_MARKER = "__AUTOJS6_HTTP_STATUS__";
const INTERFACE_PATTERN = /^[A-Za-z0-9_.:@-]{1,32}$/;
const TABLE_PATTERN = /^(?:[1-9]\d{0,9}|[A-Za-z][A-Za-z0-9_.-]{0,31})$/;

export class NetworkRoutingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NetworkRoutingError";
  }
}

/** 将 IPv4 地址转换为无符号整数。 */
function ipv4Number(value: string): number | null {
  if (net.isIP(value) !== 4) return null;
  return value
    .split(".")
    .map(Number)
    .reduce((result, octet) => (result * 256 + octet) >>> 0, 0);
}

/** 解析并规范化单个 IPv4 CIDR。 */
export function normalizePrivateIpv4Cidr(value: string): string {
  const match = value.trim().match(/^([^/]+)\/(\d{1,2})$/);
  if (!match)
    throw new NetworkRoutingError("INVALID_PARAMS", "Invalid LAN CIDR");
  const address = ipv4Number(match[1]);
  const prefix = Number(match[2]);
  if (address === null || prefix < 1 || prefix > 32) {
    throw new NetworkRoutingError("INVALID_PARAMS", "Invalid LAN CIDR");
  }
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (address & mask) >>> 0;
  if (network !== address) {
    throw new NetworkRoutingError(
      "INVALID_PARAMS",
      "LAN CIDR must use its canonical network address",
    );
  }
  const isPrivate =
    (network >= ipv4Number("10.0.0.0")! &&
      network <= ipv4Number("10.255.255.255")!) ||
    (network >= ipv4Number("172.16.0.0")! &&
      network <= ipv4Number("172.31.255.255")!) ||
    (network >= ipv4Number("192.168.0.0")! &&
      network <= ipv4Number("192.168.255.255")!);
  if (!isPrivate) {
    throw new NetworkRoutingError(
      "INVALID_PARAMS",
      "LAN CIDR must be RFC1918 IPv4",
    );
  }
  return `${match[1]}/${prefix}`;
}

/** 判断 IPv4 是否位于任一 CIDR。 */
export function ipv4InCidrs(
  addressText: string,
  cidrs: readonly string[],
): boolean {
  const address = ipv4Number(addressText);
  if (address === null) return false;
  return cidrs.some((cidr) => {
    const [networkText, prefixText] = cidr.split("/");
    const network = ipv4Number(networkText);
    const prefix = Number(prefixText);
    if (network === null || !Number.isInteger(prefix)) return false;
    const mask =
      prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) >>> 0 === network;
  });
}

/** 校验并返回手机客户端实际执行的规范策略。 */
export function parseNetworkRoutingPolicy(
  value: Record<string, unknown>,
): NetworkRoutingPolicy {
  const generation = value.generation;
  const policyRevision = value.policyRevision;
  const internetTarget = value.internetTarget;
  if (!Number.isInteger(generation) || Number(generation) < 1) {
    throw new NetworkRoutingError(
      "INVALID_PARAMS",
      "generation must be a positive integer",
    );
  }
  if (!Number.isInteger(policyRevision) || Number(policyRevision) < 1) {
    throw new NetworkRoutingError(
      "INVALID_PARAMS",
      "policyRevision must be a positive integer",
    );
  }
  if (internetTarget !== "wifi" && internetTarget !== "carrier") {
    throw new NetworkRoutingError(
      "INVALID_PARAMS",
      "internetTarget must be wifi or carrier",
    );
  }
  if (
    !Array.isArray(value.lanCidrs) ||
    value.lanCidrs.length < 1 ||
    value.lanCidrs.length > 16
  ) {
    throw new NetworkRoutingError(
      "INVALID_PARAMS",
      "lanCidrs must contain 1 to 16 items",
    );
  }
  const lanCidrs = [
    ...new Set(
      value.lanCidrs.map((item) => {
        if (typeof item !== "string")
          throw new NetworkRoutingError(
            "INVALID_PARAMS",
            "LAN CIDR must be text",
          );
        return normalizePrivateIpv4Cidr(item);
      }),
    ),
  ];
  if (
    !Array.isArray(value.lanProbeUrls) ||
    value.lanProbeUrls.length < 1 ||
    value.lanProbeUrls.length > 16
  ) {
    throw new NetworkRoutingError(
      "INVALID_PARAMS",
      "lanProbeUrls must contain 1 to 16 items",
    );
  }
  const validateUrl = (raw: unknown, lan: boolean): string => {
    if (typeof raw !== "string" || raw.length > 2048) {
      throw new NetworkRoutingError("INVALID_PARAMS", "Probe URL is invalid");
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new NetworkRoutingError("INVALID_PARAMS", "Probe URL is invalid");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new NetworkRoutingError(
        "INVALID_PARAMS",
        "Probe URL contains unsupported fields",
      );
    }
    if (
      lan &&
      (net.isIP(url.hostname) !== 4 || !ipv4InCidrs(url.hostname, lanCidrs))
    ) {
      throw new NetworkRoutingError(
        "INVALID_PARAMS",
        "LAN probe must use an IP inside lanCidrs",
      );
    }
    return url.toString();
  };
  const lanProbeUrls = [
    ...new Set(value.lanProbeUrls.map((item) => validateUrl(item, true))),
  ];
  const internetProbeUrl = validateUrl(value.internetProbeUrl, false);
  const probeTimeoutMs = value.probeTimeoutMs ?? 10_000;
  if (
    !Number.isInteger(probeTimeoutMs) ||
    Number(probeTimeoutMs) < 3_000 ||
    Number(probeTimeoutMs) > 30_000
  ) {
    throw new NetworkRoutingError(
      "INVALID_PARAMS",
      "probeTimeoutMs must be between 3000 and 30000",
    );
  }
  return {
    generation: Number(generation),
    policyRevision: Number(policyRevision),
    internetTarget,
    lanCidrs,
    lanProbeUrls,
    internetProbeUrl,
    probeTimeoutMs: Number(probeTimeoutMs),
  };
}

/** 从 dumpsys connectivity 输出提取已连接 Android Network。 */
export function parseConnectivityNetworks(output: string): AndroidNetwork[] {
  return output
    .split(/(?=NetworkAgentInfo\{)/g)
    .flatMap((chunk): AndroidNetwork[] => {
      const netId = Number(chunk.match(/network\{(\d+)\}/)?.[1]);
      const interfaceName =
        chunk.match(/InterfaceName:\s*([^\s,}]+)/)?.[1] || "";
      const upper = chunk.toUpperCase();
      const transport =
        upper.includes("TRANSPORTS: WIFI") || /\bTYPE:\s*WIFI\b/i.test(chunk)
          ? "wifi"
          : upper.includes("TRANSPORTS: CELLULAR") ||
              /\bTYPE:\s*MOBILE\b/i.test(chunk)
            ? "carrier"
            : upper.includes("TRANSPORTS: VPN") ||
                /\bTYPE:\s*VPN\b/i.test(chunk)
              ? "vpn"
              : null;
      if (
        !Number.isInteger(netId) ||
        !transport ||
        !INTERFACE_PATTERN.test(interfaceName)
      )
        return [];
      return [
        {
          netId,
          interfaceName,
          transport,
          validated: /\bVALIDATED\b/i.test(chunk),
          connected: /CONNECTED(?:\/CONNECTED)?/i.test(chunk),
          ipv6Default: false,
        },
      ];
    });
}

/** 从 Android route table 输出提取接口使用的路由表和管理直连网段。 */
export function attachRouteTables(
  networks: AndroidNetwork[],
  route4: string,
  route6: string,
): {
  networks: AndroidNetwork[];
  managementRoutes: NetworkSnapshot["managementRoutes"];
} {
  const tableFor = (
    text: string,
    iface: string,
    requireDefault: boolean,
  ): string | undefined => {
    const candidates: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (
        !new RegExp(
          `(?:^|\\s)dev\\s+${iface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`,
        ).test(line)
      )
        continue;
      if (requireDefault && !/^default\b/.test(line.trim())) continue;
      const table = line.match(/\btable\s+(\S+)/)?.[1] || "main";
      if (TABLE_PATTERN.test(table) && !candidates.includes(table)) {
        candidates.push(table);
      }
    }
    return (
      candidates.find((table) => table === iface) ||
      candidates.find((table) => !table.endsWith("_local")) ||
      candidates[0]
    );
  };
  const next = networks.map((network) => ({
    ...network,
    ipv4Table: tableFor(route4, network.interfaceName, true),
    ipv6Table: tableFor(route6, network.interfaceName, false),
    ipv6Default: Boolean(tableFor(route6, network.interfaceName, true)),
  }));
  const managedInterfaces = new Set(next.map((item) => item.interfaceName));
  const managementRoutes: NetworkSnapshot["managementRoutes"] = [];
  for (const [family, text] of [
    [4, route4],
    [6, route6],
  ] as const) {
    for (const line of text.split(/\r?\n/)) {
      const match = line
        .trim()
        .match(/^(\S+)\s+(?:.*\s)?dev\s+(\S+)(?:\s|$).*?\btable\s+(\S+)/);
      if (!match || match[1] === "default" || managedInterfaces.has(match[2]))
        continue;
      if (!INTERFACE_PATTERN.test(match[2]) || !TABLE_PATTERN.test(match[3]))
        continue;
      if (
        (family === 4 && !match[1].includes(".")) ||
        (family === 6 && !match[1].includes(":"))
      )
        continue;
      managementRoutes.push({ family, cidr: match[1], table: match[3] });
    }
  }
  return { networks: next, managementRoutes };
}

/** 验证默认数据订阅确为中国电信。 */
export function isChinaTelecomDefaultData(
  defaultSubOutput: string,
  subscriptionsOutput: string,
): boolean {
  const subId = defaultSubOutput.match(/-?\d+/)?.[0];
  if (!subId || Number(subId) < 0) return false;
  const blocks = subscriptionsOutput.split(
    /(?=SubscriptionInfoRecord\{)|(?=\{(?:id|subId)\s*[=:])|(?=\bsubId\s*=)/i,
  );
  return blocks.some(
    (block) =>
      new RegExp(`(?:subId|id)\\s*[=:]\\s*${subId}\\b`, "i").test(block) &&
      /(?:mccString\s*=\s*460.*mncString\s*=\s*11|mcc\s*=\s*460.*mnc\s*=\s*11|mccmnc\s*=\s*46011|carrierId.*46011)/is.test(
        block,
      ),
  );
}

interface CurlProbeInput {
  url: string;
  interfaceName?: string;
  timeoutMs: number;
  expectPublicIpv4: boolean;
}

/** 构造探针进程；绑定接口时仅将 curl 本身提升为 root。 */
export function buildCurlProbeInvocation(input: CurlProbeInput): {
  file: string;
  args: string[];
} {
  const curl = process.env.PREFIX
    ? path.join(process.env.PREFIX, "bin", "curl")
    : "curl";
  const seconds = Math.max(3, Math.ceil(input.timeoutMs / 1000));
  const args = [
    "--silent",
    "--show-error",
    "--connect-timeout",
    String(Math.min(5, seconds)),
    "--max-time",
    String(seconds),
    "--retry",
    "1",
    "--retry-all-errors",
    "--max-filesize",
    "16384",
    "--write-out",
    `${HTTP_STATUS_MARKER}%{http_code}`,
  ];
  if (input.interfaceName) args.push("--interface", input.interfaceName);
  args.push(input.url);
  if (!input.interfaceName) return { file: curl, args };
  const command = [curl, ...args]
    .map((value) => `'${value.replaceAll("'", `'"'"'`)}'`)
    .join(" ");
  return { file: "su", args: ["-c", command] };
}

/** 使用 Termux curl 执行有界探针；公网地址只在内存中用于出口一致性校验。 */
export function curlProbe(input: CurlProbeInput): Promise<string | void> {
  const invocation = buildCurlProbeInvocation(input);
  return new Promise((resolve, reject) => {
    execFile(
      invocation.file,
      invocation.args,
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024,
        timeout: input.timeoutMs + 3_000,
      },
      (error, stdout) => {
        if (error) return reject(error);
        const split = String(stdout).lastIndexOf(HTTP_STATUS_MARKER);
        const body = split >= 0 ? String(stdout).slice(0, split).trim() : "";
        const status = Number(
          split >= 0
            ? String(stdout)
                .slice(split + HTTP_STATUS_MARKER.length)
                .trim()
            : 0,
        );
        if (input.expectPublicIpv4) {
          if (
            status < 200 ||
            status >= 300 ||
            net.isIP(body) !== 4 ||
            ipv4InCidrs(body, ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"])
          ) {
            return reject(
              new Error("Internet probe did not return a public IPv4"),
            );
          }
        } else if (status < 200 || status >= 400) {
          return reject(new Error("LAN probe returned an unexpected status"));
        }
        resolve(input.expectPublicIpv4 ? body : undefined);
      },
    );
  });
}

/** 持久化、恢复并原子切换手机客户端网络策略。 */
export class NetworkRoutingManager {
  private readonly directory: string;
  private readonly statePath: string;
  private state: PersistedRoutingState;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    sharedStateDirectory: string,
    private readonly dependencies: NetworkRoutingDependencies,
  ) {
    this.directory = path.join(sharedStateDirectory, "network-routing");
    this.statePath = path.join(this.directory, "state.json");
    this.state = this.loadState();
  }

  isActive(): boolean {
    return this.state.active;
  }

  currentGeneration(): number {
    return this.state.generation;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release: () => void = () => undefined;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private loadState(): PersistedRoutingState {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.statePath, "utf8"),
      ) as PersistedRoutingState;
      if (parsed.formatVersion === 1 && Number.isInteger(parsed.generation))
        return parsed;
    } catch {
      // Missing or corrupt state is treated as disabled; no route is changed.
    }
    return {
      formatVersion: 1,
      active: false,
      generation: 0,
      status: "DISABLED",
    };
  }

  private saveState(state: PersistedRoutingState): void {
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.statePath);
    this.state = state;
  }

  private async inspect(): Promise<NetworkSnapshot> {
    const [connectivity, route4, route6, ipv4Rules, ipv6Rules] =
      await Promise.all([
        this.dependencies.readRoot("dumpsys connectivity"),
        this.dependencies.readRoot("ip -4 route show table all"),
        this.dependencies.readRoot("ip -6 route show table all"),
        this.dependencies.readRoot("ip -4 rule show"),
        this.dependencies.readRoot("ip -6 rule show"),
      ]);
    const attached = attachRouteTables(
      parseConnectivityNetworks(connectivity),
      route4,
      route6,
    );
    if (
      attached.networks.some(
        (item) => item.transport === "vpn" && item.connected,
      )
    ) {
      throw new NetworkRoutingError(
        "VPN_ACTIVE",
        "Active VPN is not supported by network routing V1",
      );
    }
    const wifi = attached.networks.find(
      (item) => item.transport === "wifi" && item.connected && item.validated,
    );
    const carrier = attached.networks.find(
      (item) =>
        item.transport === "carrier" && item.connected && item.validated,
    );
    if (!wifi || !wifi.ipv4Table)
      throw new NetworkRoutingError(
        "WIFI_UNAVAILABLE",
        "Validated Wi-Fi is unavailable",
      );
    if (!carrier || !carrier.ipv4Table)
      throw new NetworkRoutingError(
        "CARRIER_UNAVAILABLE",
        "Validated carrier data is unavailable",
      );
    const defaultNetId = Number(
      connectivity.match(/Active default network:\s*(\d+)/i)?.[1],
    );
    return {
      defaultNetId: Number.isInteger(defaultNetId) ? defaultNetId : null,
      wifi,
      carrier,
      managementRoutes: attached.managementRoutes,
      ipv4Rules,
      ipv6Rules,
    };
  }

  private async assertPrerequisites(
    snapshot: NetworkSnapshot,
    requireChinaTelecom: boolean,
  ): Promise<void> {
    const [alwaysOn, mobileData, defaultSub, subscriptions] = await Promise.all(
      [
        this.dependencies.readRoot("settings get global mobile_data_always_on"),
        this.dependencies.readRoot("settings get global mobile_data"),
        this.dependencies.readRoot("settings get global multi_sim_data_call"),
        this.dependencies.readRoot("dumpsys isub"),
      ],
    );
    if (alwaysOn.trim() !== "1" || mobileData.trim() !== "1") {
      throw new NetworkRoutingError(
        "CARRIER_UNAVAILABLE",
        "Mobile data and mobile_data_always_on must be enabled",
      );
    }
    if (
      requireChinaTelecom &&
      !isChinaTelecomDefaultData(defaultSub, subscriptions)
    ) {
      throw new NetworkRoutingError(
        "CARRIER_MISMATCH",
        "Default data subscription is not China Telecom 46011",
      );
    }
    if (!snapshot.wifi.validated)
      throw new NetworkRoutingError(
        "WIFI_UNAVAILABLE",
        "Wi-Fi is not validated",
      );
  }

  private async runProbes(
    policy: NetworkRoutingPolicy,
    snapshot: NetworkSnapshot,
    bound: boolean,
  ): Promise<string> {
    for (const url of policy.lanProbeUrls) {
      try {
        await this.dependencies.probe({
          url,
          interfaceName: bound ? snapshot.wifi.interfaceName : undefined,
          timeoutMs: policy.probeTimeoutMs,
          expectPublicIpv4: false,
        });
      } catch {
        throw new NetworkRoutingError("LAN_PROBE_FAILED", "LAN probe failed");
      }
    }
    const target =
      policy.internetTarget === "wifi" ? snapshot.wifi : snapshot.carrier;
    try {
      const publicIpv4 = await this.dependencies.probe({
        url: policy.internetProbeUrl,
        interfaceName: bound ? target.interfaceName : undefined,
        timeoutMs: policy.probeTimeoutMs,
        expectPublicIpv4: true,
      });
      if (typeof publicIpv4 !== "string" || net.isIP(publicIpv4) !== 4) {
        throw new Error("Internet probe did not return an exit identity");
      }
      return publicIpv4;
    } catch {
      throw new NetworkRoutingError(
        bound ? "INTERNET_PREFLIGHT_FAILED" : "INTERNET_POSTCHECK_FAILED",
        "Internet probe failed",
      );
    }
  }

  private assertAppliedPolicy(
    policy: NetworkRoutingPolicy,
    snapshot: NetworkSnapshot,
  ): void {
    const target =
      policy.internetTarget === "wifi" ? snapshot.wifi : snapshot.carrier;
    const escape = (value: string) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hasRule = (rules: string, priority: number, expression: string) =>
      new RegExp(`^${priority}:.*${expression}`, "m").test(rules);
    const boundNetworks = [snapshot.wifi, snapshot.carrier];
    const boundRulesValid = boundNetworks.every((network, index) =>
      hasRule(
        snapshot.ipv4Rules,
        BOUND_INTERFACE_RULE_START + index,
        `oif\\s+${escape(network.interfaceName)}.*lookup\\s+${escape(String(network.ipv4Table))}\\b`,
      ),
    );
    const lanRulesValid = policy.lanCidrs.every((cidr, index) =>
      hasRule(
        snapshot.ipv4Rules,
        IPV4_LAN_RULE_START + index,
        `to\\s+${escape(cidr)}\\b.*lookup\\s+${escape(String(snapshot.wifi.ipv4Table))}\\b`,
      ),
    );
    const ipv4DefaultValid = hasRule(
      snapshot.ipv4Rules,
      IPV4_DEFAULT_RULE,
      `lookup\\s+${escape(String(target.ipv4Table))}\\b`,
    );
    const expectedIpv6Table =
      target.ipv6Table && target.ipv6Default
        ? target.ipv6Table
        : String(IPV6_BLOCK_TABLE);
    const ipv6DefaultValid = hasRule(
      snapshot.ipv6Rules,
      IPV6_DEFAULT_RULE,
      `lookup\\s+${escape(expectedIpv6Table)}\\b`,
    );
    if (
      !boundRulesValid ||
      !lanRulesValid ||
      !ipv4DefaultValid ||
      !ipv6DefaultValid
    ) {
      throw new NetworkRoutingError(
        "NETWORK_ROUTING_POSTCHECK_FAILED",
        "Applied routing rules do not match the requested target",
      );
    }
  }

  private clearManagedRulesCommand(): string {
    const ipv4Priorities = [
      BOUND_INTERFACE_RULE_START,
      BOUND_INTERFACE_RULE_START + 1,
      ...Array.from({ length: 16 }, (_, index) => IPV4_LAN_RULE_START + index),
      IPV4_DEFAULT_RULE,
    ].join(" ");
    const ipv6Priorities = [
      BOUND_INTERFACE_RULE_START,
      BOUND_INTERFACE_RULE_START + 1,
      IPV6_DEFAULT_RULE,
    ].join(" ");
    return `for p in ${ipv4Priorities}; do ip -4 rule del priority "$p" 2>/dev/null || true; done; for p in ${ipv6Priorities}; do ip -6 rule del priority "$p" 2>/dev/null || true; done; ip -6 route flush table ${IPV6_BLOCK_TABLE} 2>/dev/null || true`;
  }

  private buildApplyCommand(
    policy: NetworkRoutingPolicy,
    snapshot: NetworkSnapshot,
  ): string {
    const target =
      policy.internetTarget === "wifi" ? snapshot.wifi : snapshot.carrier;
    const commands = ["set -e", this.clearManagedRulesCommand()];
    let priority = BOUND_INTERFACE_RULE_START;
    for (const network of [snapshot.wifi, snapshot.carrier]) {
      commands.push(
        `ip -4 rule add priority ${priority} from all oif ${network.interfaceName} lookup ${network.ipv4Table}`,
      );
      if (network.ipv6Table) {
        commands.push(
          `ip -6 rule add priority ${priority} from all oif ${network.interfaceName} lookup ${network.ipv6Table}`,
        );
      }
      priority += 1;
    }
    priority = IPV4_LAN_RULE_START;
    for (const cidr of policy.lanCidrs) {
      commands.push(
        `ip -4 rule add priority ${priority++} from all to ${cidr} fwmark 0x0/0xffff iif lo lookup ${snapshot.wifi.ipv4Table}`,
      );
    }
    commands.push(
      `ip -4 rule add priority ${IPV4_DEFAULT_RULE} from all fwmark 0x0/0xffff iif lo lookup ${target.ipv4Table}`,
    );
    if (target.ipv6Table && target.ipv6Default) {
      commands.push(
        `ip -6 rule add priority ${IPV6_DEFAULT_RULE} from all fwmark 0x0/0xffff iif lo lookup ${target.ipv6Table}`,
      );
    } else {
      commands.push(
        `ip -6 route replace unreachable default table ${IPV6_BLOCK_TABLE} metric 42760`,
      );
      commands.push(
        `ip -6 rule add priority ${IPV6_DEFAULT_RULE} from all fwmark 0x0/0xffff iif lo lookup ${IPV6_BLOCK_TABLE}`,
      );
    }
    commands.push(`ndc network default set ${target.netId}`);
    return commands.join("; ");
  }

  private async removeManagedRules(
    defaultNetId?: number | null,
  ): Promise<void> {
    const command = ["set -e", this.clearManagedRulesCommand()];
    command.push(
      defaultNetId
        ? `ndc network default set ${defaultNetId}`
        : "ndc network default clear",
    );
    await this.dependencies.runRoot(command.join("; "));
  }

  async apply(raw: Record<string, unknown>): Promise<NetworkRoutingResult> {
    return this.runExclusive(() => this.applyExclusive(raw));
  }

  private async applyExclusive(
    raw: Record<string, unknown>,
  ): Promise<NetworkRoutingResult> {
    let policy: NetworkRoutingPolicy;
    try {
      policy = parseNetworkRoutingPolicy(raw);
    } catch (error) {
      return this.failure(error, Number(raw.generation) || 0, false);
    }
    if (
      policy.generation < this.state.generation ||
      (policy.generation === this.state.generation &&
        (!this.state.active ||
          JSON.stringify(policy) !== JSON.stringify(this.state.policy)))
    ) {
      return this.failure(
        new NetworkRoutingError(
          "STALE_ROUTING_GENERATION",
          "Routing generation is stale",
        ),
        policy.generation,
        false,
      );
    }
    if (policy.generation === this.state.generation && this.state.active) {
      return this.success(
        policy,
        undefined,
        "Network routing policy is already active",
      );
    }

    const previous = this.state;
    let snapshot: NetworkSnapshot;
    let targetPublicIpv4: string;
    try {
      snapshot = await this.inspect();
      await this.assertPrerequisites(
        snapshot,
        policy.internetTarget === "carrier",
      );
      targetPublicIpv4 = await this.runProbes(policy, snapshot, true);
    } catch (error) {
      return this.failure(error, policy.generation, false);
    }

    try {
      await this.dependencies.runRoot(this.buildApplyCommand(policy, snapshot));
      await this.dependencies.reconnectManagement();
      const postSnapshot = await this.inspect();
      this.assertAppliedPolicy(policy, postSnapshot);
      const actualPublicIpv4 = await this.runProbes(
        policy,
        postSnapshot,
        false,
      );
      if (actualPublicIpv4 !== targetPublicIpv4) {
        throw new NetworkRoutingError(
          "NETWORK_ROUTING_POSTCHECK_FAILED",
          "Unbound Internet traffic did not use the requested target",
        );
      }
      this.saveState({
        formatVersion: 1,
        active: true,
        generation: policy.generation,
        policy,
        baselineDefaultNetId: previous.active
          ? previous.baselineDefaultNetId
          : snapshot.defaultNetId,
        verifiedAt: this.dependencies.now(),
        status: "ACTIVE",
      });
      return this.success(
        policy,
        postSnapshot,
        "Network routing policy is active",
      );
    } catch (error) {
      let rollbackSucceeded = false;
      try {
        if (previous.active && previous.policy) {
          const rollbackSnapshot = await this.inspect();
          await this.dependencies.runRoot(
            this.buildApplyCommand(previous.policy, rollbackSnapshot),
          );
        } else {
          await this.removeManagedRules(snapshot.defaultNetId);
        }
        await this.dependencies.reconnectManagement();
        rollbackSucceeded = true;
        this.state = previous;
      } catch {
        this.saveState({
          formatVersion: 1,
          active: true,
          generation: policy.generation,
          policy: previous.active && previous.policy ? previous.policy : policy,
          baselineDefaultNetId:
            previous.baselineDefaultNetId ?? snapshot.defaultNetId,
          status: "DEGRADED",
        });
        return {
          status: "FAILURE",
          code: "NETWORK_ROUTING_ROLLBACK_FAILED",
          message: "Network routing failed and rollback could not be completed",
          data: {
            generation: policy.generation,
            policyRevision: policy.policyRevision,
            target: policy.internetTarget,
            rollback: { attempted: true, succeeded: false },
          },
        };
      }
      return {
        status: "FAILURE",
        code: "NETWORK_ROUTING_ROLLED_BACK",
        message:
          error instanceof Error
            ? "Network routing verification failed and was rolled back"
            : "Network routing was rolled back",
        data: {
          generation: policy.generation,
          policyRevision: policy.policyRevision,
          target: policy.internetTarget,
          probes: { lan: false, internet: false },
          rollback: { attempted: true, succeeded: rollbackSucceeded },
        },
      };
    }
  }

  async disable(raw: Record<string, unknown>): Promise<NetworkRoutingResult> {
    return this.runExclusive(() => this.disableExclusive(raw));
  }

  private async disableExclusive(
    raw: Record<string, unknown>,
  ): Promise<NetworkRoutingResult> {
    const generation = Number(raw.generation);
    if (!Number.isInteger(generation) || generation < 1) {
      return this.failure(
        new NetworkRoutingError(
          "INVALID_PARAMS",
          "generation must be a positive integer",
        ),
        generation || 0,
        false,
      );
    }
    if (generation <= this.state.generation) {
      return this.failure(
        new NetworkRoutingError(
          "STALE_ROUTING_GENERATION",
          "Routing generation is stale",
        ),
        generation,
        false,
      );
    }
    try {
      let androidDefaultNetId = this.state.baselineDefaultNetId;
      try {
        const connectivity = await this.dependencies.readRoot(
          "dumpsys connectivity",
        );
        const current = Number(
          connectivity.match(/Active default network:\s*(\d+)/i)?.[1],
        );
        if (Number.isInteger(current)) androidDefaultNetId = current;
      } catch {
        // Fall back to the baseline captured before routing was enabled.
      }
      await this.removeManagedRules(androidDefaultNetId);
      await this.dependencies.reconnectManagement();
      this.saveState({
        formatVersion: 1,
        active: false,
        generation,
        status: "DISABLED",
      });
      return {
        status: "SUCCESS",
        code: "NETWORK_ROUTING_DISABLED",
        message: "Managed network routing was disabled",
        data: { generation, rollback: { attempted: false, succeeded: true } },
      };
    } catch {
      return this.failure(
        new NetworkRoutingError(
          "NETWORK_ROUTING_ROLLBACK_FAILED",
          "Failed to restore Android default routing",
        ),
        generation,
        true,
      );
    }
  }

  async restoreOnStartup(): Promise<void> {
    return this.runExclusive(() => this.restoreOnStartupExclusive());
  }

  private async restoreOnStartupExclusive(): Promise<void> {
    if (!this.state.active || !this.state.policy) return;
    try {
      const snapshot = await this.inspect();
      await this.assertPrerequisites(
        snapshot,
        this.state.policy.internetTarget === "carrier",
      );
      await this.dependencies.runRoot(
        this.buildApplyCommand(this.state.policy, snapshot),
      );
      this.assertAppliedPolicy(this.state.policy, await this.inspect());
      this.saveState({
        ...this.state,
        status: "ACTIVE",
        verifiedAt: this.dependencies.now(),
      });
    } catch {
      this.saveState({ ...this.state, status: "DEGRADED" });
      throw new NetworkRoutingError(
        "NETWORK_ROUTING_RESTORE_FAILED",
        "Persisted network routing could not be restored",
      );
    }
  }

  async checkDrift(): Promise<void> {
    return this.runExclusive(() => this.checkDriftExclusive());
  }

  private async checkDriftExclusive(): Promise<void> {
    if (!this.state.active || !this.state.policy) return;
    try {
      let snapshot = await this.inspect();
      await this.assertPrerequisites(
        snapshot,
        this.state.policy.internetTarget === "carrier",
      );
      let applied = true;
      try {
        this.assertAppliedPolicy(this.state.policy, snapshot);
      } catch {
        applied = false;
      }
      if (!applied) {
        await this.dependencies.runRoot(
          this.buildApplyCommand(this.state.policy, snapshot),
        );
        await this.dependencies.reconnectManagement();
        snapshot = await this.inspect();
        this.assertAppliedPolicy(this.state.policy, snapshot);
      }
      const targetPublicIpv4 = await this.runProbes(
        this.state.policy,
        snapshot,
        true,
      );
      const actualPublicIpv4 = await this.runProbes(
        this.state.policy,
        snapshot,
        false,
      );
      if (actualPublicIpv4 !== targetPublicIpv4) {
        throw new NetworkRoutingError(
          "NETWORK_ROUTING_POSTCHECK_FAILED",
          "Unbound Internet traffic did not use the requested target",
        );
      }
      if (this.state.status !== "ACTIVE")
        this.saveState({
          ...this.state,
          status: "ACTIVE",
          verifiedAt: this.dependencies.now(),
        });
    } catch {
      if (this.state.status !== "DEGRADED")
        this.saveState({ ...this.state, status: "DEGRADED" });
    }
  }

  private success(
    policy: NetworkRoutingPolicy,
    snapshot?: NetworkSnapshot,
    message = "Network routing succeeded",
  ): NetworkRoutingResult {
    return {
      status: "SUCCESS",
      code: "OK",
      message,
      data: {
        generation: policy.generation,
        policyRevision: policy.policyRevision,
        target: policy.internetTarget,
        wifiInterface: snapshot?.wifi.interfaceName,
        carrierInterface: snapshot?.carrier.interfaceName,
        probes: { lan: true, internet: true },
        rollback: { attempted: false, succeeded: true },
      },
    };
  }

  private failure(
    error: unknown,
    generation: number,
    rollbackAttempted: boolean,
  ): NetworkRoutingResult {
    const routingError =
      error instanceof NetworkRoutingError
        ? error
        : new NetworkRoutingError(
            "NETWORK_ROUTING_FAILED",
            "Network routing failed",
          );
    return {
      status:
        routingError.code === "INVALID_PARAMS" ||
        routingError.code === "STALE_ROUTING_GENERATION"
          ? "REJECTED"
          : "FAILURE",
      code: routingError.code,
      message: routingError.message,
      data: {
        generation,
        rollback: { attempted: rollbackAttempted, succeeded: false },
      },
    };
  }
}
