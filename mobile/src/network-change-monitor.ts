import { spawn } from "child_process";
import { EventEmitter } from "events";

interface MonitorProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface AndroidNetworkChangeMonitorOptions {
  debounceMs?: number;
  restartDelayMs?: number;
  createProcess?: () => MonitorProcess;
  onWarning?: (message: string, error?: unknown) => void;
}

function createIpMonitorProcess(): MonitorProcess {
  return spawn("su", ["-c", "exec ip monitor link address route"], {
    stdio: ["ignore", "pipe", "pipe"],
  }) as MonitorProcess;
}

/**
 * Watches Android netlink changes and coalesces noisy link/address/route events
 * into one routing reconciliation. The periodic health check remains the
 * fallback when ip monitor is unavailable.
 */
export class AndroidNetworkChangeMonitor {
  private readonly debounceMs: number;
  private readonly restartDelayMs: number;
  private readonly createProcess: () => MonitorProcess;
  private readonly onWarning: (message: string, error?: unknown) => void;
  private child: MonitorProcess | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly onNetworkChange: () => Promise<void>,
    options: AndroidNetworkChangeMonitorOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 2_000;
    this.restartDelayMs = options.restartDelayMs ?? 5_000;
    this.createProcess = options.createProcess ?? createIpMonitorProcess;
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.debounceTimer = null;
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    child?.kill("SIGTERM");
  }

  private launch(): void {
    if (this.stopped || this.child) return;
    let child: MonitorProcess;
    try {
      child = this.createProcess();
    } catch (error) {
      this.onWarning("Failed to start Android network monitor", error);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    let completed = false;
    const complete = (error?: unknown) => {
      if (completed) return;
      completed = true;
      if (this.child === child) this.child = null;
      if (!this.stopped && error)
        this.onWarning("Android network monitor stopped", error);
      this.scheduleRestart();
    };
    child.stdout.on("data", (chunk: unknown) => {
      if (String(chunk).trim()) this.scheduleReconcile();
    });
    child.stderr.on("data", (chunk: unknown) => {
      const message = String(chunk).trim();
      if (message) this.onWarning(`Android network monitor: ${message}`);
    });
    child.once("error", complete);
    child.once("exit", (code, signal) =>
      complete(
        code === 0 || signal === "SIGTERM"
          ? undefined
          : new Error(`ip monitor exited code=${code} signal=${signal}`),
      ),
    );
  }

  private scheduleReconcile(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.onNetworkChange().catch((error) =>
        this.onWarning("Network change reconciliation failed", error),
      );
    }, this.debounceMs);
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, this.restartDelayMs);
  }
}
