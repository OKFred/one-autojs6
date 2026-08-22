import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  ipv4InCidrs,
  NetworkRoutingManager,
  type NetworkRoutingPolicy,
} from "../src/network-routing.js";

if (process.env.AUTOJS6_ROUTING_DEVICE_CANARY !== "1") {
  throw new Error(
    "Refusing to mutate device routes without AUTOJS6_ROUTING_DEVICE_CANARY=1",
  );
}

const LAN_CIDRS = ["192.168.0.0/16"];
const CURL = "/data/data/com.termux/files/usr/bin/curl";
const HTTP_STATUS_MARKER = "__AUTOJS6_HTTP_STATUS__";
const MANAGED_PRIORITY_PATTERN =
  /^(?:10400|10401|105(?:0[0-9]|1[0-5])|10600):/m;
const CLEAN_MANAGED_RULES =
  'for p in 10400 10401 10500 10501 10502 10503 10504 10505 10506 10507 10508 10509 10510 10511 10512 10513 10514 10515 10600; do ip -4 rule del priority "$p" 2>/dev/null || true; done; for p in 10400 10401 10600; do ip -6 rule del priority "$p" 2>/dev/null || true; done; ip -6 route flush table 16661 2>/dev/null || true';

function adb(args: string[]): string {
  return execFileSync("adb", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
}

function readRoot(command: string): string {
  return adb(["shell", `su -c ${shellQuote(command)}`]);
}

function runRoot(command: string): void {
  readRoot(command);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const termuxUid = Number(readRoot("stat -c %u /data/data/com.termux").trim());
if (!Number.isInteger(termuxUid) || termuxUid < 10_000) {
  throw new Error("Unable to resolve the Termux application UID");
}
function readTermux(command: string): string {
  return adb(["shell", `su ${termuxUid} -c ${shellQuote(command)}`]);
}
const probeServerAddress = readRoot(
  `${shellQuote(CURL)} --ipv4 --silent --show-error --connect-timeout 5 --max-time 10 --output /dev/null --write-out '%{remote_ip}' http://ip.3322.net/`,
).trim();
if (net.isIP(probeServerAddress) !== 4) {
  throw new Error("Unable to resolve the Internet probe server");
}

async function probe(input: {
  url: string;
  interfaceName?: string;
  timeoutMs: number;
  expectPublicIpv4: boolean;
}): Promise<void> {
  const seconds = Math.max(3, Math.ceil(input.timeoutMs / 1000));
  const args = [
    CURL,
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
  if (!input.interfaceName && input.url === "http://ip.3322.net/") {
    args.push("--resolve", `ip.3322.net:80:${probeServerAddress}`);
  }
  args.push(input.url);
  const command = args.map(shellQuote).join(" ");
  const output = input.interfaceName ? readRoot(command) : readTermux(command);
  const split = output.lastIndexOf(HTTP_STATUS_MARKER);
  const body = split >= 0 ? output.slice(0, split).trim() : "";
  const status = Number(
    split >= 0 ? output.slice(split + HTTP_STATUS_MARKER.length).trim() : 0,
  );
  if (input.expectPublicIpv4) {
    if (
      status < 200 ||
      status >= 300 ||
      net.isIP(body) !== 4 ||
      ipv4InCidrs(body, ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"])
    ) {
      throw new Error("Internet probe did not return a public IPv4");
    }
    return body;
  }
  if (status < 200 || status >= 400) {
    throw new Error("LAN probe returned an unexpected status");
  }
  return undefined;
}

function publicExit(interfaceName?: string): string {
  const args = [
    CURL,
    "--silent",
    "--show-error",
    "--connect-timeout",
    "5",
    "--max-time",
    "10",
  ];
  if (interfaceName) args.push("--interface", interfaceName);
  if (!interfaceName) {
    args.push("--resolve", `ip.3322.net:80:${probeServerAddress}`);
  }
  args.push("http://ip.3322.net/");
  const command = args.map(shellQuote).join(" ");
  const value = (
    interfaceName ? readRoot(command) : readTermux(command)
  ).trim();
  if (
    net.isIP(value) !== 4 ||
    ipv4InCidrs(value, ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"])
  ) {
    throw new Error("Invalid public IPv4 response");
  }
  return value;
}

const devices = adb(["devices"])
  .split(/\r?\n/)
  .slice(1)
  .map((line) => line.trim().split(/\s+/))
  .filter((parts) => parts[0] && parts[1] === "device");
const selectedSerial = process.env.ANDROID_SERIAL;
const selectedDevices = selectedSerial
  ? devices.filter((parts) => parts[0] === selectedSerial)
  : devices;
if (selectedDevices.length !== 1) {
  throw new Error(
    "Exactly one ADB device is required; set ANDROID_SERIAL when multiple transports are connected",
  );
}
const serialIp = selectedDevices[0][0].match(/^([^:]+):\d+$/)?.[1];
if (serialIp && !ipv4InCidrs(serialIp, LAN_CIDRS)) {
  throw new Error("TCP ADB is not protected by the configured LAN CIDR");
}

const initialRules = readRoot("ip -4 rule show");
if (MANAGED_PRIORITY_PATTERN.test(initialRules)) {
  throw new Error("Managed routing priorities are already in use");
}
const connectivity = readRoot("dumpsys connectivity");
const baselineNetId = Number(
  connectivity.match(/Active default network:\s*(\d+)/i)?.[1],
);
if (!Number.isInteger(baselineNetId)) {
  throw new Error("Unable to capture Android default netId");
}
readRoot(`test -x ${shellQuote(CURL)}`);

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "network-routing-device-"),
);
const manager = new NetworkRoutingManager(temporaryRoot, {
  readRoot: async (command) => readRoot(command),
  runRoot: async (command) => runRoot(command),
  reconnectManagement: async () => {
    if (adb(["get-state"]).trim() !== "device") {
      throw new Error("ADB management path disconnected");
    }
  },
  probe,
  now: () => Date.now(),
});

const basePolicy: Omit<NetworkRoutingPolicy, "generation" | "internetTarget"> =
  {
    policyRevision: 1,
    lanCidrs: LAN_CIDRS,
    lanProbeUrls: ["http://192.168.1.4/", "http://192.168.12.1:8080/"],
    internetProbeUrl: "http://ip.3322.net/",
    probeTimeoutMs: 10_000,
  };

const report = {
  exitsDiffer: false,
  carrier: { result: "NOT_RUN", lanViaWifi: false, ipv6Target: false },
  wifi: { result: "NOT_RUN", lanViaWifi: false, ipv6Blocked: false },
  rollback: { result: "NOT_RUN", rulesRemoved: false, defaultRestored: false },
  disable: { result: "NOT_RUN", rulesRemoved: false, defaultRestored: false },
};
let cleanlyDisabled = false;
try {
  const wifiExit = publicExit("wlan0");
  const carrierExit = publicExit("rmnet_data2");
  report.exitsDiffer = wifiExit !== carrierExit;
  if (!report.exitsDiffer) throw new Error("Wi-Fi and carrier exits are equal");

  const carrier = await manager.apply({
    ...basePolicy,
    generation: 1,
    internetTarget: "carrier",
  });
  report.carrier.result = carrier.code;
  report.carrier.lanViaWifi =
    /\bdev wlan0\b/.test(readRoot("ip -4 route get 192.168.1.4")) &&
    /\bdev wlan0\b/.test(readRoot("ip -4 route get 192.168.12.1"));
  report.carrier.ipv6Target = /10600:.*lookup rmnet_data2/m.test(
    readRoot("ip -6 rule show"),
  );
  if (
    carrier.status !== "SUCCESS" ||
    !report.carrier.lanViaWifi ||
    !report.carrier.ipv6Target ||
    publicExit() !== carrierExit
  ) {
    throw new Error("Carrier canary verification failed");
  }

  const wifi = await manager.apply({
    ...basePolicy,
    generation: 2,
    internetTarget: "wifi",
  });
  report.wifi.result = wifi.code;
  report.wifi.lanViaWifi =
    /\bdev wlan0\b/.test(readRoot("ip -4 route get 192.168.1.4")) &&
    /\bdev wlan0\b/.test(readRoot("ip -4 route get 192.168.12.1"));
  report.wifi.ipv6Blocked =
    /10600:.*lookup 16661/m.test(readRoot("ip -6 rule show")) &&
    /unreachable default/.test(readRoot("ip -6 route show table 16661"));
  if (
    wifi.status !== "SUCCESS" ||
    !report.wifi.lanViaWifi ||
    !report.wifi.ipv6Blocked ||
    publicExit() !== wifiExit
  ) {
    throw new Error("Wi-Fi canary verification failed");
  }

  const disabled = await manager.disable({ generation: 3 });
  report.disable.result = disabled.code;
  report.disable.rulesRemoved = !MANAGED_PRIORITY_PATTERN.test(
    readRoot("ip -4 rule show"),
  );
  report.disable.defaultRestored = publicExit() === wifiExit;
  cleanlyDisabled =
    disabled.status === "SUCCESS" &&
    report.disable.rulesRemoved &&
    report.disable.defaultRestored;
  if (!cleanlyDisabled) throw new Error("Disable verification failed");

  cleanlyDisabled = false;
  const rollbackManager = new NetworkRoutingManager(
    path.join(temporaryRoot, "rollback"),
    {
      readRoot: async (command) => readRoot(command),
      runRoot: async (command) => runRoot(command),
      reconnectManagement: async () => {
        if (adb(["get-state"]).trim() !== "device") {
          throw new Error("ADB management path disconnected");
        }
      },
      probe: async (input) => {
        if (!input.interfaceName && input.expectPublicIpv4) {
          throw new Error("Injected post-switch Internet failure");
        }
        await probe(input);
      },
      now: () => Date.now(),
    },
  );
  const rolledBack = await rollbackManager.apply({
    ...basePolicy,
    generation: 1,
    internetTarget: "carrier",
  });
  report.rollback.result = rolledBack.code;
  report.rollback.rulesRemoved =
    !MANAGED_PRIORITY_PATTERN.test(readRoot("ip -4 rule show")) &&
    !MANAGED_PRIORITY_PATTERN.test(readRoot("ip -6 rule show"));
  report.rollback.defaultRestored = publicExit() === wifiExit;
  cleanlyDisabled =
    rolledBack.code === "NETWORK_ROUTING_ROLLED_BACK" &&
    rolledBack.data.rollback?.succeeded === true &&
    report.rollback.rulesRemoved &&
    report.rollback.defaultRestored;
  if (!cleanlyDisabled)
    throw new Error("Automatic rollback verification failed");
  console.log(JSON.stringify(report));
} catch (error) {
  console.log(JSON.stringify(report));
  throw error;
} finally {
  if (!cleanlyDisabled) {
    runRoot(
      `${CLEAN_MANAGED_RULES}; ndc network default set ${baselineNetId}`,
    );
  }
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedOsTemporary = path.resolve(os.tmpdir());
  if (!resolvedTemporaryRoot.startsWith(`${resolvedOsTemporary}${path.sep}`)) {
    throw new Error(
      "Refusing to remove a temporary directory outside os.tmpdir",
    );
  }
  fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
}
