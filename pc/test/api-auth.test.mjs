import assert from "node:assert/strict";
import WebSocket from "ws";

const baseUrl = process.env.PC_BASE_URL || "http://localhost:3317";
const token = process.env.ONE_AUTOJS6_API_TOKEN;
if (!token) throw new Error("ONE_AUTOJS6_API_TOKEN is required for this test");

const unauthorized = await fetch(`${baseUrl}/api/tasks`);
assert.equal(unauthorized.status, 401);

const authorized = await fetch(`${baseUrl}/api/tasks`, {
  headers: { Authorization: `Bearer ${token}` },
});
assert.equal(authorized.status, 200);

const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/screen";

function expectWebSocket(protocols, expected) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, protocols);
    const timer = setTimeout(
      () => reject(new Error("WebSocket test timeout")),
      5_000,
    );
    socket.on("open", () => {
      if (expected !== "open") {
        reject(new Error("Unauthenticated WebSocket unexpectedly opened"));
        return;
      }
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.on("unexpected-response", (_request, response) => {
      if (expected !== "rejected" || response.statusCode < 400) {
        reject(
          new Error(`Unexpected WebSocket response ${response.statusCode}`),
        );
        return;
      }
      clearTimeout(timer);
      resolve();
    });
    socket.on("error", (error) => {
      if (expected === "rejected") return;
      clearTimeout(timer);
      reject(error);
    });
  });
}

await expectWebSocket(undefined, "rejected");
await expectWebSocket(
  ["one-autojs6", `bearer.${Buffer.from(token).toString("base64url")}`],
  "open",
);

console.log("PC HTTP and WebSocket authentication tests passed");
