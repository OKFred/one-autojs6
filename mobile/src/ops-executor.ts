import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildTelephonySnapshot,
  parseNetworkInterfaces,
  parseTelephonyRegistry,
  parseWifiStatus,
} from "./android-diagnostics.js";
import {
  DEVICE_OPS,
  DeviceOpsFailure,
  OPS_MAX_ARTIFACT_BYTES,
  type DeviceOpsArtifact,
  type DeviceOpsOperation,
} from "./ops-protocol.js";
import { isRecord } from "./protocol.js";
import {
  OPS_MAX_UI_DEPTH,
  OPS_MAX_UI_HIERARCHY_BYTES,
  OPS_MAX_UI_NODES,
  OPS_MAX_UI_TEXT_LENGTH,
  resolveUiTargetAt,
  type DeviceUiTargetAtParams,
  type DeviceUiTargetAtResult,
} from "./ui-target.js";

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

/** Lowest remotely selectable brightness, avoiding an effectively black screen. */
export const OPS_MIN_BRIGHTNESS = 1;

/** Highest Android system brightness level accepted by this operation. */
export const OPS_MAX_BRIGHTNESS = 255;

/** Maximum duration of one find-device vibration. */
export const OPS_MAX_FIND_DEVICE_DURATION_MS = 5_000;

/** Minimum duration of one find-device vibration. */
export const OPS_MIN_FIND_DEVICE_DURATION_MS = 500;

/** Structured Android screen brightness state. */
export interface AndroidBrightnessSnapshot {
  level: number;
  percent: number;
  mode: "manual" | "automatic" | "unknown";
}

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
  runRootBinaryCommand?: (command: string) => Promise<Buffer>;
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

/** Execute one fixed root command and capture bounded binary output. */
async function defaultRootBinaryCommand(command: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "su",
      ["-c", command],
      {
        encoding: null,
        timeout: 10_000,
        maxBuffer: OPS_MAX_ARTIFACT_BYTES + 1,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(Buffer.from(stdout));
      },
    );
  });
}

/** Read and validate the fixed PNG metadata needed by the artifact envelope. */
export function parseScreenshotPng(content: Buffer): {
  width: number;
  height: number;
} {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (
    content.byteLength < 24 ||
    !content.subarray(0, signature.byteLength).equals(signature) ||
    content.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new DeviceOpsFailure(
      "SCREENSHOT_FORMAT_INVALID",
      "Android returned an invalid PNG screenshot",
    );
  }
  const width = content.readUInt32BE(16);
  const height = content.readUInt32BE(20);
  if (width <= 0 || height <= 0 || width > 16_384 || height > 16_384) {
    throw new DeviceOpsFailure(
      "SCREENSHOT_FORMAT_INVALID",
      "Android returned invalid screenshot dimensions",
    );
  }
  return { width, height };
}

/** Return true when a candidate path is inside a root path. */
function pathWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Reject parameters that are not declared by a fixed operation. */
function validateParamKeys(
  params: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const unknownKeys = Object.keys(params).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new DeviceOpsFailure(
      "OPERATION_PARAMS_INVALID",
      "The operation includes unsupported parameters",
      "REJECTED",
    );
  }
}

/** Parse Android system brightness settings into a bounded snapshot. */
export function parseBrightnessSettings(
  levelOutput: string,
  modeOutput: string,
): AndroidBrightnessSnapshot {
  const level = Number(levelOutput.trim());
  if (!Number.isInteger(level) || level < 0 || level > OPS_MAX_BRIGHTNESS) {
    throw new DeviceOpsFailure(
      "BRIGHTNESS_QUERY_FAILED",
      "Android returned an invalid screen brightness level",
    );
  }
  const modeValue = modeOutput.trim();
  return {
    level,
    percent: Math.round((level / OPS_MAX_BRIGHTNESS) * 100),
    mode:
      modeValue === "0"
        ? "manual"
        : modeValue === "1"
          ? "automatic"
          : "unknown",
  };
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
  private readonly runRootBinaryCommand: (command: string) => Promise<Buffer>;
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
    this.runRootBinaryCommand =
      options.runRootBinaryCommand || defaultRootBinaryCommand;
    this.now = options.now || Date.now;
    this.audioStatePath = path.join(
      options.sharedStateDirectory,
      "ops-audio-state.json",
    );
  }

  /** Return the fixed capability catalog and configured roots. */
  getCapabilities(): Record<string, unknown> {
    return {
      protocolVersion: 1,
      operations: [...DEVICE_OPS],
      audioStreams: Object.keys(AUDIO_STREAMS),
      fileRoots: [...this.roots.values()].map(({ id, label }) => ({
        id,
        label,
      })),
      artifacts: {
        screenshot: {
          mimeTypes: ["image/png"],
          maxBytes: OPS_MAX_ARTIFACT_BYTES,
        },
      },
      screenBrightness: {
        minimum: OPS_MIN_BRIGHTNESS,
        maximum: OPS_MAX_BRIGHTNESS,
        modes: ["manual", "automatic"],
      },
      telephony: {
        sanitized: true,
        phoneNumber: "availability-and-masked-last-four",
        excludedIdentifiers: ["IMSI", "ICCID", "IMEI"],
        rawDiagnostics: false,
      },
      uiTargetAt: {
        source: "android-uiautomator",
        returnsHierarchy: false,
        maxHierarchyBytes: OPS_MAX_UI_HIERARCHY_BYTES,
        maxNodes: OPS_MAX_UI_NODES,
        maxDepth: OPS_MAX_UI_DEPTH,
        maxTextLength: OPS_MAX_UI_TEXT_LENGTH,
        textModes: ["literal", "parameter", "redacted"],
      },
      findDevice: {
        methods: ["notification", "vibration"],
        minimumDurationMs: OPS_MIN_FIND_DEVICE_DURATION_MS,
        maximumDurationMs: OPS_MAX_FIND_DEVICE_DURATION_MS,
        audible: false,
        audibleReason: "NO_RELIABLE_AUDIO_BACKEND",
        changesDoNotDisturb: false,
      },
      arbitraryShell: false,
    };
  }

  /** Run an optional diagnostic command without exposing its failure text. */
  private async optionalRootCommand(command: string): Promise<string> {
    try {
      return await this.runRootCommand(command);
    } catch {
      return "";
    }
  }

  /** Read the Android system brightness level and mode. */
  private async getBrightness(): Promise<AndroidBrightnessSnapshot> {
    try {
      const [level, mode] = await Promise.all([
        this.runRootCommand("settings get system screen_brightness"),
        this.runRootCommand("settings get system screen_brightness_mode"),
      ]);
      return parseBrightnessSettings(level, mode);
    } catch (error) {
      if (error instanceof DeviceOpsFailure) throw error;
      throw new DeviceOpsFailure(
        "BRIGHTNESS_QUERY_FAILED",
        "Android screen brightness query failed",
      );
    }
  }

  /** Apply validated brightness changes and restore prior values on failure. */
  private async setBrightness(
    params: Record<string, unknown>,
  ): Promise<{
    previous: AndroidBrightnessSnapshot;
    current: AndroidBrightnessSnapshot;
  }> {
    validateParamKeys(params, ["level", "mode"]);
    const hasLevel = Object.prototype.hasOwnProperty.call(params, "level");
    const hasMode = Object.prototype.hasOwnProperty.call(params, "mode");
    if (!hasLevel && !hasMode) {
      throw new DeviceOpsFailure(
        "BRIGHTNESS_PARAMS_REQUIRED",
        "Brightness level or mode is required",
        "REJECTED",
      );
    }
    if (
      hasLevel &&
      (!Number.isInteger(params.level) ||
        (params.level as number) < OPS_MIN_BRIGHTNESS ||
        (params.level as number) > OPS_MAX_BRIGHTNESS)
    ) {
      throw new DeviceOpsFailure(
        "BRIGHTNESS_LEVEL_OUT_OF_RANGE",
        `Brightness level must be an integer from ${OPS_MIN_BRIGHTNESS} to ${OPS_MAX_BRIGHTNESS}`,
        "REJECTED",
      );
    }
    if (
      hasMode &&
      params.mode !== "manual" &&
      params.mode !== "automatic"
    ) {
      throw new DeviceOpsFailure(
        "BRIGHTNESS_MODE_INVALID",
        "Brightness mode must be manual or automatic",
        "REJECTED",
      );
    }
    const previous = await this.getBrightness();
    if (hasMode && previous.mode === "unknown") {
      throw new DeviceOpsFailure(
        "BRIGHTNESS_MODE_UNAVAILABLE",
        "Android did not expose a restorable brightness mode",
      );
    }
    const desiredLevel = hasLevel ? (params.level as number) : previous.level;
    const desiredMode = hasMode
      ? (params.mode as "manual" | "automatic")
      : previous.mode;
    let modeAttempted = false;
    let levelAttempted = false;
    try {
      if (hasMode && desiredMode !== previous.mode) {
        modeAttempted = true;
        await this.runRootCommand(
          `settings put system screen_brightness_mode ${desiredMode === "automatic" ? 1 : 0}`,
        );
      }
      if (hasLevel && desiredLevel !== previous.level) {
        levelAttempted = true;
        await this.runRootCommand(
          `settings put system screen_brightness ${desiredLevel}`,
        );
      }
      return { previous, current: await this.getBrightness() };
    } catch {
      if (levelAttempted) {
        await this.runRootCommand(
          `settings put system screen_brightness ${previous.level}`,
        ).catch(() => undefined);
      }
      if (modeAttempted) {
        await this.runRootCommand(
          `settings put system screen_brightness_mode ${previous.mode === "automatic" ? 1 : 0}`,
        ).catch(() => undefined);
      }
      throw new DeviceOpsFailure(
        "BRIGHTNESS_SET_FAILED",
        "Android screen brightness update failed",
      );
    }
  }

  /** Post a visible notice and issue one bounded vibration without changing DND. */
  private async findDeviceAlert(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    validateParamKeys(params, ["durationMs"]);
    const durationMs = Object.prototype.hasOwnProperty.call(
      params,
      "durationMs",
    )
      ? params.durationMs
      : 2_000;
    if (
      !Number.isInteger(durationMs) ||
      (durationMs as number) < OPS_MIN_FIND_DEVICE_DURATION_MS ||
      (durationMs as number) > OPS_MAX_FIND_DEVICE_DURATION_MS
    ) {
      throw new DeviceOpsFailure(
        "FIND_DEVICE_DURATION_OUT_OF_RANGE",
        `Find-device duration must be an integer from ${OPS_MIN_FIND_DEVICE_DURATION_MS} to ${OPS_MAX_FIND_DEVICE_DURATION_MS} milliseconds`,
        "REJECTED",
      );
    }
    const [notification, vibration] = await Promise.allSettled([
      this.runRootCommand(
        "cmd notification post -t 'One AutoJS6' one-autojs6-find-device 'Find-device request received'",
      ),
      this.runRootCommand(
        `cmd vibrator_manager synced -f -d one-autojs6-find-device oneshot ${durationMs}`,
      ),
    ]);
    const notificationPosted = notification.status === "fulfilled";
    const vibrationStarted = vibration.status === "fulfilled";
    if (!notificationPosted && !vibrationStarted) {
      throw new DeviceOpsFailure(
        "FIND_DEVICE_ALERT_FAILED",
        "Android could not post the find-device notification or vibration",
      );
    }
    return {
      durationMs,
      notificationPosted,
      vibrationStarted,
      audible: false,
      audibleReason: "NO_RELIABLE_AUDIO_BACKEND",
      dndSettingChanged: false,
    };
  }

  /** Capture one bounded PNG without starting an AutoJS engine. */
  private async captureScreenshot(): Promise<DeviceOpsArtifact> {
    let content: Buffer;
    try {
      content = await this.runRootBinaryCommand("nice -n 10 screencap -p");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/maxBuffer|stdout maxBuffer/i.test(message)) {
        throw new DeviceOpsFailure(
          "SCREENSHOT_TOO_LARGE",
          "Screenshot exceeded the operations artifact limit",
        );
      }
      throw new DeviceOpsFailure(
        "SCREENSHOT_CAPTURE_FAILED",
        "Android screenshot capture failed",
      );
    }
    if (
      content.byteLength <= 0 ||
      content.byteLength > OPS_MAX_ARTIFACT_BYTES
    ) {
      throw new DeviceOpsFailure(
        "SCREENSHOT_TOO_LARGE",
        "Screenshot exceeded the operations artifact limit",
      );
    }
    const dimensions = parseScreenshotPng(content);
    return {
      kind: "artifact",
      artifactId: `artifact_${randomUUID().replaceAll("-", "")}`,
      operation: "device.screen.capture",
      mimeType: "image/png",
      content,
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      ...dimensions,
      capturedAt: this.now(),
    };
  }

  /** Validate recording coordinates accepted by the UI target lookup. */
  private uiTargetParams(
    params: Record<string, unknown>,
  ): DeviceUiTargetAtParams {
    validateParamKeys(params, ["x", "y", "screenWidth", "screenHeight"]);
    const { x, y, screenWidth, screenHeight } = params;
    if (
      !Number.isSafeInteger(screenWidth) ||
      !Number.isSafeInteger(screenHeight) ||
      (screenWidth as number) < 1 ||
      (screenHeight as number) < 1 ||
      (screenWidth as number) > 16_384 ||
      (screenHeight as number) > 16_384 ||
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      (x as number) < 0 ||
      (y as number) < 0 ||
      (x as number) >= (screenWidth as number) ||
      (y as number) >= (screenHeight as number)
    ) {
      throw new DeviceOpsFailure(
        "UI_TARGET_COORDINATES_INVALID",
        "UI target coordinates must be safe integers inside a 1 to 16384 pixel screen",
        "REJECTED",
      );
    }
    return {
      x: x as number,
      y: y as number,
      screenWidth: screenWidth as number,
      screenHeight: screenHeight as number,
    };
  }

  /** Dump and inspect one Android UI hierarchy without returning the full tree. */
  private async getUiTargetAt(
    params: Record<string, unknown>,
  ): Promise<DeviceUiTargetAtResult> {
    const coordinates = this.uiTargetParams(params);
    const suffix = randomUUID().replaceAll("-", "");
    const temporaryPath = `/data/local/tmp/one-autojs6-ui-${suffix}.xml`;
    let hierarchy = "";
    let cleanupFailed = false;
    try {
      await this.runRootCommand(
        `uiautomator dump --compressed ${temporaryPath}`,
      );
      hierarchy = await this.runRootCommand(`cat ${temporaryPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DeviceOpsFailure(
        /maxBuffer|parser limit/i.test(message)
          ? "UI_HIERARCHY_TOO_LARGE"
          : "UI_HIERARCHY_DUMP_FAILED",
        /maxBuffer|parser limit/i.test(message)
          ? "Android UI hierarchy exceeded the read limit"
          : "Android UI hierarchy dump failed",
      );
    } finally {
      await this.runRootCommand(`rm -f ${temporaryPath}`).catch(() => {
        cleanupFailed = true;
      });
    }
    if (cleanupFailed) {
      throw new DeviceOpsFailure(
        "UI_HIERARCHY_CLEANUP_FAILED",
        "Android UI hierarchy temporary file cleanup failed",
      );
    }
    if (Buffer.byteLength(hierarchy, "utf8") > OPS_MAX_UI_HIERARCHY_BYTES) {
      throw new DeviceOpsFailure(
        "UI_HIERARCHY_TOO_LARGE",
        "Android UI hierarchy exceeded the read limit",
      );
    }
    const [activity, windows, wmSize] = await Promise.all([
      this.optionalRootCommand("dumpsys activity activities"),
      this.optionalRootCommand("dumpsys window windows"),
      this.optionalRootCommand("wm size"),
    ]);
    try {
      return resolveUiTargetAt(
        hierarchy,
        activity,
        windows,
        wmSize,
        coordinates,
        this.now(),
      );
    } catch {
      throw new DeviceOpsFailure(
        "UI_HIERARCHY_INVALID",
        "Android returned an invalid UI hierarchy",
      );
    }
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
    if (operation === "device.ops.capabilities") return this.getCapabilities();
    if (operation === "device.screen.capture") return this.captureScreenshot();
    if (operation === "device.ui.target-at") return this.getUiTargetAt(params);
    if (operation === "device.screen.brightness.get") {
      validateParamKeys(params, []);
      return this.getBrightness();
    }
    if (operation === "device.screen.brightness.set") {
      return this.setBrightness(params);
    }
    if (operation === "device.alert.find") {
      return this.findDeviceAlert(params);
    }
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
        ) || /mResumedActivity:.*?\s([A-Za-z0-9._]+)\/([^\s}]+)/.exec(activity);
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
    if (operation === "device.telephony.get") {
      validateParamKeys(params, []);
      const [registry, subscriptions, simStates] = await Promise.all([
        this.optionalRootCommand("dumpsys telephony.registry"),
        this.optionalRootCommand("dumpsys isub"),
        this.optionalRootCommand("getprop gsm.sim.state"),
      ]);
      return buildTelephonySnapshot(registry, subscriptions, simStates);
    }
    if (operation === "device.network.get") {
      validateParamKeys(params, []);
      const [connectivity, addresses, routes, dns, wifi, telephony] =
        await Promise.all([
          this.runRootCommand("dumpsys connectivity"),
          this.runRootCommand("ip -o addr show"),
          this.runRootCommand("ip route show"),
          this.runRootCommand("getprop"),
          this.runRootCommand("cmd wifi status"),
          this.optionalRootCommand("dumpsys telephony.registry"),
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
        : [...dns.matchAll(/\[net\.dns\d+\]: \[([^\]]+)\]/g)].map(
            (match) => match[1],
          );
      const wifiSnapshot = parseWifiStatus(wifi);
      const cellularSlots = parseTelephonyRegistry(telephony).map((slot) => ({
        slotIndex: slot.slotIndex,
        registrationState: slot.dataRegistrationState,
        radioTechnology: slot.dataRadioTechnology,
        connectionState: slot.dataConnectionState,
        signal: {
          primaryTechnology: slot.primarySignalTechnology,
          lte: slot.lte,
          nr: slot.nr,
        },
      }));
      return {
        activeTransport:
          transport === "MOBILE"
            ? "cellular"
            : transport?.toLowerCase() || "unknown",
        validated: /VALIDATED/.test(activeNetwork || ""),
        vpn: transport === "VPN",
        interfaces: addresses.split("\n").filter(Boolean).slice(0, 100),
        networkInterfaces: parseNetworkInterfaces(addresses),
        routes: routes.split("\n").filter(Boolean).slice(0, 100),
        dnsServers,
        wifi: wifiSnapshot,
        cellular: {
          available: cellularSlots.length > 0,
          slots: cellularSlots,
        },
        wifiSsid: wifiSnapshot.ssid,
        wifiBssid: wifiSnapshot.bssid,
      };
    }
    throw new DeviceOpsFailure(
      "OPERATION_NOT_ALLOWED",
      "The requested operation is not in the trusted catalog",
      "REJECTED",
    );
  }
}
