import assert from "node:assert/strict";
import test from "node:test";

import {
  RemoteControlRouteProbeError,
  RemoteControlRouteProbeService,
  extractRemoteControlIceCandidateAddress,
  normalizeRemoteControlRouteAddress,
  parseRemoteControlPingLatency,
  parseRemoteControlTraceOutput,
  type RemoteControlRouteProbeCommandResult,
  type RemoteControlRouteProbeView,
} from "../src/service/remote-control-route-probe.service.js";

/**
 * Poll one deterministic in-memory probe until it reaches a terminal state.
 *
 * @param service Isolated route-probe service.
 * @param sessionId Owning remote-control session.
 * @param taskId Probe task identifier.
 * @returns Completed task view.
 */
async function waitForRouteProbe(
  service: RemoteControlRouteProbeService,
  sessionId: string,
  taskId: string,
): Promise<RemoteControlRouteProbeView> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const task = service.getProbe(sessionId, taskId);
    assert.ok(task);
    if (task.status !== "EXECUTING") return task;
  }
  throw new Error("Route probe did not finish in the test window");
}

test("route parsing keeps numbered hops and works across localized latency text", () => {
  assert.equal(
    normalizeRemoteControlRouteAddress("2001:0db8:0:0:0:0:0:1"),
    "2001:db8::1",
  );
  assert.equal(
    extractRemoteControlIceCandidateAddress(
      "candidate:2 1 udp 2122260223 192.168.50.8 53124 typ host generation 0",
    ),
    "192.168.50.8",
  );
  assert.equal(
    extractRemoteControlIceCandidateAddress(
      "candidate:3 1 udp 2122260223 127.0.0.1 53124 typ host",
    ),
    null,
  );
  assert.equal(
    extractRemoteControlIceCandidateAddress(
      "candidate:4 1 udp 2122260223 phone.local 53124 typ host",
    ),
    null,
  );

  const hops = parseRemoteControlTraceOutput(`
Tracing route without resolving names
  1    <1 ms     1 ms    <1 ms  192.168.1.1
  2     *        *        *     Request timed out.
  3    12 毫秒   11 毫秒   13 毫秒  203.0.113.8
`);
  assert.deepEqual(hops, [
    { index: 1, address: "192.168.1.1", traceLatencyMs: 0.7 },
    { index: 2, address: null, traceLatencyMs: null },
    { index: 3, address: "203.0.113.8", traceLatencyMs: 12 },
  ]);
  assert.equal(parseRemoteControlPingLatency("Reply: time=7ms TTL=64"), 7);
  assert.equal(parseRemoteControlPingLatency("回复: 时间<1毫秒 TTL=64"), 0.5);
  assert.equal(parseRemoteControlPingLatency("Request timed out."), null);
});

test("route probe returns IP, optional PTR name, and ping per responding hop", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runCommand = async (
    file: string,
    args: readonly string[],
  ): Promise<RemoteControlRouteProbeCommandResult> => {
    calls.push({ file, args: [...args] });
    if (file === "tracert.exe") {
      return {
        stdout:
          "  1    2 ms    2 ms    2 ms  192.168.1.1\r\n" +
          "  2     *       *       *     Request timed out.\r\n" +
          "  3   15 ms   14 ms   16 ms  203.0.113.8\r\n",
        timedOut: false,
        unavailable: false,
      };
    }
    const address = args.at(-1);
    return {
      stdout: address === "192.168.1.1" ? "Reply time=3ms" : "Request timed out.",
      timedOut: false,
      unavailable: false,
    };
  };
  const service = new RemoteControlRouteProbeService({
    platform: "win32",
    runCommand,
    reverseDns: async (address) =>
      address === "192.168.1.1" ? ["router.home"] : [],
    createId: () => "route_task_0001",
    now: () => 1_000,
  });
  try {
    const accepted = service.createProbe("remote_session_01", "203.0.113.8");
    assert.equal(accepted.status, "EXECUTING");
    assert.deepEqual(accepted.hops, []);
    const completed = await waitForRouteProbe(
      service,
      "remote_session_01",
      accepted.taskId,
    );
    assert.equal(completed.status, "SUCCESS");
    assert.equal(completed.complete, true);
    assert.equal(completed.reachedTarget, true);
    assert.deepEqual(completed.hops, [
      {
        index: 1,
        address: "192.168.1.1",
        hostname: "router.home",
        latencyMs: 3,
        latencySource: "ping",
      },
      {
        index: 2,
        address: null,
        hostname: null,
        latencyMs: null,
        latencySource: null,
      },
      {
        index: 3,
        address: "203.0.113.8",
        hostname: null,
        latencyMs: 15,
        latencySource: "trace",
      },
    ]);
    assert.equal(calls[0]?.file, "tracert.exe");
    assert.deepEqual(calls[0]?.args.slice(-2), ["250", "203.0.113.8"]);
    assert.equal(calls.filter((call) => call.file === "ping.exe").length, 2);

    completed.hops[0].hostname = "mutated.invalid";
    assert.equal(
      service.getProbe("remote_session_01", accepted.taskId)?.hops[0].hostname,
      "router.home",
    );
  } finally {
    service.dispose();
  }
});

test("route probe deduplicates one target and blocks a second concurrent target", async () => {
  let releaseTrace: ((value: RemoteControlRouteProbeCommandResult) => void) | null =
    null;
  const service = new RemoteControlRouteProbeService({
    runCommand: async (file) => {
      if (file === "tracert.exe") {
        return await new Promise<RemoteControlRouteProbeCommandResult>((resolve) => {
          releaseTrace = resolve;
        });
      }
      return { stdout: "", timedOut: false, unavailable: false };
    },
    platform: "win32",
    reverseDns: async () => [],
    createId: () => "route_task_0002",
  });
  try {
    const first = service.createProbe("remote_session_02", "198.51.100.10");
    const duplicate = service.createProbe(
      "remote_session_02",
      "198.51.100.10",
    );
    assert.equal(duplicate.taskId, first.taskId);
    assert.throws(
      () => service.createProbe("remote_session_02", "198.51.100.11"),
      (error: unknown) =>
        error instanceof RemoteControlRouteProbeError &&
        error.httpStatus === 409,
    );
    assert.ok(releaseTrace);
    releaseTrace({
      stdout: "  1  1 ms  1 ms  1 ms  198.51.100.10\n",
      timedOut: false,
      unavailable: false,
    });
    const completed = await waitForRouteProbe(
      service,
      "remote_session_02",
      first.taskId,
    );
    assert.equal(completed.status, "SUCCESS");
  } finally {
    service.dispose();
  }
});
