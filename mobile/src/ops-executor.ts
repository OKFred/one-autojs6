import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  DEVICE_OPS,
  DeviceOpsFailure,
  type DeviceOpsOperation,
} from "./ops-protocol.js";
import { isRecord } from "./protocol.js";

const execFileAsync = promisify(execFile);

/** Android audio streams supported by the fixed operation catalog. */
export const AUDIO_STREAMS = {
  voiceCall: 0,
  system: 1,
  ring: 2,
  media: 3,
  alarm: 4,
  notification: 5,
  bluetoothSco: 6,
  dtmf: 8,
  accessibility: 10,
} as const;

/** Supported audio stream name. */
export type AudioStreamName = keyof typeof AUDIO_STREAMS;

/** An allowlisted directory exposed through a stable identifier. */
export interface DeviceOpsFileRoot {
  id: string;
  path: string;
  label: string;
}

/** Dependencies used by the structured operation executor. */
export interface DeviceOpsExecutorOptions {
  fileRoots: DeviceOpsFileRoot[];
  sharedStateDirectory: string;
  runRootCommand?: (command: string) => Promise<string>;
  now?: () => number;
}

/** Execute one fixed root command and capture bounded output. */
async function defaultRootCommand(command: string): Promise<string> {
  const { stdout } = await execFileAsync("su", ["-c", command], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return String(stdout).trim();
}

/** Return true when a candidate path is inside a root path. */
function pathWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Parse a supported audio stream name. */
function audioStream(params: Record<string, unknown>): AudioStreamName {
  const value = params.stream;
  if (typeof value === "string" && value in AUDIO_STREAMS) {
    return value as AudioStreamName;
  }
  throw new DeviceOpsFailure(
    "AUDIO_STREAM_UNSUPPORTED",
    "The requested Android audio stream is not supported",
    "REJECTED",
  );
}

/** Parse Android media-session volume output. */
export function parseVolumeOutput(output: string): {
  current: number;
  minimum: number;
  maximum: number;
} {
  const matched = /volume is\s+(\d+)\s+in range\s+\[(\d+)\.\.(\d+)\]/i.exec(
    output,
  );
  if (!matched) {
    throw new DeviceOpsFailure(
      "AUDIO_STREAM_UNSUPPORTED",
      "Android did not expose volume information for this stream",
    );
  }
  return {
    current: Number(matched[1]),
    minimum: Number(matched[2]),
    maximum: Number(matched[3]),
  };
}

/** Select Android's active default NetworkAgentInfo row from connectivity dump. */
export function findActiveNetworkLine(connectivity: string): string {
  const lines = connectivity.split("\n");
  const activeNetworkId = /^Active default network:\s*(\d+)\s*$/m.exec(
    connectivity,
  )?.[1];
  if (activeNetworkId) {
    const activeLine = lines.find((line) =>
      line.includes(`NetworkAgentInfo{network{${activeNetworkId}}`),
    );
    if (activeLine) return activeLine;
  }
  return (
    lines.find(
      (line) =>
        /NetworkAgentInfo.*ni\{(?:WIFI|MOBILE|ETHERNET|VPN)[^}]*CONNECTED/.test(
          line,
        ) && /(?:VALIDATED|IS_VALIDATED)/.test(line),
    ) ||
    lines.find((line) =>
      /NetworkAgentInfo.*ni\{(?:WIFI|MOBILE|ETHERNET|VPN)[^}]*CONNECTED/.test(
        line,
      ),
    ) ||
    ""
  );
}

/** Execute the fixed, non-shell maintenance operation catalog. */
export class DeviceOpsExecutor {
  private readonly roots = new Map<string, DeviceOpsFileRoot>();
  private readonly runRootCommand: (command: string) => Promise<string>;
  private readonly now: () => number;
  private readonly audioStatePath: string;

  /** Create a structured device operation executor. */
  constructor(options: DeviceOpsExecutorOptions) {
    for (const root of options.fileRoots) {
      if (!/^[a-z0-9-]{1,40}$/.test(root.id)) {
        throw new Error(`Invalid ops file root id: ${root.id}`);
      }
      this.roots.set(root.id, { ...root, path: path.resolve(root.path) });
    }
    this.runRootCommand = options.runRootCommand || defaultRootCommand;
    this.now = options.now || Date.now;
    this.audioStatePath = path.join(
      options.sharedStateDirectory,
      "ops-audio-state.json",
    );
  }

  /** Return the fixed capability catalog and configured roots. */
  private capabilities(): Record<string, unknown> {
    return {
      protocolVersion: 1,
      operations: [...DEVICE_OPS],
      audioStreams: Object.keys(AUDIO_STREAMS),
      fileRoots: [...this.roots.values()].map(({ id, label }) => ({
        id,
        label,
      })),
      arbitraryShell: false,
    };
  }

  /** Resolve an allowlisted path and reject traversal and escaping symlinks. */
  private resolveFilePath(rootId: string, relativePath: string): string {
    const root = this.roots.get(rootId);
    if (!root) {
      throw new DeviceOpsFailure(
        "FILE_ROOT_NOT_ALLOWED",
        "The requested file root is not available",
        "REJECTED",
      );
    }
    if (
      relativePath.includes("\0") ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]+/).includes("..")
    ) {
      throw new DeviceOpsFailure(
        "FILE_PATH_UNSAFE",
        "The requested path is not safe",
        "REJECTED",
      );
    }
    try {
      const canonicalRoot = fs.realpathSync(root.path);
      const candidate = fs.realpathSync(
        path.resolve(root.path, relativePath || "."),
      );
      if (!pathWithin(canonicalRoot, candidate)) {
        throw new DeviceOpsFailure(
          "FILE_PATH_UNSAFE",
          "The requested path escapes its configured root",
          "REJECTED",
        );
      }
      return candidate;
    } catch (error) {
      if (error instanceof DeviceOpsFailure) throw error;
      throw new DeviceOpsFailure(
        "FILE_NOT_FOUND",
        "The requested path was not found",
      );
    }
  }

  /** Read persisted pre-mute volume levels. */
  private readAudioState(): Partial<Record<AudioStreamName, number>> {
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(this.audioStatePath, "utf8"),
      );
      if (!isRecord(value)) return {};
      return Object.fromEntries(
        Object.entries(value).filter(
          ([key, item]) => key in AUDIO_STREAMS && Number.isInteger(item),
        ),
      ) as Partial<Record<AudioStreamName, number>>;
    } catch {
      return {};
    }
  }

  /** Atomically persist pre-mute volume levels with private permissions. */
  private writeAudioState(
    value: Partial<Record<AudioStreamName, number>>,
  ): void {
    fs.mkdirSync(path.dirname(this.audioStatePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporaryPath = `${this.audioStatePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, this.audioStatePath);
  }

  /** Read one Android audio stream without accepting a remote command string. */
  private async getAudioStream(stream: AudioStreamName): Promise<object> {
    const volume = parseVolumeOutput(
      await this.runRootCommand(
        `cmd media_session volume --stream ${AUDIO_STREAMS[stream]} --get`,
      ),
    );
    return { stream, ...volume, muted: volume.current === 0 };
  }

  /** Set one validated Android audio stream level. */
  private async setAudioStream(
    stream: AudioStreamName,
    requestedLevel: unknown,
  ): Promise<object> {
    const previous = parseVolumeOutput(
      await this.runRootCommand(
        `cmd media_session volume --stream ${AUDIO_STREAMS[stream]} --get`,
      ),
    );
    if (!Number.isInteger(requestedLevel)) {
      throw new DeviceOpsFailure(
        "AUDIO_LEVEL_INVALID",
        "Audio level must be an integer",
        "REJECTED",
      );
    }
    const level = requestedLevel as number;
    if (level < previous.minimum || level > previous.maximum) {
      throw new DeviceOpsFailure(
        "AUDIO_LEVEL_OUT_OF_RANGE",
        "Audio level is outside the stream range",
        "REJECTED",
      );
    }
    await this.runRootCommand(
      `cmd media_session volume --stream ${AUDIO_STREAMS[stream]} --set ${level}`,
    );
    return {
      stream,
      previous: previous.current,
      current: level,
      minimum: previous.minimum,
      maximum: previous.maximum,
      muted: level === 0,
    };
  }

  /** Execute one validated operation. */
  async execute(
    operation: DeviceOpsOperation,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (operation === "device.ops.capabilities") return this.capabilities();
    if (operation === "device.audio.get") {
      if (typeof params.stream === "string" && params.stream !== "all") {
        return this.getAudioStream(audioStream(params));
      }
      return {
        streams: await Promise.all(
          (Object.keys(AUDIO_STREAMS) as AudioStreamName[]).map(
            async (stream) => {
              try {
                return {
                  supported: true,
                  ...(await this.getAudioStream(stream)),
                };
              } catch (error) {
                return {
                  stream,
                  supported: false,
                  code:
                    error instanceof DeviceOpsFailure
                      ? error.code
                      : "AUDIO_QUERY_FAILED",
                };
              }
            },
          ),
        ),
      };
    }
    if (operation === "device.audio.set") {
      return this.setAudioStream(audioStream(params), params.level);
    }
    if (operation === "device.audio.mute") {
      const stream = audioStream(params);
      const current = (await this.getAudioStream(stream)) as {
        current: number;
      };
      if (current.current > 0) {
        const state = this.readAudioState();
        state[stream] = current.current;
        this.writeAudioState(state);
      }
      return this.setAudioStream(stream, 0);
    }
    if (operation === "device.audio.unmute") {
      const stream = audioStream(params);
      const current = parseVolumeOutput(
        await this.runRootCommand(
          `cmd media_session volume --stream ${AUDIO_STREAMS[stream]} --get`,
        ),
      );
      const state = this.readAudioState();
      const restored = Math.max(
        1,
        Math.min(
          current.maximum,
          state[stream] ?? Math.round(current.maximum * 0.5),
        ),
      );
      delete state[stream];
      this.writeAudioState(state);
      return this.setAudioStream(stream, restored);
    }
    if (operation === "device.files.list") {
      const rootId = typeof params.rootId === "string" ? params.rootId : "";
      const relativePath = typeof params.path === "string" ? params.path : "";
      const directory = this.resolveFilePath(rootId, relativePath);
      if (!fs.statSync(directory).isDirectory()) {
        throw new DeviceOpsFailure(
          "FILE_NOT_DIRECTORY",
          "The requested path is not a directory",
        );
      }
      const pageSize = Math.max(
        1,
        Math.min(
          200,
          Number.isInteger(params.pageSize) ? (params.pageSize as number) : 100,
        ),
      );
      const cursor = typeof params.cursor === "string" ? params.cursor : "";
      const offset = /^\d+$/.test(cursor) ? Number(cursor) : 0;
      const names = fs
        .readdirSync(directory)
        .sort((a, b) => a.localeCompare(b));
      const entries = names.slice(offset, offset + pageSize).map((name) => {
        const stat = fs.lstatSync(path.join(directory, name));
        return {
          name,
          type: stat.isSymbolicLink()
            ? "symlink"
            : stat.isDirectory()
              ? "directory"
              : stat.isFile()
                ? "file"
                : "other",
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        };
      });
      return {
        rootId,
        path: relativePath,
        entries,
        nextCursor:
          offset + entries.length < names.length
            ? String(offset + entries.length)
            : null,
      };
    }
    if (operation === "device.storage.stat") {
      const rootId = typeof params.rootId === "string" ? params.rootId : "";
      const stat = await fs.promises.statfs(this.resolveFilePath(rootId, ""));
      const totalBytes = stat.blocks * stat.bsize;
      const freeBytes = stat.bfree * stat.bsize;
      return {
        rootId,
        totalBytes,
        usedBytes: totalBytes - freeBytes,
        freeBytes,
        availableBytes: stat.bavail * stat.bsize,
      };
    }
    if (operation === "device.foreground.get") {
      const [activity, windows] = await Promise.all([
        this.runRootCommand("dumpsys activity activities"),
        this.runRootCommand("dumpsys window windows"),
      ]);
      const resumed =
        /(?:topResumedActivity=|ResumedActivity:\s+)ActivityRecord\{[^}]*\su\d+\s+([A-Za-z0-9._]+)\/([^\s}]+)/.exec(
          activity,
        ) ||
        /mResumedActivity:.*?\s([A-Za-z0-9._]+)\/([^\s}]+)/.exec(
          activity,
        );
      const focused = /mCurrentFocus=.*?\s([A-Za-z0-9._]+)\/([^\s}]+)/.exec(
        windows,
      );
      return {
        packageName: resumed?.[1] || focused?.[1] || null,
        activityClass: resumed?.[2] || focused?.[2] || null,
        windowTitle:
          /mCurrentFocus=Window\{[^}]*\s([^}]+)\}/.exec(windows)?.[1] || null,
        capturedAt: this.now(),
      };
    }
    if (operation === "device.network.get") {
      const [connectivity, addresses, routes, dns, wifi] = await Promise.all([
        this.runRootCommand("dumpsys connectivity"),
        this.runRootCommand("ip -o addr show"),
        this.runRootCommand("ip route show"),
        this.runRootCommand("getprop"),
        this.runRootCommand("cmd wifi status"),
      ]);
      const activeNetwork = findActiveNetworkLine(connectivity);
      const transport =
        /ni\{(WIFI|MOBILE|ETHERNET|VPN)[^}]*CONNECTED/.exec(
          activeNetwork || "",
        )?.[1] ||
        /TRANSPORT_(WIFI|CELLULAR|ETHERNET|VPN)/.exec(connectivity)?.[1];
      const dnsAddresses = /DnsAddresses:\s*\[([^\]]*)\]/.exec(
        activeNetwork || "",
      )?.[1];
      const dnsServers = dnsAddresses
        ? dnsAddresses
            .split(",")
            .map((value) => value.trim().replace(/^\//, ""))
            .filter(Boolean)
        : [
            ...dns.matchAll(/\[net\.dns\d+\]: \[([^\]]+)\]/g),
          ].map((match) => match[1]);
      const wifiSsid = /(?:mWifiInfo|WifiInfo):?.*?SSID:\s*([^,\n]+)/.exec(
        wifi,
      )?.[1];
      const wifiBssid = /(?:mWifiInfo|WifiInfo):?.*?BSSID:\s*([^,\n]+)/.exec(
        wifi,
      )?.[1];
      return {
        activeTransport:
          transport === "MOBILE"
            ? "cellular"
            : transport?.toLowerCase() || "unknown",
        validated: /VALIDATED/.test(activeNetwork || ""),
        vpn: transport === "VPN",
        interfaces: addresses.split("\n").filter(Boolean).slice(0, 100),
        routes: routes.split("\n").filter(Boolean).slice(0, 100),
        dnsServers,
        wifiSsid: wifiSsid?.replace(/^"|"$/g, "") || null,
        wifiBssid: wifiBssid?.replace(/^"|"$/g, "") || null,
      };
    }
    throw new DeviceOpsFailure(
      "OPERATION_NOT_ALLOWED",
      "The requested operation is not in the trusted catalog",
      "REJECTED",
    );
  }
}
