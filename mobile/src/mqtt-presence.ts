import { randomUUID } from "node:crypto";
import type { MqttClient } from "mqtt";
import type { DevicePresencePayload } from "./protocol.js";

/** @param client Existing MQTT connection. @param topic Exact presence topic. @returns Nothing; only unacknowledged live status is removed on disconnect. */
export function discardPresenceOnDisconnect(client: MqttClient, topic: string): void {
  const pending = new Set<number>();
  client.on("packetsend", (packet) => {
    if (packet.cmd === "publish" && packet.qos === 1 && packet.messageId !== undefined && packet.topic === topic) pending.add(packet.messageId);
  });
  client.on("packetreceive", (packet) => {
    if (packet.cmd === "puback" && packet.messageId !== undefined) pending.delete(packet.messageId);
  });
  client.on("close", () => {
    for (const mid of pending) client.removeOutgoingMessage(mid);
    pending.clear();
  });
}

/** Canonical telemetry identity paired with the existing MQTT reporter. */
export interface PresenceIdentity {
  site_id: string;
  gateway_id: string;
  device_id: string;
  reporter_id: string;
}

/** Live connection evidence; LWT timestamps deliberately remain unknown. */
export interface MqttPresenceEnvelope extends DevicePresencePayload, PresenceIdentity {
  schema_version: 1;
  event_id: string;
  boot_id: string;
  session_id: string;
  sequence: number | null;
  event: "online" | "heartbeat" | "offline";
  online: boolean;
  reason: "connected" | "heartbeat" | "shutdown" | "lwt";
  source_time_utc: string | null;
  uptime_ms: number | null;
}

/** Builds live presence in memory; it never enters the phone-health outbox. */
export class MqttPresence {
  private readonly identity: PresenceIdentity;
  private readonly legacyDeviceId: string;
  private readonly now: () => number;
  private readonly started: number;
  private readonly bootId = randomUUID();
  private sessionId = "";
  private sequence = 0;
  private birthPending = true;

  /** @param identity Canonical health identity. @param legacyDeviceId Existing task client ID. @param now Monotonic clock. */
  constructor(identity: PresenceIdentity, legacyDeviceId: string, now = () => performance.now()) {
    this.identity = identity;
    this.legacyDeviceId = legacyDeviceId;
    this.now = now;
    this.started = now();
  }

  /** Rotate before CONNECT. @returns A frozen LWT for this new session. */
  begin(): MqttPresenceEnvelope {
    this.sessionId = randomUUID();
    this.sequence = 0;
    this.birthPending = true;
    return this.envelope(false, "lwt");
  }

  /** @param online Whether the live client is connected. @returns A fresh birth, heartbeat or graceful offline event. */
  message(online: boolean): MqttPresenceEnvelope {
    const value = this.envelope(online, online ? this.birthPending ? "connected" : "heartbeat" : "shutdown");
    if (online) this.birthPending = false;
    return value;
  }

  /** @param online Current state. @param reason Connection event. @returns The bounded compatible wire envelope. */
  private envelope(online: boolean, reason: MqttPresenceEnvelope["reason"]): MqttPresenceEnvelope {
    if (!this.sessionId) throw new Error("Presence session required");
    const will = reason === "lwt";
    const value: MqttPresenceEnvelope = {
      protocolVersion: 2, deviceId: this.legacyDeviceId, status: online ? "ONLINE" : "OFFLINE", timestamp: Date.now(),
      schema_version: 1, event_id: randomUUID(), ...this.identity,
      boot_id: this.bootId, session_id: this.sessionId, sequence: will ? null : ++this.sequence,
      event: online ? reason === "connected" ? "online" : "heartbeat" : "offline", online, reason,
      source_time_utc: will ? null : new Date().toISOString(),
      uptime_ms: will ? null : Math.max(0, Math.floor(this.now() - this.started)),
    };
    if (Buffer.byteLength(JSON.stringify(value)) > 4096) throw new Error("Presence envelope too large");
    return value;
  }
}
