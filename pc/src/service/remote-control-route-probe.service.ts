import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { reverse } from "node:dns/promises";
import { isIP } from "node:net";

const ROUTE_PROBE_MAX_HOPS = 12;
const ROUTE_PROBE_HOP_WAIT_MS = 250;
const ROUTE_PROBE_COMMAND_TIMEOUT_MS = 11_000;
const ROUTE_PROBE_PING_TIMEOUT_MS = 900;
const ROUTE_PROBE_DNS_TIMEOUT_MS = 800;
const ROUTE_PROBE_RETENTION_MS = 5 * 60 * 1000;
const ROUTE_PROBE_MAX_TASKS = 100;

/** Terminal and running states exposed by one PC-local route probe. */
export type RemoteControlRouteProbeStatus =
  | "EXECUTING"
  | "SUCCESS"
  | "FAILURE"
  | "TIMEOUT";

/** Latency source shown beside one discovered network hop. */
export type RemoteControlRouteProbeLatencySource = "ping" | "trace";

/** One numbered hop returned by the bounded route probe. */
export interface RemoteControlRouteProbeHop {
  index: number;
  address: string | null;
  hostname: string | null;
  latencyMs: number | null;
  latencySource: RemoteControlRouteProbeLatencySource | null;
}

/** Public in-memory state for one asynchronous route probe. */
export interface RemoteControlRouteProbeView {
  taskId: string;
  status: RemoteControlRouteProbeStatus;
  sessionId: string;
  targetAddress: string;
  createdAtUtc: number;
  finishedAtUtc: number | null;
  complete: boolean;
  reachedTarget: boolean;
  hops: RemoteControlRouteProbeHop[];
  code: string | null;
  message: string | null;
}

/** Result of one shell-free operating-system diagnostic command. */
export interface RemoteControlRouteProbeCommandResult {
  stdout: string;
  timedOut: boolean;
  unavailable: boolean;
}

/** Injectable command boundary used by tests without touching the host network. */
export type RemoteControlRouteProbeCommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<RemoteControlRouteProbeCommandResult>;

/** Injectable dependencies for deterministic route-probe tests. */
export interface RemoteControlRouteProbeServiceOptions {
  platform?: NodeJS.Platform;
  runCommand?: RemoteControlRouteProbeCommandRunner;
  reverseDns?: (address: string) => Promise<string[]>;
  now?: () => number;
  createId?: () => string;
}

/** Stable route-probe failure with a controller-safe HTTP status. */
export class RemoteControlRouteProbeError extends Error {
  /**
   * Create one typed route-probe API failure.
   *
   * @param httpStatus HTTP status returned through the standard envelope.
   * @param message Safe public diagnostic.
   */
  constructor(
    readonly httpStatus: 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Internal mutable route-probe task. */
interface StoredRemoteControlRouteProbe extends RemoteControlRouteProbeView {}

/** Minimal trace row before optional DNS and ping enrichment. */
interface ParsedRemoteControlTraceHop {
  index: number;
  address: string | null;
  traceLatencyMs: number | null;
}

/** Executable and arguments selected for the current host. */
interface RemoteControlRouteProbeCommand {
  file: string;
  args: string[];
}

/**
 * Normalize one literal IPv4 or IPv6 address for comparison.
 *
 * @param value Untrusted address value.
 * @returns Canonical literal address, or null for non-IP input.
 */
export function normalizeRemoteControlRouteAddress(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  let address = value.trim();
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  const version = isIP(address);
  if (version === 4) {
    return address
      .split(".")
      .map((part) => String(Number(part)))
      .join(".");
  }
  if (version === 6) {
    try {
      return new URL(`http://[${address}]/`).hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Return whether an IP is a usable unicast device route target.
 *
 * @param value Untrusted address value.
 * @returns Whether the address is safe to probe after session allow-listing.
 */
export function isRemoteControlRouteProbeAddress(value: unknown): boolean {
  const address = normalizeRemoteControlRouteAddress(value);
  if (!address) return false;
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    return (
      octets[0] !== 0 &&
      octets[0] !== 127 &&
      !(octets[0] === 169 && octets[1] === 254) &&
      octets[0] < 224
    );
  }
  const firstHextet = Number.parseInt(address.split(":")[0] || "0", 16);
  return (
    address !== "::" &&
    address !== "::1" &&
    !address.startsWith("::ffff:") &&
    (firstHextet & 0xff00) !== 0xff00 &&
    (firstHextet & 0xffc0) !== 0xfe80
  );
}

/**
 * Extract the connection address from one ICE candidate line.
 *
 * @param candidate Untrusted SDP candidate attribute.
 * @returns Safe canonical unicast address, or null when unavailable.
 */
export function extractRemoteControlIceCandidateAddress(
  candidate: string,
): string | null {
  const line = candidate.trim().replace(/^a=/i, "");
  const fields = line.split(/\s+/);
  if (
    fields.length < 8 ||
    !/^candidate:/i.test(fields[0] || "") ||
    !/^\d+$/.test(fields[1] || "") ||
    !["udp", "tcp"].includes((fields[2] || "").toLowerCase()) ||
    (fields[6] || "").toLowerCase() !== "typ"
  ) {
    return null;
  }
  const address = normalizeRemoteControlRouteAddress(fields[4]);
  return isRemoteControlRouteProbeAddress(address) ? address : null;
}

/**
 * Parse numbered traceroute rows without depending on the operating-system language.
 *
 * @param output Bounded stdout from tracert or traceroute.
 * @returns Ordered trace rows, including non-responsive numbered hops.
 */
export function parseRemoteControlTraceOutput(
  output: string,
): ParsedRemoteControlTraceHop[] {
  const hops = new Map<number, ParsedRemoteControlTraceHop>();
  for (const line of output.split(/\r?\n/)) {
    const row = /^\s*(\d{1,2})\s+(.+)$/.exec(line);
    if (!row) continue;
    const index = Number(row[1]);
    if (index < 1 || index > ROUTE_PROBE_MAX_HOPS || hops.has(index)) continue;
    let address: string | null = null;
    for (const token of row[2].split(/\s+/)) {
      const normalized = normalizeRemoteControlRouteAddress(
        token.replace(/^[\[(]+|[\]),]+$/g, ""),
      );
      if (normalized) address = normalized;
    }
    const samples: number[] = [];
    const latencyPattern = /(<)?\s*(\d+(?:[.,]\d+)?)\s*(?:ms|毫秒)/gi;
    for (const match of row[2].matchAll(latencyPattern)) {
      const numeric = Number(match[2].replace(",", "."));
      if (Number.isFinite(numeric)) samples.push(match[1] ? numeric / 2 : numeric);
    }
    const traceLatencyMs = samples.length
      ? Math.round(
          (samples.reduce((total, sample) => total + sample, 0) /
            samples.length) *
            10,
        ) / 10
      : null;
    hops.set(index, { index, address, traceLatencyMs });
  }
  return [...hops.values()].sort((left, right) => left.index - right.index);
}

/**
 * Parse one successful ping latency from localized command output.
 *
 * @param output Bounded ping stdout.
 * @returns Milliseconds, or null when the node did not answer ping.
 */
export function parseRemoteControlPingLatency(output: string): number | null {
  const match = /(?:time|时间)?\s*([=<])\s*(\d+(?:[.,]\d+)?)\s*(?:ms|毫秒)/i.exec(
    output,
  );
  if (!match) return null;
  const numeric = Number(match[2].replace(",", "."));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round((match[1] === "<" ? numeric / 2 : numeric) * 10) / 10;
}

/**
 * Execute one bounded child process without a command shell.
 *
 * @param file Exact executable name.
 * @param args Individual non-shell arguments.
 * @param timeoutMs Hard process timeout.
 * @returns Captured stdout and sanitized process state.
 */
async function runRemoteControlRouteProbeCommand(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<RemoteControlRouteProbeCommandResult> {
  return await new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 256 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        const processError = error as
          | (NodeJS.ErrnoException & { killed?: boolean })
          | null;
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          timedOut: Boolean(processError?.killed),
          unavailable: processError?.code === "ENOENT",
        });
      },
    );
  });
}

/**
 * Resolve a promise to a fallback when its bounded wait expires.
 *
 * @param promise Operation to bound.
 * @param timeoutMs Maximum wait duration.
 * @param fallback Value returned on timeout or rejection.
 * @returns Operation result or the supplied fallback.
 */
async function resolveRemoteControlProbeWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Manage short-lived, PC-local traceroute, reverse-DNS, and ping tasks. */
export class RemoteControlRouteProbeService {
  private static instance: RemoteControlRouteProbeService | undefined;
  private readonly tasks = new Map<string, StoredRemoteControlRouteProbe>();
  private readonly activeTaskBySession = new Map<
    string,
    StoredRemoteControlRouteProbe
  >();
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: RemoteControlRouteProbeCommandRunner;
  private readonly reverseDns: (address: string) => Promise<string[]>;
  private readonly now: () => number;
  private readonly createId: () => string;

  /**
   * Create one isolated route-probe service.
   *
   * @param options Optional host and deterministic test dependencies.
   */
  constructor(options: RemoteControlRouteProbeServiceOptions = {}) {
    this.platform = options.platform || process.platform;
    this.runCommand = options.runCommand || runRemoteControlRouteProbeCommand;
    this.reverseDns = options.reverseDns || reverse;
    this.now = options.now || Date.now;
    this.createId = options.createId || randomUUID;
  }

  /**
   * Return the process-wide route-probe service.
   *
   * @returns Singleton route-probe service.
   */
  static getInstance(): RemoteControlRouteProbeService {
    if (!this.instance) this.instance = new RemoteControlRouteProbeService();
    return this.instance;
  }

  /**
   * Create an asynchronous probe or reuse the identical running request.
   *
   * @param sessionId Active remote-control session identifier.
   * @param targetAddress Already authorized device ICE address.
   * @returns Immediate EXECUTING task view.
   */
  createProbe(
    sessionId: string,
    targetAddress: string,
  ): RemoteControlRouteProbeView {
    this.cleanup();
    const address = normalizeRemoteControlRouteAddress(targetAddress);
    if (!address || !isRemoteControlRouteProbeAddress(address)) {
      throw new RemoteControlRouteProbeError(
        409,
        "The route target is unavailable for this session",
      );
    }
    const active = this.activeTaskBySession.get(sessionId);
    if (active?.status === "EXECUTING") {
      if (active.targetAddress === address) return this.view(active);
      throw new RemoteControlRouteProbeError(
        409,
        "Another route probe is already running for this session",
      );
    }
    if (this.tasks.size >= ROUTE_PROBE_MAX_TASKS) {
      throw new RemoteControlRouteProbeError(
        503,
        "Route-probe capacity is temporarily full",
      );
    }
    const task: StoredRemoteControlRouteProbe = {
      taskId: this.createId(),
      status: "EXECUTING",
      sessionId,
      targetAddress: address,
      createdAtUtc: this.now(),
      finishedAtUtc: null,
      complete: false,
      reachedTarget: false,
      hops: [],
      code: null,
      message: null,
    };
    this.tasks.set(task.taskId, task);
    this.activeTaskBySession.set(sessionId, task);
    void this.execute(task);
    return this.view(task);
  }

  /**
   * Return one task only when it belongs to the requested session.
   *
   * @param sessionId Owning remote-control session identifier.
   * @param taskId Route-probe task identifier.
   * @returns Detached task view, or null when missing or unrelated.
   */
  getProbe(
    sessionId: string,
    taskId: string,
  ): RemoteControlRouteProbeView | null {
    this.cleanup();
    const task = this.tasks.get(taskId);
    return task?.sessionId === sessionId ? this.view(task) : null;
  }

  /**
   * Drop retained task data from an isolated service instance.
   *
   * @returns Nothing.
   */
  dispose(): void {
    this.tasks.clear();
    this.activeTaskBySession.clear();
  }

  /**
   * Run one bounded trace and enrich responding hops with DNS and ping.
   *
   * @param task Mutable task being completed.
   * @returns Promise resolved after terminal state is stored.
   */
  private async execute(task: StoredRemoteControlRouteProbe): Promise<void> {
    try {
      const command = this.traceCommand(task.targetAddress);
      const result = await this.runCommand(
        command.file,
        command.args,
        ROUTE_PROBE_COMMAND_TIMEOUT_MS,
      );
      if (result.unavailable) {
        task.status = "FAILURE";
        task.code = "ROUTE_TRACE_UNAVAILABLE";
        task.message = "This PC cannot run route diagnostics";
        return;
      }
      const parsed = parseRemoteControlTraceOutput(result.stdout);
      task.hops = await this.enrichHops(parsed);
      task.reachedTarget = task.hops.some(
        (hop) => hop.address === task.targetAddress,
      );
      task.complete = !result.timedOut;
      if (result.timedOut) {
        task.status = "TIMEOUT";
        task.code = "ROUTE_TRACE_TIMEOUT";
        task.message = "Route diagnostics stopped after the safe time limit";
      } else if (task.hops.length === 0) {
        task.status = "FAILURE";
        task.code = "ROUTE_TRACE_EMPTY";
        task.message = "No route hops were returned by this PC";
      } else {
        task.status = "SUCCESS";
        task.message = "Route diagnostics completed";
      }
    } catch {
      task.status = "FAILURE";
      task.code = "ROUTE_TRACE_FAILED";
      task.message = "Route diagnostics failed on this PC";
    } finally {
      task.finishedAtUtc = this.now();
      if (this.activeTaskBySession.get(task.sessionId) === task) {
        this.activeTaskBySession.delete(task.sessionId);
      }
    }
  }

  /**
   * Add bounded reverse-DNS and ping information in small process batches.
   *
   * @param parsed Numbered trace rows.
   * @returns Enriched rows in their original hop order.
   */
  private async enrichHops(
    parsed: ParsedRemoteControlTraceHop[],
  ): Promise<RemoteControlRouteProbeHop[]> {
    const enriched: RemoteControlRouteProbeHop[] = [];
    for (let offset = 0; offset < parsed.length; offset += 4) {
      const batch = parsed.slice(offset, offset + 4);
      enriched.push(...(await Promise.all(batch.map((hop) => this.enrichHop(hop)))));
    }
    return enriched;
  }

  /**
   * Enrich one responding trace row without failing the overall probe.
   *
   * @param hop Parsed trace row.
   * @returns Public hop with optional hostname and latency.
   */
  private async enrichHop(
    hop: ParsedRemoteControlTraceHop,
  ): Promise<RemoteControlRouteProbeHop> {
    if (!hop.address) {
      return {
        index: hop.index,
        address: null,
        hostname: null,
        latencyMs: null,
        latencySource: null,
      };
    }
    const [hostnames, pingLatencyMs] = await Promise.all([
      resolveRemoteControlProbeWithTimeout(
        this.reverseDns(hop.address),
        ROUTE_PROBE_DNS_TIMEOUT_MS,
        [],
      ),
      this.ping(hop.address),
    ]);
    const hostname = hostnames.find(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 253 &&
        !/[\u0000-\u001f\u007f]/.test(value),
    );
    return {
      index: hop.index,
      address: hop.address,
      hostname: hostname || null,
      latencyMs: pingLatencyMs ?? hop.traceLatencyMs,
      latencySource:
        pingLatencyMs !== null
          ? "ping"
          : hop.traceLatencyMs !== null
            ? "trace"
            : null,
    };
  }

  /**
   * Ping one discovered hop once, returning null when ICMP is blocked.
   *
   * @param address Canonical responding hop address.
   * @returns Ping latency in milliseconds, or null.
   */
  private async ping(address: string): Promise<number | null> {
    const command = this.pingCommand(address);
    const result = await this.runCommand(
      command.file,
      command.args,
      ROUTE_PROBE_PING_TIMEOUT_MS,
    );
    if (result.unavailable || result.timedOut) return null;
    return parseRemoteControlPingLatency(result.stdout);
  }

  /**
   * Select a no-DNS traceroute command for the current host.
   *
   * @param address Canonical device address.
   * @returns Executable and bounded arguments.
   */
  private traceCommand(address: string): RemoteControlRouteProbeCommand {
    if (this.platform === "win32") {
      return {
        file: "tracert.exe",
        args: [
          isIP(address) === 6 ? "-6" : "-4",
          "-d",
          "-h",
          String(ROUTE_PROBE_MAX_HOPS),
          "-w",
          String(ROUTE_PROBE_HOP_WAIT_MS),
          address,
        ],
      };
    }
    return {
      file: "traceroute",
      args: [
        isIP(address) === 6 ? "-6" : "-4",
        "-n",
        "-m",
        String(ROUTE_PROBE_MAX_HOPS),
        "-w",
        "1",
        address,
      ],
    };
  }

  /**
   * Select one single-packet ping command for the current host.
   *
   * @param address Canonical discovered hop address.
   * @returns Executable and bounded arguments.
   */
  private pingCommand(address: string): RemoteControlRouteProbeCommand {
    if (this.platform === "win32") {
      return {
        file: "ping.exe",
        args: [
          isIP(address) === 6 ? "-6" : "-4",
          "-n",
          "1",
          "-w",
          "700",
          address,
        ],
      };
    }
    return {
      file: "ping",
      args: [
        isIP(address) === 6 ? "-6" : "-4",
        "-n",
        "-c",
        "1",
        "-W",
        "1",
        address,
      ],
    };
  }

  /**
   * Remove expired terminal tasks and preserve a strict capacity bound.
   *
   * @returns Nothing.
   */
  private cleanup(): void {
    const cutoff = this.now() - ROUTE_PROBE_RETENTION_MS;
    for (const [taskId, task] of this.tasks) {
      if (task.finishedAtUtc !== null && task.finishedAtUtc < cutoff) {
        this.tasks.delete(taskId);
      }
    }
  }

  /**
   * Detach a task before exposing it through the controller.
   *
   * @param task Stored mutable task.
   * @returns Safe cloned route-probe view.
   */
  private view(
    task: StoredRemoteControlRouteProbe,
  ): RemoteControlRouteProbeView {
    return {
      taskId: task.taskId,
      status: task.status,
      sessionId: task.sessionId,
      targetAddress: task.targetAddress,
      createdAtUtc: task.createdAtUtc,
      finishedAtUtc: task.finishedAtUtc,
      complete: task.complete,
      reachedTarget: task.reachedTarget,
      hops: task.hops.map((hop) => ({ ...hop })),
      code: task.code,
      message: task.message,
    };
  }
}
