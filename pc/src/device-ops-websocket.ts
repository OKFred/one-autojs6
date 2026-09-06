import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";

import {
  DEVICE_OPS_MAX_ARTIFACT_BYTES,
  DEVICE_OPS_MAX_ARTIFACT_HEADER_BYTES,
  normalizeDeviceOpsWsUrl,
  safeDeviceOpsSecretEqual,
} from "./device-ops-protocol.js";
import { DeviceOpsService } from "./service/device-ops.service.js";

/** Device operations WebSocket subprotocol required from the mobile client. */
export const DEVICE_OPS_SUBPROTOCOL = "autojs6-ops-v1";

/** Environment-derived configuration that explicitly enables the ops WSS. */
export interface DeviceOpsWebSocketConfig {
  reportToken: string;
  wsUrl: string;
  pathname: string;
}

/** A no-server operations endpoint ready for the shared upgrade router. */
export interface DeviceOpsWebSocketEndpoint {
  pathname: string;
  webSocketServer: WebSocketServer;
}

/**
 * Validate a device-only Authorization header against the configured token.
 *
 * @param authorization Raw Authorization header.
 * @param expectedToken Configured device reporting token.
 * @returns Whether the header contains the exact `Device` credential.
 */
export function isValidDeviceOpsAuthorization(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (expectedToken.length < 16 || !authorization?.startsWith("Device ")) {
    return false;
  }
  return safeDeviceOpsSecretEqual(authorization.slice(7), expectedToken);
}

/**
 * Resolve the optional operations gateway configuration from the environment.
 *
 * An absent ops URL means deliberately disabled. A report token may still be
 * present for the independent remote-control relay; all other partial or
 * unsafe combinations are rejected.
 *
 * @param environment Process environment containing the gateway variables.
 * @returns Validated configuration, or null when the gateway is disabled.
 */
export function resolveDeviceOpsWebSocketConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DeviceOpsWebSocketConfig | null {
  const reportToken = String(environment.DEVICE_OPS_REPORT_TOKEN || "").trim();
  const rawWsUrl = String(environment.DEVICE_OPS_WS_URL || "").trim();
  if (!reportToken && !rawWsUrl) return null;
  if (
    reportToken &&
    !rawWsUrl &&
    String(environment.REMOTE_CONTROL_RELAY_WS_URL || "").trim()
  ) {
    return null;
  }
  if (!reportToken || !rawWsUrl) {
    throw new Error(
      "DEVICE_OPS_REPORT_TOKEN and DEVICE_OPS_WS_URL must be configured together",
    );
  }
  if (reportToken.length < 16) {
    throw new Error(
      "DEVICE_OPS_REPORT_TOKEN is required and must contain at least 16 characters",
    );
  }
  const browserToken = String(environment.ONE_AUTOJS6_API_TOKEN || "");
  if (
    browserToken.length > 0 &&
    safeDeviceOpsSecretEqual(reportToken, browserToken)
  ) {
    throw new Error(
      "DEVICE_OPS_REPORT_TOKEN must not reuse ONE_AUTOJS6_API_TOKEN",
    );
  }
  const wsUrl = normalizeDeviceOpsWsUrl(rawWsUrl);
  const pathname = new URL(wsUrl).pathname;
  if (pathname === "/api/screen") {
    throw new Error("DEVICE_OPS_WS_URL must not reuse the legacy screen path");
  }
  return { reportToken, wsUrl, pathname };
}

/**
 * Create the authenticated device-initiated operations WSS.
 *
 * @param config Validated, explicitly enabled device endpoint configuration.
 * @param gateway Optional isolated gateway used by tests.
 * @returns A no-server endpoint for the shared pathname upgrade router.
 */
export function createDeviceOpsWebSocketEndpoint(
  config: DeviceOpsWebSocketConfig,
  gateway = DeviceOpsService.getInstance(),
): DeviceOpsWebSocketEndpoint {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload:
      4 +
      DEVICE_OPS_MAX_ARTIFACT_HEADER_BYTES +
      DEVICE_OPS_MAX_ARTIFACT_BYTES,
    perMessageDeflate: false,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const protocols = String(req.headers["sec-websocket-protocol"] || "")
        .split(",")
        .map((value) => value.trim());
      return (
        protocols.includes(DEVICE_OPS_SUBPROTOCOL) &&
        isValidDeviceOpsAuthorization(
          req.headers.authorization,
          config.reportToken,
        )
      );
    },
    handleProtocols: (protocols) =>
      protocols.has(DEVICE_OPS_SUBPROTOCOL)
        ? DEVICE_OPS_SUBPROTOCOL
        : false,
  });
  webSocketServer.on("connection", (socket) =>
    gateway.acceptDeviceSocket(socket),
  );
  return {
    pathname: config.pathname,
    webSocketServer,
  };
}
