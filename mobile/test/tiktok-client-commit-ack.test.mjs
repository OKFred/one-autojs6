import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript");

/** Find one actual TypeScript source node without importing the network-starting client. */
function findNode(source, predicate) {
  let found;
  const visit = node => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
  visit(source);
  assert(found);
  return found.getText(source);
}

const clientText = fs.readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
const client = ts.createSourceFile("client.ts", clientText, ts.ScriptTarget.Latest, true);
const gateText = fs.readFileSync(new URL("../src/tiktok-commit-ack.ts", import.meta.url), "utf8");
const gate = ts.createSourceFile("gate.ts", gateText, ts.ScriptTarget.Latest, true);
const review = findNode(client, node => ts.isFunctionDeclaration(node) && node.name?.text === "reviewTikTokCommittingCheckpoint");
const timeout = findNode(gate, node => ts.isFunctionDeclaration(node) && node.name?.text === "tikTokCommitReviewTimeoutMs").replace(/^export\s+/, "");
let poll;
/** Locate the real executeTask interval callback and retain its complete ACK ordering. */
function findPoll(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(client) === "pollInterval" && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(client) === "setInterval") poll = node.initializer.arguments[0].getText(client);
  ts.forEachChild(node, findPoll);
}
findPoll(client); assert(poll);
const executable = ts.transpileModule(`${review}\n${timeout}\nglobalThis.poll = ${poll};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
let passed = 0;

/** Run a deterministic regression against the actual client ACK callback with synthetic boundaries. */
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

/** Construct a private in-memory checkpoint, record and deferred operator boundary. */
function fixture({ phase = "COMMITTING", enabled = true } = {}) {
  const trace = [];
  const writes = [];
  let resolve, reject, calls = 0, captured;
  const approval = new Promise((done, fail) => { resolve = done; reject = fail; });
  const proof = { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND", verified: true, verifiedAt: Date.now() - 1000 };
  const record = { publicationId: "synthetic-publication-001", phase: "EDITOR_READY", media: { fingerprint: "a".repeat(64), expectedSha256: "a".repeat(64) }, caption: { title: "Approved title", details: "Approved details" }, postSettings: { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND" }, postSettingsEvidence: proof };
  const checkpoint = { phase, publicationId: record.publicationId, timestamp: Date.now(), checkpointNonce: "1bfc9614-cac0-4c64-8bcc-a4d7fb66c7dc", postSettingsEvidence: proof };
  const disk = new Map([["/checkpoint", JSON.stringify(checkpoint)]]);
  const task = { request: { taskId: "synthetic-task-001" }, deadlineAt: Date.now() + 420000, checkpointPhase: "EDITOR_READY", checkpointFilePath: "/checkpoint", sideEffectCommitted: false,
    tiktok: { request: { action: "publish", publicationId: record.publicationId }, publication: record, ledger: { get: () => record } } };
  const context = vm.createContext({
    crypto, AbortController, Date, console: { warn: () => trace.push("held") },
    activeTask: task, request: task.request, checkpointPath: "/checkpoint", checkpointAckPath: "/ack", resultPath: "/result", firstResultSeenAt: 0, stateDirectory: "/synthetic-private-state",
    config: { tiktok: { commitReview: { required: enabled, timeoutSeconds: 180 } } },
    fs: { existsSync: key => disk.has(key), readFileSync: key => disk.get(key), writeFileSync: (key, value) => { disk.set(key, value); writes.push({ key, value }); trace.push("ACK:" + value); } },
    isRecord: value => value && typeof value === "object" && !Array.isArray(value),
    applyTikTokPublicationCheckpoint: () => { trace.push("persist-proof"); },
    markTikTokPublicationPhase: (_prepared, value) => { record.phase = value; trace.push("persist:" + value); },
    tikTokPostSettingsSummary: () => ({ postSettingsEvidence: proof }),
    TikTokCommitAckGate: class { wait(bound, options) { captured = { bound, options }; calls++; trace.push("review"); return approval; } },
  });
  vm.runInContext(executable, context);
  return { context, checkpoint, disk, task, record, trace, writes, resolve, reject, calls: () => calls, captured: () => captured };
}

await test("actual client persists immutable COMMITTING first and emits no ACK while the same draft waits", async () => {
  const f = fixture();
  const pending = f.context.poll();
  await Promise.resolve();
  assert.deepEqual(f.trace, ["persist-proof", "persist:COMMITTING", "review"]);
  assert.equal(f.writes.length, 0);
  await f.context.poll();
  assert.equal(f.calls(), 1);
  assert.equal(f.captured().bound.phase, "COMMITTING");
  assert.equal(f.captured().bound.checkpointNonce, f.checkpoint.checkpointNonce);
  assert.equal(f.captured().bound.mediaSha256, "a".repeat(64));
  assert.equal(f.captured().bound.captionSha256, crypto.createHash("sha256").update(JSON.stringify({ title: "Approved title", details: "Approved details" })).digest("hex"));
  f.resolve({ status: "APPROVED" });
  await pending;
  assert.deepEqual(f.writes, [{ key: "/ack", value: "COMMITTING" }]);
});

await test("actual client rejects invalid or expired release without ACK or another review wait", async () => {
  for (const code of ["COMMIT_REVIEW_INVALID_RELEASE", "COMMIT_REVIEW_TIMEOUT"]) {
    const f = fixture();
    const pending = f.context.poll();
    f.reject(new Error(code)); await pending;
    await f.context.poll();
    assert.equal(f.writes.length, 0);
    assert.equal(f.calls(), 1);
    assert.equal(f.task.commitReviewRejected, true);
  }
});

await test("changed checkpoint or cancelled current task after review cannot receive a stale ACK", async () => {
  for (const change of ["nonce", "task"]) {
    const f = fixture();
    const pending = f.context.poll();
    if (change === "nonce") f.disk.set("/checkpoint", JSON.stringify({ ...f.checkpoint, checkpointNonce: "901d7ac0-9fc9-4c17-bcc7-bef13c16fd12" }));
    else f.context.activeTask = null;
    f.resolve({ status: "APPROVED" }); await pending;
    assert.equal(f.writes.length, 0);
  }
});

await test("EDITOR_READY remains persistence-only and disabled legacy jobs keep their original ACK", async () => {
  for (const options of [{ phase: "EDITOR_READY", enabled: true }, { phase: "COMMITTING", enabled: false }]) {
    const f = fixture(options);
    await f.context.poll();
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.writes, [{ key: "/ack", value: options.phase }]);
  }
});

console.log(`${passed} actual-client ACK regressions passed; no client process, broker, phone or UI was started.`);
