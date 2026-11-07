import type { DevicePresencePayload } from "./protocol.js";

/**
 * Keep the closed legacy HTTP schema while MQTT carries the extended envelope.
 *
 * @param payload Presence shared with the MQTT reporting channel.
 * @returns Only the four fields accepted by the existing HTTP endpoint.
 */
export function toHttpPresence(
  payload: DevicePresencePayload,
): DevicePresencePayload {
  return {
    protocolVersion: payload.protocolVersion,
    deviceId: payload.deviceId,
    status: payload.status,
    timestamp: payload.timestamp,
  };
}
