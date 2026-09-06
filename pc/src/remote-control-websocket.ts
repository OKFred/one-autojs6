import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";

import {
  REMOTE_CONTROL_MAX_DEVICE_BINARY_BYTES,
  REMOTE_CONTROL_MAX_JSON_BYTES,
  REMOTE_CONTROL_PROTOCOL_VERSION_V1,
  REMOTE_CONTROL_PROTOCOL_VERSION_V2,
  normalizeRemoteControlRelayUrl,
  parseRemoteControlStunUrls,
} from "./remote-control-protocol.js";
import { safeDeviceOpsSecretEqual } from "./device-ops-protocol.js";
import { RemoteControlService } from "./service/remote-control.service.js";
import {
  rejectWebSocketUpgrade,
  type WebSocketUpgradeHandler,
} from "./websocket-upgrade-router.js";

/** Legacy relay-only WebSocket subprotocol. */
export const REMOTE_CONTROL_SUBPROTOCOL_V1 = "autojs6-remote-v1";

/** P2P-capable WebSocket subprotocol preferred by the server. */
export const REMOTE_CONTROL_SUBPROTOCOL_V2 = "autojs6-remote-v2";

/** Legacy import alias retained for existing relay clients and tests. */
export const REMOTE_CONTROL_SUBPROTOCOL = REMOTE_CONTROL_SUBPROTOCOL_V1;

/** Supported remote-control subprotocols in server preference order. */
export const REMOTE_CONTROL_SUBPROTOCOLS = [
  REMOTE_CONTROL_SUBPROTOCOL_V2,
  REMOTE_CONTROL_SUBPROTOCOL_V1,
] as const;

/** Direct-source upgrade attempts accepted during one short admission window. */
const REMOTE_CONTROL_UPGRADE_ATTEMPTS_PER_WINDOW = 12;

/** Short admission window limiting unauthenticated socket churn. */
const REMOTE_CONTROL_UPGRADE_WINDOW_MS = 10_000;

/** Maximum direct remote-address entries retained by the admission limiter. */
const REMOTE_CONTROL_UPGRADE_MAX_ADDRESSES = 1_024;

/** Validated optional remote-control WSS configuration. */
export interface RemoteControlWebSocketConfig {
  deviceToken: string;
  relayWsUrl: string;
  pathname: string;
  browserOrigins: ReadonlySet<string>;
  allowP2P: boolean;
  stunUrls: readonly string[];
}

/** No-server relay endpoint for the shared PC upgrade router. */
export interface RemoteControlWebSocketEndpoint {
  pathname: string;
  handleUpgrade: WebSocketUpgradeHandler;
  controllerWebSocketServer: WebSocketServer;
  deviceWebSocketServer: WebSocketServer;
}

/** Injectable limits for deterministic upgrade-admission tests. */
export interface RemoteControlUpgradeAdmissionOptions {
  now?: () => number;
  windowMs?: number;
  maxAttempts?: number;
  maxAddresses?: number;
}

/** One bounded per-address upgrade counter. */
interface RemoteControlUpgradeWindow {
  startedAt: number;
  attempts: number;
}

/**
 * Normalize one browser origin without accepting wildcards or credentials.
 *
 * @param value Candidate HTTP or HTTPS origin.
 * @returns Exact serialized origin.
 */
function normalizeBrowserOrigin(value: string): string {
  const trimmed = value.trim();
  const url = new URL(trimmed);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.origin === "null" ||
    url.origin !== trimmed
  ) {
    throw new Error(
      "Remote-control browser origins must be exact HTTP or HTTPS origins",
    );
  }
  return url.origin;
}

/**
 * Convert a relay WebSocket URL into its same-host browser origin.
 *
 * @param relayWsUrl Validated WS or WSS relay URL.
 * @returns Corresponding HTTP or HTTPS origin.
 */
function browserOriginForRelay(relayWsUrl: string): string {
  const url = new URL(relayWsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

/**
 * Validate the long-lived device credential used only at WSS handshake time.
 *
 * @param authorization Raw Authorization header.
 * @param expectedToken Configured device report token.
 * @returns Whether the header contains the exact Device credential.
 */
export function isValidRemoteControlDeviceAuthorization(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (expectedToken.length < 16 || !authorization?.startsWith("Device ")) {
    return false;
  }
  return safeDeviceOpsSecretEqual(authorization.slice(7), expectedToken);
}

/**
 * Create a bounded direct-source WebSocket upgrade admission function.
 *
 * The socket remote address is intentionally used instead of trusting forwarded
 * headers. Public reverse proxies must enforce their own client-IP rate limit.
 *
 * @param options Optional deterministic clock and bounded limiter values.
 * @returns Function returning whether one direct address may attempt an upgrade.
 */
export function createRemoteControlUpgradeAdmission(
  options: RemoteControlUpgradeAdmissionOptions = {},
): (remoteAddress: string | undefined) => boolean {
  const now = options.now || Date.now;
  const windowMs =
    options.windowMs ?? REMOTE_CONTROL_UPGRADE_WINDOW_MS;
  const maxAttempts =
    options.maxAttempts ?? REMOTE_CONTROL_UPGRADE_ATTEMPTS_PER_WINDOW;
  const maxAddresses =
    options.maxAddresses ?? REMOTE_CONTROL_UPGRADE_MAX_ADDRESSES;
  if (
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1_000 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isSafeInteger(maxAddresses) ||
    maxAddresses < 1
  ) {
    throw new Error("Remote-control upgrade admission limits are invalid");
  }
  const windows = new Map<string, RemoteControlUpgradeWindow>();
  return (remoteAddress) => {
    const currentTime = now();
    if (!Number.isFinite(currentTime)) return false;
    const address = String(remoteAddress || "unknown").slice(0, 128);
    let current = windows.get(address);
    if (
      !current ||
      currentTime < current.startedAt ||
      currentTime - current.startedAt >= windowMs
    ) {
      if (!current && windows.size >= maxAddresses) {
        for (const [key, entry] of windows) {
          if (
            currentTime < entry.startedAt ||
            currentTime - entry.startedAt >= windowMs
          ) {
            windows.delete(key);
          }
        }
        while (windows.size >= maxAddresses) {
          const oldestKey = windows.keys().next().value as string | undefined;
          if (!oldestKey) break;
          windows.delete(oldestKey);
        }
      }
      current = { startedAt: currentTime, attempts: 0 };
    } else {
      windows.delete(address);
    }
    current.attempts += 1;
    windows.set(address, current);
    return current.attempts <= maxAttempts;
  };
}

/**
 * Check the shared relay request shape before role-specific authorization.
 *
 * @param request Incoming WebSocket upgrade request.
 * @returns Whether the request uses the exact subprotocol and no URL data.
 */
function isRemoteControlUpgradeShapeValid(request: IncomingMessage): boolean {
  const protocols = String(
    request.headers["sec-websocket-protocol"] || "",
  )
    .split(",")
    .map((value) => value.trim());
  if (
    !protocols.some((protocol) =>
      REMOTE_CONTROL_SUBPROTOCOLS.includes(
        protocol as (typeof REMOTE_CONTROL_SUBPROTOCOLS)[number],
      ),
    )
  ) {
    return false;
  }
  try {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    return !requestUrl.search && !requestUrl.hash;
  } catch {
    return false;
  }
}

/**
 * Resolve optional remote-control relay configuration from the environment.
 *
 * Absence of the relay URL disables only this feature. Supplying a relay URL
 * requires the existing device report token and safe explicit P2P policy.
 *
 * @param environment Process environment to validate.
 * @returns Relay configuration, or null when the feature is disabled.
 */
export function resolveRemoteControlWebSocketConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RemoteControlWebSocketConfig | null {
  const rawRelayUrl = String(
    environment.REMOTE_CONTROL_RELAY_WS_URL || "",
  ).trim();
  if (!rawRelayUrl) return null;
  const deviceToken = String(
    environment.DEVICE_OPS_REPORT_TOKEN || "",
  ).trim();
  if (deviceToken.length < 16) {
    throw new Error(
      "REMOTE_CONTROL_RELAY_WS_URL requires DEVICE_OPS_REPORT_TOKEN with at least 16 characters",
    );
  }
  const browserToken = String(environment.ONE_AUTOJS6_API_TOKEN || "");
  if (
    browserToken.length > 0 &&
    safeDeviceOpsSecretEqual(deviceToken, browserToken)
  ) {
    throw new Error(
      "DEVICE_OPS_REPORT_TOKEN must not reuse ONE_AUTOJS6_API_TOKEN",
    );
  }
  const relayWsUrl = normalizeRemoteControlRelayUrl(rawRelayUrl);
  const pathname = new URL(relayWsUrl).pathname;
  const p2pValue = String(
    environment.REMOTE_CONTROL_ALLOW_P2P_NEGOTIATION || "false",
  ).trim();
  if (p2pValue !== "true" && p2pValue !== "false") {
    throw new Error(
      "REMOTE_CONTROL_ALLOW_P2P_NEGOTIATION must be true or false",
    );
  }
  const allowP2P = p2pValue === "true";
  const stunUrls = parseRemoteControlStunUrls(
    environment.REMOTE_CONTROL_STUN_URLS,
    allowP2P,
  );
  const browserOrigins = new Set<string>();
  browserOrigins.add(browserOriginForRelay(relayWsUrl));
  browserOrigins.add(
    normalizeBrowserOrigin(
      environment.SCRCPY_ORIGIN || "http://127.0.0.1:8000",
    ),
  );
  const port = String(environment.PORT || "3000");
  browserOrigins.add(normalizeBrowserOrigin(`http://127.0.0.1:${port}`));
  browserOrigins.add(normalizeBrowserOrigin(`http://localhost:${port}`));
  for (const value of String(
    environment.REMOTE_CONTROL_BROWSER_ORIGINS || "",
  ).split(",")) {
    if (value.trim()) browserOrigins.add(normalizeBrowserOrigin(value));
  }
  return {
    deviceToken,
    relayWsUrl,
    pathname,
    browserOrigins,
    allowP2P,
    stunUrls,
  };
}

/**
 * Select the highest supported remote-control WebSocket subprotocol.
 *
 * @param protocols Client-offered subprotocols.
 * @returns Selected protocol or false when no supported version was offered.
 */
export function selectRemoteControlSubprotocol(
  protocols: Set<string>,
): string | false {
  if (protocols.has(REMOTE_CONTROL_SUBPROTOCOL_V2)) {
    return REMOTE_CONTROL_SUBPROTOCOL_V2;
  }
  if (protocols.has(REMOTE_CONTROL_SUBPROTOCOL_V1)) {
    return REMOTE_CONTROL_SUBPROTOCOL_V1;
  }
  return false;
}

/**
 * Create an authenticated, no-server remote-control relay endpoint.
 *
 * @param config Validated relay configuration.
 * @param gateway Optional isolated relay service used by tests.
 * @param admitUpgrade Optional bounded direct-address admission function.
 * @returns Endpoint mapping for the shared upgrade router.
 */
export function createRemoteControlWebSocketEndpoint(
  config: RemoteControlWebSocketConfig,
  gateway = RemoteControlService.getInstance(),
  admitUpgrade = createRemoteControlUpgradeAdmission(),
): RemoteControlWebSocketEndpoint {
  const controllerWebSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: REMOTE_CONTROL_MAX_JSON_BYTES,
    perMessageDeflate: false,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      if (!isRemoteControlUpgradeShapeValid(req)) return false;
      if (req.headers.authorization !== undefined) return false;
      const origin = String(req.headers.origin || "");
      return config.browserOrigins.has(origin);
    },
    handleProtocols: selectRemoteControlSubprotocol,
  });
  const deviceWebSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: REMOTE_CONTROL_MAX_DEVICE_BINARY_BYTES,
    perMessageDeflate: false,
    verifyClient: ({ req }: { req: IncomingMessage }) =>
      isRemoteControlUpgradeShapeValid(req) &&
      isValidRemoteControlDeviceAuthorization(
        req.headers.authorization,
        config.deviceToken,
      ),
    handleProtocols: selectRemoteControlSubprotocol,
  });
  controllerWebSocketServer.on("connection", (socket) =>
    gateway.acceptSocket(
      socket,
      "browser",
      socket.protocol === REMOTE_CONTROL_SUBPROTOCOL_V2
        ? REMOTE_CONTROL_PROTOCOL_VERSION_V2
        : REMOTE_CONTROL_PROTOCOL_VERSION_V1,
    ),
  );
  deviceWebSocketServer.on("connection", (socket) =>
    gateway.acceptSocket(
      socket,
      "device",
      socket.protocol === REMOTE_CONTROL_SUBPROTOCOL_V2
        ? REMOTE_CONTROL_PROTOCOL_VERSION_V2
        : REMOTE_CONTROL_PROTOCOL_VERSION_V1,
    ),
  );
  const handleUpgrade: WebSocketUpgradeHandler = (request, socket, head) => {
    if (!admitUpgrade(request.socket.remoteAddress)) {
      rejectWebSocketUpgrade(socket, "429 Too Many Requests");
      return;
    }
    if (!isRemoteControlUpgradeShapeValid(request)) {
      rejectWebSocketUpgrade(socket, "400 Bad Request");
      return;
    }
    const authorization = request.headers.authorization;
    const isDevice = isValidRemoteControlDeviceAuthorization(
      authorization,
      config.deviceToken,
    );
    if (authorization !== undefined && !isDevice) {
      rejectWebSocketUpgrade(socket, "401 Unauthorized");
      return;
    }
    if (
      !isDevice &&
      !config.browserOrigins.has(String(request.headers.origin || ""))
    ) {
      rejectWebSocketUpgrade(socket, "403 Forbidden");
      return;
    }
    const selected = isDevice
      ? deviceWebSocketServer
      : controllerWebSocketServer;
    selected.handleUpgrade(request, socket, head, (webSocket) => {
      selected.emit("connection", webSocket, request);
    });
  };
  return {
    pathname: config.pathname,
    handleUpgrade,
    controllerWebSocketServer,
    deviceWebSocketServer,
  };
}
