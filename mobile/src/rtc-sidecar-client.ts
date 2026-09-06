import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

import { isRecord } from "./protocol.js";
import {
  REMOTE_DEVICE_FRAME_MAX_BYTES,
  type RemoteRelayIceServer,
  type RemoteRelaySelectedPair,
} from "./remote-session-protocol.js";

/** Relative release path of the Android arm64 WebRTC sidecar. */
export const RTC_SIDECAR_RELEASE_PATH = "bin/rtc-datachannel-android-arm64";

/** Largest complete sidecar IPC payload. */
export const RTC_SIDECAR_IPC_MAX_PAYLOAD_BYTES =
  REMOTE_DEVICE_FRAME_MAX_BYTES + 64 * 1024;

/** Maximum Node stream buffering permitted toward the native sidecar. */
const RTC_SIDECAR_STDIN_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

/** Host-to-sidecar IPC record identifiers. */
export const RTC_SIDECAR_INPUT_RECORD = {
  CONFIGURE: 0x01,
  REMOTE_DESCRIPTION: 0x02,
  ICE_CANDIDATE: 0x03,
  BINARY: 0x04,
  CLOSE: 0x05,
} as const;

/** Sidecar-to-host IPC record identifiers. */
export const RTC_SIDECAR_OUTPUT_RECORD = {
  LOCAL_DESCRIPTION: 0x81,
  ICE_CANDIDATE: 0x82,
  STATE: 0x83,
  BINARY: 0x84,
} as const;

/** One decoded sidecar IPC record. */
export interface RtcSidecarRecord {
  type: number;
  payload: Buffer;
}

/** Callbacks receiving sanitized WebRTC sidecar events. */
export interface RtcSidecarCallbacks {
  onLocalDescription: (description: { type: "answer"; sdp: string }) => void;
  onIceCandidate: (candidate: {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
  }) => void;
  onState: (state: {
    state: "ready" | "disconnected" | "failed" | "closed";
    reasonCode?: string;
    selectedPair?: RemoteRelaySelectedPair;
  }) => void;
  onBinary: (content: Buffer) => void;
}

/** Minimal P2P data transport consumed by the remote-session state machine. */
export interface RtcSidecarTransport {
  start: (iceServers: RemoteRelayIceServer[]) => void;
  setRemoteDescription: (description: { type: "offer"; sdp: string }) => void;
  addIceCandidate: (candidate: {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
  }) => void;
  sendBinary: (content: Buffer) => void;
  close: () => void;
}

/** Trusted immutable sidecar executable description. */
export interface RtcSidecarExecutable {
  executablePath: string;
  expectedSha256: string;
}

/** Dependencies used to create a sidecar transport for one negotiation. */
export interface RtcSidecarFactoryOptions extends RtcSidecarExecutable {
  callbacks: RtcSidecarCallbacks;
}

/**
 * Encode one sidecar IPC record with a four-byte big-endian length prefix.
 *
 * @param type One-byte record type.
 * @param payload Record content excluding its type byte.
 * @returns Complete framed IPC record.
 */
export function encodeRtcSidecarRecord(type: number, payload: Buffer): Buffer {
  if (!Number.isInteger(type) || type < 0 || type > 0xff) {
    throw new Error("Invalid RTC sidecar IPC record type");
  }
  if (payload.byteLength > RTC_SIDECAR_IPC_MAX_PAYLOAD_BYTES) {
    throw new Error("RTC sidecar IPC payload is too large");
  }
  const frame = Buffer.allocUnsafe(5 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength + 1, 0);
  frame[4] = type;
  payload.copy(frame, 5);
  return frame;
}

/** Incremental decoder for length-prefixed sidecar stdout records. */
export class RtcSidecarRecordDecoder {
  private pending = Buffer.alloc(0);

  /**
   * Decode every complete record currently available.
   *
   * @param chunk Newly received stdout bytes.
   * @returns Zero or more complete records in wire order.
   */
  push(chunk: Buffer): RtcSidecarRecord[] {
    this.pending =
      this.pending.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.pending, chunk]);
    const records: RtcSidecarRecord[] = [];
    while (this.pending.byteLength >= 4) {
      const recordBytes = this.pending.readUInt32BE(0);
      if (recordBytes < 1 || recordBytes > RTC_SIDECAR_IPC_MAX_PAYLOAD_BYTES + 1) {
        throw new Error("Invalid RTC sidecar IPC record length");
      }
      if (this.pending.byteLength < recordBytes + 4) break;
      records.push({
        type: this.pending[4],
        payload: Buffer.from(this.pending.subarray(5, recordBytes + 4)),
      });
      this.pending = Buffer.from(this.pending.subarray(recordBytes + 4));
    }
    return records;
  }
}

/**
 * Verify and lock down an immutable sidecar executable before spawning it.
 *
 * @param executable Trusted release path and manifest digest.
 * @returns Nothing.
 */
export function verifyRtcSidecarExecutable(
  executable: RtcSidecarExecutable,
): void {
  if (!/^[0-9a-f]{64}$/.test(executable.expectedSha256)) {
    throw new Error("RTC sidecar manifest digest is invalid");
  }
  const stat = fs.statSync(executable.executablePath);
  if (!stat.isFile()) throw new Error("RTC sidecar executable is not a file");
  const actualSha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(executable.executablePath))
    .digest("hex");
  const expected = Buffer.from(executable.expectedSha256, "hex");
  const actual = Buffer.from(actualSha256, "hex");
  if (!crypto.timingSafeEqual(actual, expected)) {
    throw new Error("RTC sidecar executable failed manifest verification");
  }
  fs.chmodSync(executable.executablePath, 0o500);
}

/**
 * Parse JSON from a bounded sidecar record.
 *
 * @param payload UTF-8 JSON record payload.
 * @returns Parsed plain object.
 */
function parseJsonRecord(payload: Buffer): Record<string, unknown> {
  const value = JSON.parse(payload.toString("utf8")) as unknown;
  if (!isRecord(value)) throw new Error("RTC sidecar JSON record must be an object");
  return value;
}

/**
 * Serialize a JSON input record without accepting undefined or binary values.
 *
 * @param type Input record type.
 * @param value JSON-compatible object.
 * @returns Complete framed record.
 */
function jsonRecord(type: number, value: Record<string, unknown>): Buffer {
  return encodeRtcSidecarRecord(type, Buffer.from(JSON.stringify(value), "utf8"));
}

/**
 * Check and normalize one non-secret sidecar reason code.
 *
 * @param value Unknown reason code.
 * @returns Safe reason code when present.
 */
function parseReasonCode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Z0-9_]{1,100}$/.test(value)) {
    throw new Error("RTC sidecar returned an invalid reason code");
  }
  return value;
}

/**
 * Parse optional sanitized selected-pair diagnostics.
 *
 * @param value Unknown selected-pair object.
 * @returns Strict candidate pair when supplied.
 */
function parseSelectedPair(value: unknown): RemoteRelaySelectedPair | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("RTC selected pair must be an object");
  const candidateTypes = ["host", "srflx", "prflx", "relay"];
  if (
    Object.keys(value).some(
      (key) =>
        !["localCandidateType", "remoteCandidateType", "protocol"].includes(key),
    ) ||
    !candidateTypes.includes(String(value.localCandidateType)) ||
    !candidateTypes.includes(String(value.remoteCandidateType)) ||
    (value.protocol !== "udp" && value.protocol !== "tcp")
  ) {
    throw new Error("RTC sidecar returned invalid selected-pair diagnostics");
  }
  return value as unknown as RemoteRelaySelectedPair;
}

/** Pion sidecar process using framed stdin/stdout records only. */
export class RtcSidecarProcess implements RtcSidecarTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new RtcSidecarRecordDecoder();
  private closing = false;

  /**
   * Create one unstarted sidecar process wrapper.
   *
   * @param options Verified executable and event callbacks.
   */
  constructor(private readonly options: RtcSidecarFactoryOptions) {}

  /**
   * Start the verified native process and configure its STUN servers.
   *
   * @param iceServers Trusted STUN-only ICE server descriptors.
   * @returns Nothing.
   */
  start(iceServers: RemoteRelayIceServer[]): void {
    if (this.child) throw new Error("RTC sidecar is already running");
    verifyRtcSidecarExecutable(this.options);
    const child = spawn(this.options.executablePath, [], {
      shell: false,
      windowsHide: true,
      env: { PATH: process.env.PATH || "/system/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const record of this.decoder.push(Buffer.from(chunk))) {
          this.handleOutput(record);
        }
      } catch {
        this.fail("RTC_SIDECAR_PROTOCOL_INVALID");
      }
    });
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => this.fail("RTC_SIDECAR_IPC_WRITE_FAILED"));
    child.once("error", () => this.fail("RTC_SIDECAR_SPAWN_FAILED"));
    child.once("exit", (code, signal) => {
      this.child = null;
      if (!this.closing) {
        this.options.callbacks.onState({
          state: "failed",
          reasonCode:
            code === 0 && signal === null
              ? "RTC_SIDECAR_EXITED"
              : "RTC_SIDECAR_CRASHED",
        });
      }
    });
    this.writeJson(RTC_SIDECAR_INPUT_RECORD.CONFIGURE, { iceServers });
  }

  /**
   * Supply the browser offer to the answerer.
   *
   * @param description Strict remote offer.
   * @returns Nothing.
   */
  setRemoteDescription(description: { type: "offer"; sdp: string }): void {
    this.writeJson(RTC_SIDECAR_INPUT_RECORD.REMOTE_DESCRIPTION, description);
  }

  /**
   * Supply one trickled browser ICE candidate.
   *
   * @param candidate Strict remote ICE candidate.
   * @returns Nothing.
   */
  addIceCandidate(candidate: {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
  }): void {
    this.writeJson(RTC_SIDECAR_INPUT_RECORD.ICE_CANDIDATE, candidate);
  }

  /**
   * Send one complete scrcpy device frame through the DataChannel.
   *
   * @param content Opaque binary scrcpy frame.
   * @returns Nothing.
   */
  sendBinary(content: Buffer): void {
    if (
      content.byteLength < 1 ||
      content.byteLength > REMOTE_DEVICE_FRAME_MAX_BYTES
    ) {
      throw new Error("RTC device frame must contain 1 byte to 4 MiB");
    }
    this.write(encodeRtcSidecarRecord(RTC_SIDECAR_INPUT_RECORD.BINARY, content));
  }

  /**
   * Close the sidecar and release its native WebRTC resources idempotently.
   *
   * @returns Nothing.
   */
  close(): void {
    if (this.closing) return;
    const child = this.child;
    if (!child) {
      this.closing = true;
      return;
    }
    try {
      this.write(jsonRecord(RTC_SIDECAR_INPUT_RECORD.CLOSE, {}));
    } catch {
      this.closing = true;
      child.kill("SIGTERM");
      return;
    }
    this.closing = true;
    const timer = setTimeout(() => {
      if (this.child === child) child.kill("SIGTERM");
    }, 500);
    timer.unref();
  }

  /**
   * Write one JSON command to the running sidecar.
   *
   * @param type Input record type.
   * @param value JSON-compatible object.
   * @returns Nothing.
   */
  private writeJson(type: number, value: Record<string, unknown>): void {
    this.write(jsonRecord(type, value));
  }

  /**
   * Write a complete record without shell or intermediary socket transport.
   *
   * @param frame Complete framed record.
   * @returns Nothing.
   */
  private write(frame: Buffer): void {
    const child = this.child;
    if (!child || !child.stdin.writable || this.closing) {
      throw new Error("RTC sidecar stdin is unavailable");
    }
    if (
      child.stdin.writableLength + frame.byteLength >
      RTC_SIDECAR_STDIN_BUFFER_MAX_BYTES
    ) {
      throw new Error("RTC sidecar IPC backpressure limit reached");
    }
    child.stdin.write(frame);
  }

  /**
   * Validate and deliver one sidecar stdout record.
   *
   * @param record Decoded record.
   * @returns Nothing.
   */
  private handleOutput(record: RtcSidecarRecord): void {
    if (record.type === RTC_SIDECAR_OUTPUT_RECORD.BINARY) {
      if (record.payload.byteLength > 64 * 1024) {
        throw new Error("RTC browser frame exceeds the 64 KiB limit");
      }
      this.options.callbacks.onBinary(Buffer.from(record.payload));
      return;
    }
    const value = parseJsonRecord(record.payload);
    if (record.type === RTC_SIDECAR_OUTPUT_RECORD.LOCAL_DESCRIPTION) {
      if (
        Object.keys(value).some((key) => !["type", "sdp"].includes(key)) ||
        value.type !== "answer" ||
        typeof value.sdp !== "string" ||
        value.sdp.length < 1 ||
        Buffer.byteLength(value.sdp, "utf8") > 48 * 1024
      ) {
        throw new Error("RTC sidecar returned an invalid answer");
      }
      this.options.callbacks.onLocalDescription({ type: "answer", sdp: value.sdp });
      return;
    }
    if (record.type === RTC_SIDECAR_OUTPUT_RECORD.ICE_CANDIDATE) {
      if (
        Object.keys(value).some(
          (key) => !["candidate", "sdpMid", "sdpMLineIndex"].includes(key),
        ) ||
        typeof value.candidate !== "string" ||
        value.candidate.length > 4096 ||
        (value.sdpMid !== undefined &&
          (typeof value.sdpMid !== "string" || value.sdpMid.length > 256)) ||
        (value.sdpMLineIndex !== undefined &&
          (!Number.isInteger(value.sdpMLineIndex) ||
            (value.sdpMLineIndex as number) < 0 ||
            (value.sdpMLineIndex as number) > 1024))
      ) {
        throw new Error("RTC sidecar returned an invalid ICE candidate");
      }
      this.options.callbacks.onIceCandidate({
        candidate: value.candidate,
        ...(value.sdpMid === undefined ? {} : { sdpMid: value.sdpMid as string }),
        ...(value.sdpMLineIndex === undefined
          ? {}
          : { sdpMLineIndex: value.sdpMLineIndex as number }),
      });
      return;
    }
    if (record.type === RTC_SIDECAR_OUTPUT_RECORD.STATE) {
      if (
        Object.keys(value).some(
          (key) => !["state", "reasonCode", "selectedPair"].includes(key),
        ) ||
        !["ready", "disconnected", "failed", "closed"].includes(
          String(value.state),
        )
      ) {
        throw new Error("RTC sidecar returned an invalid state");
      }
      this.options.callbacks.onState({
        state: value.state as "ready" | "disconnected" | "failed" | "closed",
        ...(parseReasonCode(value.reasonCode) === undefined
          ? {}
          : { reasonCode: parseReasonCode(value.reasonCode) }),
        ...(parseSelectedPair(value.selectedPair) === undefined
          ? {}
          : { selectedPair: parseSelectedPair(value.selectedPair) }),
      });
      return;
    }
    throw new Error("RTC sidecar returned an unsupported record type");
  }

  /**
   * Terminate a protocol-invalid sidecar and publish one sanitized failure.
   *
   * @param reasonCode Stable machine-readable failure reason.
   * @returns Nothing.
   */
  private fail(reasonCode: string): void {
    if (this.closing) return;
    this.closing = true;
    this.child?.kill("SIGTERM");
    this.options.callbacks.onState({ state: "failed", reasonCode });
  }
}

/**
 * Create the production sidecar transport.
 *
 * @param options Verified executable and callbacks.
 * @returns Unstarted Pion process wrapper.
 */
export function createRtcSidecarProcess(
  options: RtcSidecarFactoryOptions,
): RtcSidecarTransport {
  return new RtcSidecarProcess(options);
}
