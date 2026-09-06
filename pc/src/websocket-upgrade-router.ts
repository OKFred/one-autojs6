import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

/** Custom upgrade handler used when one path selects among multiple WSS policies. */
export type WebSocketUpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

/** One exact-path WebSocket endpoint hosted by the shared PC HTTP server. */
export type WebSocketUpgradeEndpoint =
  | {
      pathname: string;
      webSocketServer: WebSocketServer;
      handleUpgrade?: never;
    }
  | {
      pathname: string;
      handleUpgrade: WebSocketUpgradeHandler;
      webSocketServer?: never;
    };

/**
 * Write a small HTTP error and close an unhandled WebSocket upgrade socket.
 *
 * @param socket Raw upgraded TCP socket.
 * @param statusLine HTTP status line returned before closing.
 * @returns Nothing.
 */
export function rejectWebSocketUpgrade(
  socket: Duplex,
  statusLine: string,
): void {
  if (!socket.destroyed) {
    socket.write(
      `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
  socket.destroy();
}

/**
 * Attach one pathname router for every no-server WebSocket endpoint.
 *
 * A single upgrade listener is required because separate ws servers created
 * with `{ server, path }` can reject each other's otherwise valid upgrades.
 *
 * @param server Shared Node HTTP server.
 * @param endpoints Exact, unique pathname-to-WebSocket-server mappings.
 * @returns Nothing.
 */
export function attachWebSocketUpgradeRouter(
  server: HttpServer,
  endpoints: readonly WebSocketUpgradeEndpoint[],
): void {
  const routes = new Map<string, WebSocketUpgradeEndpoint>();
  for (const endpoint of endpoints) {
    if (
      !endpoint.pathname.startsWith("/") ||
      endpoint.pathname.includes("?") ||
      endpoint.pathname.includes("#")
    ) {
      throw new Error("WebSocket endpoint pathname must be an absolute path");
    }
    if (routes.has(endpoint.pathname)) {
      throw new Error(`Duplicate WebSocket endpoint path: ${endpoint.pathname}`);
    }
    if (Boolean(endpoint.webSocketServer) === Boolean(endpoint.handleUpgrade)) {
      throw new Error(
        "WebSocket endpoint must provide exactly one server or upgrade handler",
      );
    }
    routes.set(endpoint.pathname, endpoint);
  }

  server.on("upgrade", (request, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    } catch {
      rejectWebSocketUpgrade(socket, "400 Bad Request");
      return;
    }
    const target = routes.get(pathname);
    if (!target) {
      rejectWebSocketUpgrade(socket, "404 Not Found");
      return;
    }
    if (target.handleUpgrade) {
      target.handleUpgrade(request, socket, head);
      return;
    }
    const webSocketServer = target.webSocketServer;
    if (!webSocketServer) {
      rejectWebSocketUpgrade(socket, "500 Internal Server Error");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
}
