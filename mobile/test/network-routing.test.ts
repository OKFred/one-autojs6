import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  attachRouteTables,
  buildCurlProbeInvocation,
  NetworkRoutingManager,
  ipv4InCidrs,
  isChinaTelecomDefaultData,
  normalizePrivateIpv4Cidr,
  parseConnectivityNetworks,
  parseNetworkRoutingPolicy,
} from "../src/network-routing.js";

const connectivity = `
Active default network: 109
NetworkAgentInfo{ network{109} ni{[type: WIFI[], state: CONNECTED/CONNECTED]} nc{[ Transports: WIFI Capabilities: VALIDATED&INTERNET]} lp{{InterfaceName: wlan0 LinkAddresses: [192.168.12.160/24]}} }
NetworkAgentInfo{ network{108} ni{[type: MOBILE[], state: CONNECTED/CONNECTED]} nc{[ Transports: CELLULAR Capabilities: VALIDATED&INTERNET]} lp{{InterfaceName: rmnet_data2 LinkAddresses: [10.63.113.178/30]}} }
`;
const route4 = `
default via 192.168.12.1 dev wlan0 table wlan0 proto static
192.168.12.0/24 dev wlan0 table wlan0 proto static
default via 10.63.113.177 dev rmnet_data2 table rmnet_data2 proto static
192.168.44.0/24 dev bt-pan table bt-pan proto static
`;
const route6 = `
default via fe80::1 dev wlan0 table wlan0 proto ra
2001:db8:1::/64 dev wlan0 table wlan0 proto ra
fe80::/64 dev bt-pan table bt-pan proto kernel
`;
const subscriptions = `
SubscriptionInfoRecord{subId=4 mccString=460 mncString=11 displayName=China Telecom}
`;
const policy = {
  generation: 1,
  policyRevision: 3,
  internetTarget: "carrier",
  lanCidrs: ["192.168.0.0/16"],
  lanProbeUrls: ["http://192.168.1.4/", "http://192.168.12.1:8080/"],
  internetProbeUrl: "http://ip.3322.net/",
  probeTimeoutMs: 10_000,
} as const;

assert.equal(normalizePrivateIpv4Cidr("192.168.0.0/16"), "192.168.0.0/16");
assert.equal(ipv4InCidrs("192.168.12.1", ["192.168.0.0/16"]), true);
assert.throws(() => normalizePrivateIpv4Cidr("192.168.1.4/16"), /canonical/);
assert.throws(() => normalizePrivateIpv4Cidr("8.8.8.0/24"), /RFC1918/);
assert.throws(
  () =>
    parseNetworkRoutingPolicy({ ...policy, lanProbeUrls: ["http://8.8.8.8/"] }),
  /inside lanCidrs/,
);
assert.equal(parseConnectivityNetworks(connectivity).length, 2);
assert.equal(
  attachRouteTables(
    parseConnectivityNetworks(connectivity),
    route4,
    "fd00::/64 dev wlan0 table wlan0_local\nfd00::/48 dev wlan0 table wlan0\n",
  ).networks.find((network) => network.transport === "wifi")?.ipv6Table,
  "wlan0",
);
assert.equal(
  buildCurlProbeInvocation({
    url: "http://ip.3322.net/",
    interfaceName: "rmnet_data2",
    timeoutMs: 10_000,
    expectPublicIpv4: true,
  }).file,
  "su",
);
assert.notEqual(
  buildCurlProbeInvocation({
    url: "http://ip.3322.net/",
    timeoutMs: 10_000,
    expectPublicIpv4: true,
  }).file,
  "su",
);
assert.equal(isChinaTelecomDefaultData("4", subscriptions), true);
assert.equal(
  isChinaTelecomDefaultData(
    "3",
    "[{id=3 mcc=234 mnc=10}, {id=4 mcc=460 mnc=11}]",
  ),
  false,
);

function createDependencies(
  options: {
    failPreflight?: boolean;
    failPostcheck?: boolean;
    failRollback?: boolean;
    missingManagedRules?: boolean;
  } = {},
) {
  const mutations: string[] = [];
  let probes = 0;
  let reconnects = 0;
  return {
    mutations,
    get probes() {
      return probes;
    },
    get reconnects() {
      return reconnects;
    },
    dependencies: {
      readRoot: async (command: string) => {
        if (command === "dumpsys connectivity") return connectivity;
        if (command === "ip -4 route show table all") return route4;
        if (command === "ip -6 route show table all") return route6;
        if (command === "ip -4 rule show") {
          if (options.missingManagedRules) return "";
          return "10400: from all oif wlan0 lookup wlan0\n10401: from all oif rmnet_data2 lookup rmnet_data2\n10500: from all to 192.168.0.0/16 lookup wlan0\n10600: from all lookup rmnet_data2\n";
        }
        if (command === "ip -6 rule show") {
          if (options.missingManagedRules) return "";
          return "10600: from all lookup 16661\n";
        }
        if (command.includes("mobile_data_always_on")) return "1\n";
        if (command.includes("mobile_data")) return "1\n";
        if (command.includes("multi_sim_data_call")) return "4\n";
        if (command === "dumpsys isub") return subscriptions;
        throw new Error(`unexpected read: ${command}`);
      },
      runRoot: async (command: string) => {
        mutations.push(command);
        if (options.failRollback && mutations.length === 2) {
          throw new Error("rollback failed");
        }
      },
      reconnectManagement: async () => {
        reconnects += 1;
      },
      probe: async () => {
        probes += 1;
        if (options.failPreflight && probes === 1) throw new Error("offline");
        if (options.failPostcheck && probes === 4)
          throw new Error("offline after switch");
      },
      now: () => 1_700_000_000_000,
    },
  };
}

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "network-routing-test-"),
);
try {
  const healthyContext = createDependencies();
  const manager = new NetworkRoutingManager(
    temporaryRoot,
    healthyContext.dependencies,
  );
  const result = await manager.apply({ ...policy });
  assert.equal(result.status, "SUCCESS");
  assert.equal(manager.isActive(), true);
  assert.equal(healthyContext.mutations.length, 1);
  assert.match(healthyContext.mutations[0], /lookup wlan0/);
  assert.match(healthyContext.mutations[0], /lookup rmnet_data2/);
  assert.match(healthyContext.mutations[0], /fwmark 0x0\/0xffff iif lo/);
  assert.match(healthyContext.mutations[0], /ndc network default set 108/);
  assert.equal(healthyContext.reconnects, 1);
  assert.equal(result.data.wifiInterface, "wlan0");
  assert.equal(result.data.carrierInterface, "rmnet_data2");
  await manager.checkDrift();
  assert.equal(healthyContext.mutations.length, 1);
  assert.equal(healthyContext.reconnects, 1);

  const driftContext = createDependencies({ missingManagedRules: true });
  const driftManager = new NetworkRoutingManager(
    temporaryRoot,
    driftContext.dependencies,
  );
  await driftManager.checkDrift();
  assert.equal(driftContext.mutations.length, 1);
  assert.equal(driftContext.reconnects, 1);

  const stale = await manager.apply({ ...policy, generation: 0 });
  assert.equal(stale.code, "INVALID_PARAMS");

  const restoredContext = createDependencies();
  const restored = new NetworkRoutingManager(
    temporaryRoot,
    restoredContext.dependencies,
  );
  await restored.restoreOnStartup();
  assert.equal(restoredContext.mutations.length, 1);
  const disabled = await restored.disable({ generation: 2 });
  assert.equal(disabled.code, "NETWORK_ROUTING_DISABLED");
  assert.equal(restored.isActive(), false);

  const noMutationRoot = path.join(temporaryRoot, "preflight");
  const preflightContext = createDependencies({ failPreflight: true });
  const preflightManager = new NetworkRoutingManager(
    noMutationRoot,
    preflightContext.dependencies,
  );
  const preflight = await preflightManager.apply({ ...policy });
  assert.equal(preflight.code, "LAN_PROBE_FAILED");
  assert.equal(preflightContext.mutations.length, 0);

  const rollbackRoot = path.join(temporaryRoot, "rollback");
  const rollbackContext = createDependencies({ failPostcheck: true });
  const rollbackManager = new NetworkRoutingManager(
    rollbackRoot,
    rollbackContext.dependencies,
  );
  const rollback = await rollbackManager.apply({ ...policy });
  assert.equal(rollback.code, "NETWORK_ROUTING_ROLLED_BACK");
  assert.deepEqual(rollback.data.rollback, {
    attempted: true,
    succeeded: true,
  });
  assert.equal(rollbackContext.mutations.length, 2);
  assert.match(rollbackContext.mutations[1], /ndc network default set 109/);
  assert.equal(rollbackManager.isActive(), false);

  const rollbackFailureRoot = path.join(temporaryRoot, "rollback-failure");
  const rollbackFailureContext = createDependencies({
    failPostcheck: true,
    failRollback: true,
  });
  const rollbackFailureManager = new NetworkRoutingManager(
    rollbackFailureRoot,
    rollbackFailureContext.dependencies,
  );
  const rollbackFailure = await rollbackFailureManager.apply({ ...policy });
  assert.equal(rollbackFailure.code, "NETWORK_ROUTING_ROLLBACK_FAILED");
  assert.equal(rollbackFailureManager.isActive(), true);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("network routing tests passed");
