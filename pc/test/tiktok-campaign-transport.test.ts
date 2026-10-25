import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { campaignHttpTransport } from "../src/tiktok-campaign-http.js";
import { runCampaignCommand } from "../src/tiktok-campaign-runner.js";
import { manifestDigest, type CampaignManifest } from "../src/tiktok-campaign.js";
import { assertedTikTokTarget } from "../src/tiktok-device-assertion.js";
import { tiktokPost } from "../src/controller/tiktokPost.js";
import { AutojsService } from "../src/service/autojs.service.js";
import { MqttService } from "../src/service/mqtt.service.js";
import { createApiAuthMiddleware } from "../src/middleware/api-auth.js";

const taskId = "8fa04e65-0c0c-46ca-bdb2-00bd21e53c28";
const publicationId = "a31fac0c-0c0c-46ca-bdb2-00bd21e53c29";
const env = { PORT: "3317", ONE_AUTOJS6_API_TOKEN: "synthetic-api-token-long-enough" };

/** Return a synthetic existing-PC envelope without opening an HTTP listener. */
function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: status === 200, message: "synthetic", data }), { status, headers: { "Content-Type": "application/json" } });
}

test("device assertions are equality checks, never device selection or online-device fallback", () => {
  assert.equal(assertedTikTokTarget(undefined, undefined), undefined);
  assert.equal(assertedTikTokTarget("synthetic-device", " synthetic-device "), "synthetic-device");
  for (const [header, target] of [["other-device", "synthetic-device"], ["", "synthetic-device"], ["synthetic-device", undefined], ["synthetic-device,other-device", "synthetic-device"], ["synthetic-device\r\n", "synthetic-device"]]) {
    assert.throws(() => assertedTikTokTarget(header, target), /Pinned device/);
  }
});

test("existing Bearer controller rejects wrong or unconfigured assertions before any async dispatch", async t => {
  const service = AutojsService.getInstance();
  const originalDispatch = service.dispatchTask;
  const originalInit = MqttService.getInstance().init;
  const originalTarget = process.env.AUTOJS6_CLIENT_ID;
  const originalToken = process.env.ONE_AUTOJS6_API_TOKEN;
  const calls: unknown[][] = [];
  service.dispatchTask = async (...args) => { calls.push(args); return { taskId, status: "EXECUTING", traceId: randomUUID(), expiresAtUtc: Date.now() + 420000 }; };
  MqttService.getInstance().init = () => { throw new Error("Controller test must not initialize a broker"); };
  process.env.AUTOJS6_CLIENT_ID = "synthetic-device";
  process.env.ONE_AUTOJS6_API_TOKEN = env.ONE_AUTOJS6_API_TOKEN;
  t.after(() => {
    service.dispatchTask = originalDispatch;
    MqttService.getInstance().init = originalInit;
    if (originalTarget === undefined) delete process.env.AUTOJS6_CLIENT_ID; else process.env.AUTOJS6_CLIENT_ID = originalTarget;
    if (originalToken === undefined) delete process.env.ONE_AUTOJS6_API_TOKEN; else process.env.ONE_AUTOJS6_API_TOKEN = originalToken;
  });
  const app = new Hono();
  app.use("/api/*", createApiAuthMiddleware());
  app.post("/api/tiktok/post", tiktokPost);
  const body = JSON.stringify({ contractVersion: 2, action: "preflight", publicationId });
  const headers = { Authorization: `Bearer ${env.ONE_AUTOJS6_API_TOKEN}`, "Content-Type": "application/json" };
  for (const assertion of ["other-device", "", "synthetic-device,other-device"]) {
    const response = await app.request("/api/tiktok/post", { method: "POST", headers: { ...headers, "X-Device-Assertion": assertion }, body });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, message: "Pinned device assertion does not match the configured PC target", data: {} });
  }
  assert.equal(calls.length, 0);
  delete process.env.AUTOJS6_CLIENT_ID;
  assert.equal((await app.request("/api/tiktok/post", { method: "POST", headers: { ...headers, "X-Device-Assertion": "synthetic-device" }, body })).status, 400);
  process.env.AUTOJS6_CLIENT_ID = "synthetic-device";
  const accepted = await app.request("/api/tiktok/post", { method: "POST", headers: { ...headers, "X-Device-Assertion": "synthetic-device" }, body });
  assert.equal(accepted.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], "synthetic-device");
  assert.equal((await accepted.json()).data.status, "EXECUTING");
  assert.equal((await app.request("/api/tiktok/post", { method: "POST", headers, body })).status, 200);
  assert.equal(calls[1][3], undefined);
  assert.equal((await app.request("/api/tiktok/post", { method: "POST", headers: { "X-Device-Assertion": "synthetic-device" }, body })).status, 401);
  assert.equal(calls.length, 2);
});

test("operator transport uses literal loopback, existing Bearer and pinned assertion, with redirects forbidden", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    if (String(url).endsWith("/api/config")) return envelope({ defaultClientId: "synthetic-device" });
    return envelope({ taskId, status: "EXECUTING", publicationId, action: "publish", contractVersion: 2 });
  };
  const transport = campaignHttpTransport("synthetic-device", { ...env, PC_BASE_URL: "https://untrusted.invalid" }, fakeFetch);
  assert.deepEqual(await transport.dispatch({ contractVersion: 2, action: "publish", publicationId }, "synthetic-device"), { taskId });
  assert.equal(calls[0].url, "http://127.0.0.1:3317/api/config");
  assert.equal(calls[1].url, "http://127.0.0.1:3317/api/tiktok/post");
  const headers = new Headers(calls[1].init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${env.ONE_AUTOJS6_API_TOKEN}`);
  assert.equal(headers.get("x-device-assertion"), "synthetic-device");
  assert.equal(calls[1].init.redirect, "error");
  await assert.rejects(transport.dispatch({ action: "publish" }, "other-device"), /pinned device/);
  assert.equal(calls.length, 2);
});

test("invalid operator ports, tokens and task paths cannot send a request", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; throw new Error("Unexpected HTTP call"); };
  for (const PORT of ["", "0", "03317", "65536", "3317/path", "http://example.test", "3317@untrusted.invalid"]) {
    assert.throws(() => campaignHttpTransport("synthetic-device", { ...env, PORT }, fakeFetch), /loopback PC/);
  }
  for (const ONE_AUTOJS6_API_TOKEN of ["", "short", "valid-length-token\r\nheader"]) {
    assert.throws(() => campaignHttpTransport("synthetic-device", { ...env, ONE_AUTOJS6_API_TOKEN }, fakeFetch), /loopback PC/);
  }
  const transport = campaignHttpTransport("synthetic-device", env, fakeFetch);
  await assert.rejects(transport.inspect("../../other-path"), /task receipt/);
  assert.equal(calls, 0);
});

test("a different or absent existing-PC default blocks delivery before POST", async () => {
  for (const defaultClientId of [undefined, "", "other-device"]) {
    const calls: string[] = [];
    const transport = campaignHttpTransport("synthetic-device", env, async url => { calls.push(String(url)); return envelope({ defaultClientId }); });
    await assert.rejects(transport.dispatch({ contractVersion: 2, action: "publish", publicationId }, "synthetic-device"), /does not match/);
    assert.deepEqual(calls, ["http://127.0.0.1:3317/api/config"]);
  }
});

test("fresh operator transport inspects the same existing PC receipt and refuses another device or script", async () => {
  const urls: string[] = [];
  let wrongBinding = false;
  const fakeFetch: typeof fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("x-device-assertion"), "synthetic-device");
    if (String(url).endsWith("/api/config")) return envelope({ defaultClientId: "synthetic-device" });
    return String(url).endsWith("/api/tiktok/post")
      ? envelope({ taskId, status: "EXECUTING", publicationId, action: "status", contractVersion: 2 })
      : envelope({ task: { taskId, clientId: wrongBinding ? "other-device" : "synthetic-device", scriptId: "tiktok.post", createTimeUtc: 12345, status: "SUCCESS" }, result: { publicationId } });
  };
  await campaignHttpTransport("synthetic-device", env, fakeFetch).dispatch({ contractVersion: 2, publicationId, action: "status" }, "synthetic-device");
  const result = await campaignHttpTransport("synthetic-device", env, fakeFetch).inspect(taskId);
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(result.result, { publicationId });
  assert.equal(urls[3], `http://127.0.0.1:3317/api/tasks/${taskId}`);
  wrongBinding = true;
  await assert.rejects(campaignHttpTransport("synthetic-device", env, fakeFetch).inspect(taskId), /not bound/);
});

test("malformed or rejected dispatch receipts cannot be treated as accepted", async () => {
  for (const data of [{ taskId }, { taskId, status: "SUCCESS", publicationId, action: "publish", contractVersion: 2 }, { taskId, status: "EXECUTING", publicationId: randomUUID(), action: "publish", contractVersion: 2 }]) {
    const transport = campaignHttpTransport("synthetic-device", env, async url => envelope(String(url).endsWith("/api/config") ? { defaultClientId: "synthetic-device" } : data));
    await assert.rejects(transport.dispatch({ publicationId, action: "publish", contractVersion: 2 }, "synthetic-device"), /invalid async task receipt/);
  }
  const transport = campaignHttpTransport("synthetic-device", env, async () => envelope({ error: "do-not-echo-private-payload" }, 400));
  await assert.rejects(transport.dispatch({ publicationId, action: "publish" }, "synthetic-device"), error => error instanceof Error && error.message === "Existing PC API did not accept the operator request");
});

test("filesystem-only operator review and approval need no API credentials, request or new MQTT session", async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "campaign-operator-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifest: CampaignManifest = { schemaVersion: 1, campaignId: "synthetic-operator", expectedHandle: "synthetic_shop", deviceClientId: "synthetic-device", timezone: "Asia/Shanghai", creatives: [] };
  for (let i = 0; i < 3; i++) {
    const videoPath = path.join(directory, `synthetic-${i}.mp4`);
    const bytes = `synthetic-video-${i}`;
    await fs.writeFile(videoPath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    manifest.creatives.push({ publicationId: randomUUID(), sku: `SHUSHA-L${1300 + i}`, videoPath, devicePath: `/sdcard/Download/synthetic-${sha256.slice(0, 16)}.mp4`, sha256,
      title: `Synthetic L${1300 + i}`, caption: "Synthetic approved caption", landingUrl: "https://shop.this-time.com/wholesale?utm_source=tiktok",
      sourceVerifiedAt: "2026-10-25T00:00:00.000Z", sourceEvidenceSha256: "a".repeat(64), scheduledAt: `2099-01-${String(10 + i * 2).padStart(2, "0")}T13:00:00.000Z`, postSettings: { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND" } });
  }
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  const originalInit = MqttService.getInstance().init;
  const originalDispatch = AutojsService.getInstance().dispatchTask;
  MqttService.getInstance().init = () => { throw new Error("Operator must not initialize MQTT"); };
  AutojsService.getInstance().dispatchTask = async () => { throw new Error("Operator must use existing PC process"); };
  t.after(() => { MqttService.getInstance().init = originalInit; AutojsService.getInstance().dispatchTask = originalDispatch; });
  const offline: typeof fetch = async () => { throw new Error("Filesystem command must not request HTTP"); };
  const output: string[] = [];
  await runCampaignCommand(["review", directory], {}, value => output.push(value), offline);
  await runCampaignCommand(["approve", directory, manifestDigest(manifest), "synthetic-reviewer"], {}, value => output.push(value), offline);
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "approval.json"), "utf8")).manifestSha256, manifestDigest(manifest));
  const originalId = manifest.creatives[0].publicationId;
  await fs.writeFile(path.join(directory, "ledger.json"), JSON.stringify([{ publicationId: originalId, manifestSha256: manifestDigest(manifest), state: "ACCEPTED", attemptedAt: new Date().toISOString(), taskId }]));
  const urls: string[] = [];
  const existingPc: typeof fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("x-device-assertion"), manifest.deviceClientId);
    if (String(url).endsWith("/api/config")) return envelope({ defaultClientId: manifest.deviceClientId });
    if (String(url).endsWith("/api/tiktok/post")) {
      const params = JSON.parse(String(init?.body));
      assert.equal(params.action, "status");
      assert.equal(params.publicationId, originalId);
      return envelope({ contractVersion: 2, taskId, action: "status", publicationId: originalId, status: "EXECUTING" });
    }
    return envelope({ task: { taskId, status: "EXECUTING", clientId: manifest.deviceClientId, scriptId: "tiktok.post", createTimeUtc: Date.now() }, result: null });
  };
  await runCampaignCommand(["status", directory, originalId], env, value => output.push(value), existingPc);
  await runCampaignCommand(["inspect", directory, originalId], env, value => output.push(value), existingPc);
  assert.deepEqual(urls, ["http://127.0.0.1:3317/api/config", "http://127.0.0.1:3317/api/tiktok/post", "http://127.0.0.1:3317/api/config", `http://127.0.0.1:3317/api/tasks/${taskId}`]);
  assert.equal(output.at(-1), "IN_PROGRESS");
});
