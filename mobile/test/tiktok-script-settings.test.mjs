import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";

const scriptUrl = new URL("../task-scripts/tiktok_post_v2.js", import.meta.url);
const source = fs.readFileSync(scriptUrl, "utf8");
const entrypoint = source.lastIndexOf("\ntry {\n  action = normalizeAction(request);");
assert(entrypoint > 0);
let passed = 0;

/** Run a script-level regression without Android, device, account or network access. */
function test(name, run) {
  run();
  passed++;
  console.log(`PASS ${name}`);
}

/** Create an isolated VM with a small explicit synthetic accessibility model. */
function fixture(options = {}) {
  const state = { screen: "editor", public: false, commercial: false, own: false, other: false, posts: 0, agreements: 0, ...options };
  let clock = 2000000000000;
  const disk = new Map([["/approved.mp4", Buffer.from("approved-video-byte-fixture")]]);
  const checkpoints = [];
  let resolverRow = { path: "/approved.mp4", size: disk.get("/approved.mp4").length };
  let nodeId = 0;
  /** Build a labelled synthetic UiObject whose checked state is explicit. */
  function node(text, y, { checked, click, className = "android.widget.TextView", desc = "", enabled = true, visible = true } = {}) {
    const identity = nodeId++;
    return {
      identity,
      text: () => text,
      desc: () => desc,
      className: () => className,
      checkable: () => typeof checked === "function",
      checked: () => checked?.() ?? false,
      selected: () => false,
      visibleToUser: () => visible,
      isEnabled: () => enabled,
      isClickable: () => Boolean(click),
      click: () => { if (!enabled || !click) return false; click(); return true; },
      bounds: () => ({ left: 20, top: y, right: 300, bottom: y + 36, width: () => 280, height: () => 36, centerX: () => 160, centerY: () => y + 18 }),
      childCount: () => 0,
      child: () => null,
      parent: () => null,
    };
  }
  /** Render only the visible synthetic screen; no hidden application state is queried. */
  function render() {
    if (state.overrideNodes) return state.overrideNodes;
    if (state.screen === "rights") return [node("Music usage confirmation", 20), node("Continue", 80, { click: () => state.agreements++ })];
    if (state.screen === "account-privacy") return [node("Switch to a public account", 20), node("Continue", 80, { click: () => state.agreements++ })];
    if (state.screen === "audience") {
      const rows = [
        node("Friends", 100, { checked: () => false, className: "android.widget.RadioButton" }),
        node("Only you", 150, { checked: () => !state.public, className: "android.widget.RadioButton" }),
        node("Done", 240, { click: () => { state.screen = "editor"; } }),
      ];
      if (!state.privateAccount) rows.push(node("Everyone", 50, {
        checked: state.unknownAudience ? undefined : () => state.public,
        className: state.unknownAudience ? "android.widget.TextView" : "android.widget.RadioButton",
        click: () => { state.public = true; if (state.autoCloseAudience) state.screen = "editor"; },
      }));
      return rows;
    }
    if (state.screen === "commercial") {
      const rows = [node("Disclose commercial content", 40, { checked: () => state.commercial, className: "android.widget.Switch", click: () => { state.commercial = !state.commercial; } })];
      if (state.commercial) rows.push(
        node("Your brand", 100, { checked: () => state.own, className: "android.widget.CheckBox", click: () => { if (!state.ownReadbackFails) state.own = !state.own; if (state.rightsDialog) state.screen = "rights"; } }),
        node("Branded content", 160, { checked: () => state.other, className: "android.widget.CheckBox", click: () => { state.other = !state.other; } }),
      );
      rows.push(node("Save", 250, { click: () => { state.screen = "editor"; } }));
      return rows;
    }
    return [
      node("Approved caption", 10, { className: "android.widget.EditText" }),
      node("Post", 600, { click: () => state.posts++ }),
      node(state.public ? "Everyone" : "Only you", 180, { click: () => { state.screen = state.privateAccountPrompt ? "account-privacy" : "audience"; } }),
      ...(state.noCommercialEntry ? [] : [node("Content disclosure and ads", 240, { click: () => { state.screen = "commercial"; } })]),
    ];
  }
  /** Implement only the selector operators exercised by the trusted functions under test. */
  function selector() {
    let predicate = () => true;
    const api = {
      textMatches: pattern => { const r = new RegExp(pattern.replace(/^\(\?i\)/, ""), "i"); predicate = n => r.test(n.text()); return api; },
      descMatches: pattern => { const r = new RegExp(pattern.replace(/^\(\?i\)/, ""), "i"); predicate = n => r.test(n.desc()); return api; },
      className: name => { predicate = n => n.className() === name; return api; },
      find: () => render().filter(predicate),
      exists: () => render().some(predicate),
      findOne: timeout => { const value = render().find(predicate); if (!value) clock += Number(timeout || 1); return value || null; },
    };
    return api;
  }
  /** Minimal Java File fixture; content remains synthetic and private to this VM. */
  function File(filePath) {
    this.path = String(filePath);
    this.length = () => disk.get(this.path)?.length || 0;
    this.isFile = () => disk.has(this.path);
    this.getCanonicalPath = () => this.path;
    this.getParent = () => "";
  }
  /** A deterministic input stream exercises the actual chunked digest loop. */
  function InputStream(file) {
    const bytes = disk.get(file.path);
    if (!bytes) throw new Error("missing synthetic file");
    let offset = 0;
    this.read = buffer => { if (offset >= bytes.length) return -1; const size = Math.min(buffer.length, bytes.length - offset); for (let i = 0; i < size; i++) buffer[i] = bytes[offset++]; return size; };
    this.close = () => {};
  }
  const context = vm.createContext({
    __AUTOJS_TASK_PARAMS__: {},
    console: { log() {} },
    Date: { now: () => clock },
    sleep: ms => { clock += Math.max(Number(ms), 1); },
    random: minimum => minimum,
    packageName: () => selector(),
    back: () => { state.screen = "editor"; },
    files: { exists: p => disk.has(p), ensureDir() {}, write: (p, text) => disk.set(p, Buffer.from(text)), read: p => disk.get(p)?.toString() || "" },
    java: {
      io: { File, FileInputStream: InputStream },
      lang: { Byte: { TYPE: "byte" }, reflect: { Array: { newInstance: (_type, size) => new Uint8Array(size) } } },
      security: { MessageDigest: { getInstance: () => { const d = crypto.createHash("sha256"); return { update: (buffer, offset, length) => d.update(buffer.slice(offset, offset + length)), digest: () => Array.from(d.digest(), n => n > 127 ? n - 256 : n) }; } } },
    },
    android: {
      provider: { MediaStore: { MediaColumns: { DATA: "_data", SIZE: "_size" } } },
      system: { Os: { rename: (from, to) => { disk.set(to, disk.get(from)); disk.delete(from); } } },
    },
    context: { getContentResolver: () => ({ query: () => resolverRow ? { getCount: () => 1, moveToFirst: () => true, getString: () => resolverRow.path, getLong: () => resolverRow.size, close() {} } : null }) },
    taskCheckpointPath: "/checkpoint",
  });
  vm.runInContext(source.slice(0, entrypoint), context, { filename: scriptUrl.pathname });
  context.requestedPostSettings = { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND" };
  return { context, state, disk, checkpoints, node, setResolver: value => { resolverRow = value; }, advance: ms => { clock += ms; } };
}

/** Keep the real publish ordering, hash checks and settings UI while replacing unrelated Android boundaries. */
function publishFixture(options = {}) {
  const f = fixture(options);
  const c = f.context;
  const trace = [];
  const snapshots = [];
  c.contractVersion = 2;
  c.publicationId = "frozen-publication-id";
  c.request = {
    expectedHandle: "approved-account",
    media: { path: "/approved.mp4", kind: "video", expectedSha256: crypto.createHash("sha256").update(f.disk.get("/approved.mp4")).digest("hex") },
    content: { caption: "Approved caption" },
    postSettings: { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND" },
  };
  c.launchTikTok = () => trace.push("launch");
  c.isOwnProfileGrid = () => true;
  c.dismissTransientDialogs = () => {};
  c.readProfileHandle = () => options.actualHandle || "approved-account";
  c.captureBaselinePostIds = () => ({ postIds: ["original-post"], tileCount: 1 });
  c.readSelectedMediaMetadata = () => ({ sizeBytes: f.disk.get("/approved.mp4").length, width: 1080, height: 1920, durationMs: 18000 });
  c.openSelectedMediaInTikTok = () => { c.assertSelectedMediaIntegrity(); trace.push("share-approved-file"); };
  c.reachCaptionEditor = () => trace.push("editor");
  c.enterAndVerifyCaption = () => { assert.equal(c.selectedCaption, "Approved caption"); trace.push("caption-verified"); };
  const write = c.writeCheckpoint;
  c.writeCheckpoint = (phase, extra) => { write(phase, extra); trace.push(phase); snapshots.push(JSON.parse(f.disk.get("/checkpoint").toString())); };
  c.waitForCheckpointAck = phase => { trace.push(`ACK:${phase}`); options.afterAck?.(phase, f); };
  c.clickSemanticCenterOnce = node => { trace.push("POST_CLICK"); return node.click(); };
  c.waitForSubmission = () => {};
  c.refreshProfileGrid = () => {};
  c.findPublicationPost = () => null;
  return { ...f, trace, snapshots };
}

test("legacy requests do not fabricate post settings or proof", () => {
  const { context: c } = fixture();
  assert.equal(c.normalizeRequestedPostSettings(undefined), null);
  c.requestedPostSettings = null;
  c.applyRequestedPostSettings(false);
  const result = c.buildResult("READY", false, true, "publish", null, null);
  assert.equal(Object.hasOwn(result, "postSettingsEvidence"), false);
});

test("settings accept only exact PUBLIC and YOUR_BRAND intent", () => {
  const { context: c } = fixture();
  for (const value of [null, [], { audience: "PUBLIC" }, { audience: "FRIENDS", commercialDisclosure: "YOUR_BRAND" }, { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND", extra: true }]) {
    assert.throws(() => c.normalizeRequestedPostSettings(value), e => e.code === "POST_SETTINGS_INVALID");
  }
});

test("commercial own-brand and public selections are read back", () => {
  const { context: c, state } = fixture({ other: true });
  c.applyRequestedPostSettings(false);
  assert.equal(state.public, true);
  assert.equal(state.commercial, true);
  assert.equal(state.own, true);
  assert.equal(state.other, false);
  assert.equal(c.postSettingsEvidence.verified, true);
  assert.equal(state.posts, 0);
  assert.equal(state.agreements, 0);
});

test("auto-closing audience picker is reopened for checked-state verification", () => {
  const { context: c, state } = fixture({ autoCloseAudience: true });
  c.applyRequestedPostSettings(false);
  assert.equal(state.public, true);
  assert.equal(c.postSettingsEvidence.audience, "PUBLIC");
});

test("a normal Everyone text label is not selection evidence", () => {
  const { context: c, state } = fixture({ unknownAudience: true });
  assert.throws(() => c.applyRequestedPostSettings(false), e => e.code === "AUDIENCE_PUBLIC_UNAVAILABLE");
  assert.equal(c.postSettingsEvidence, null);
  assert.equal(state.posts, 0);
});

test("private account without public audience stops without account privacy mutation", () => {
  const { context: c, state } = fixture({ privateAccount: true });
  assert.throws(() => c.applyRequestedPostSettings(false), e => e.code === "AUDIENCE_PUBLIC_UNAVAILABLE");
  assert.equal(state.public, false);
  assert.equal(state.posts, 0);
});

test("account-wide public-account confirmation is never accepted", () => {
  const { context: c, state } = fixture({ privateAccountPrompt: true });
  assert.throws(() => c.applyRequestedPostSettings(false), e => e.code === "ACCOUNT_PRIVACY_ACTION_REQUIRED");
  assert.equal(state.agreements, 0);
  assert.equal(state.posts, 0);
});

test("rights confirmation stops before accepting or committing", () => {
  const { context: c, state } = fixture({ rightsDialog: true });
  assert.throws(() => c.applyRequestedPostSettings(false), e => e.code === "RIGHTS_CONFIRMATION_REQUIRED");
  assert.equal(state.agreements, 0);
  assert.equal(state.posts, 0);
  assert.equal(c.postSettingsEvidence, null);
});

test("commercial selection that does not stick is refused", () => {
  const { context: c, state } = fixture({ ownReadbackFails: true });
  assert.throws(() => c.applyRequestedPostSettings(false), e => e.code === "COMMERCIAL_DISCLOSURE_NOT_VERIFIED");
  assert.equal(state.posts, 0);
  assert.equal(c.postSettingsEvidence, null);
});

test("missing commercial settings cannot produce proof", () => {
  const { context: c } = fixture({ noCommercialEntry: true });
  assert.throws(() => c.applyRequestedPostSettings(false), e => e.code === "COMMERCIAL_DISCLOSURE_NOT_VERIFIED");
  assert.equal(c.postSettingsEvidence, null);
});

test("precommit reread preserves the original frozen proof and timestamp", () => {
  const { context: c, advance } = fixture();
  c.applyRequestedPostSettings(false);
  const proof = c.postSettingsEvidence;
  const originalTimestamp = proof.verifiedAt;
  advance(5000);
  c.applyRequestedPostSettings(true);
  assert.equal(c.postSettingsEvidence, proof);
  assert.equal(c.postSettingsEvidence.verifiedAt, originalTimestamp);
});

test("precommit changed disclosure is not silently repaired", () => {
  const { context: c, state } = fixture();
  c.applyRequestedPostSettings(false);
  const proof = c.postSettingsEvidence;
  state.own = false;
  assert.throws(() => c.applyRequestedPostSettings(true), e => e.code === "COMMERCIAL_DISCLOSURE_NOT_VERIFIED");
  assert.equal(state.own, false);
  assert.equal(c.postSettingsEvidence, proof);
  assert.equal(state.posts, 0);
});

test("ambiguous labels and hidden duplicates are treated distinctly", () => {
  const f = fixture();
  f.state.overrideNodes = [f.node("Everyone", 20), f.node("Everyone", 80)];
  assert.throws(() => f.context.findUniqueSettingNode(["Everyone"], 1), e => e.code === "POST_SETTINGS_AMBIGUOUS");
  f.state.overrideNodes[1] = f.node("Everyone", 80, { visible: false });
  assert(f.context.findUniqueSettingNode(["Everyone"], 1));
});

test("ordinary selected=false text cannot impersonate a switch", () => {
  const f = fixture();
  assert.equal(f.context.directChoiceState(f.node("Your brand", 20)), null);
  assert.equal(f.context.directChoiceState(f.node("Your brand", 20, { checked: () => false })), false);
});

test("the actual chunked digest loop matches approved bytes and rejects substitution", () => {
  const { context: c, disk } = fixture();
  const expected = crypto.createHash("sha256").update(disk.get("/approved.mp4")).digest("hex");
  assert.equal(c.sha256SelectedFile("/approved.mp4"), expected);
  c.selectedMediaPath = "/approved.mp4";
  c.selectedExpectedSha256 = expected;
  c.assertSelectedMediaIntegrity();
  disk.set("/approved.mp4", Buffer.from("substituted video"));
  assert.throws(() => c.assertSelectedMediaIntegrity(), e => e.code === "MEDIA_HASH_MISMATCH");
});

test("a direct content URI must identify the approved file and byte size", () => {
  const { context: c, setResolver } = fixture();
  c.selectedMediaPath = "/approved.mp4";
  c.selectedExpectedSha256 = "a".repeat(64);
  c.verifySelectedMediaContentUri({});
  setResolver({ path: "/other.mp4", size: 1 });
  assert.throws(() => c.verifySelectedMediaContentUri({}), e => e.code === "MEDIA_URI_IDENTITY_UNVERIFIED");
  setResolver(null);
  assert.throws(() => c.verifySelectedMediaContentUri({}), e => e.code === "MEDIA_URI_IDENTITY_UNVERIFIED");
});

test("all checkpoints carry the same frozen UI evidence", () => {
  const { context: c, disk } = fixture();
  c.applyRequestedPostSettings(false);
  for (const phase of ["EDITOR_READY", "COMMITTING", "SUBMITTED"]) {
    c.writeCheckpoint(phase, null);
    const data = JSON.parse(disk.get("/checkpoint").toString());
    assert.deepEqual(data.postSettingsEvidence, JSON.parse(JSON.stringify(c.postSettingsEvidence)));
  }
});

test("recovery only preserves original evidence and never verifies settings anew", () => {
  const { context: c, state } = fixture();
  const proof = { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND", verified: true, verifiedAt: 1000 };
  c.publicationId = "original-id";
  c.request = { recoveryContext: { publicationId: "original-id", title: "Original caption", postSettings: { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND" }, postSettingsEvidence: proof } };
  c.loadRecoveryContext();
  assert.equal(c.postSettingsEvidence, proof);
  assert.equal(state.public, false);
  assert.equal(state.commercial, false);
  assert.equal(c.buildResult("FOUND", true, false, "none", null, null).postSettingsEvidence, proof);
  c.request = { recoveryContext: { publicationId: "original-id", title: "Legacy caption" } };
  c.loadRecoveryContext();
  assert.equal(c.postSettingsEvidence, null);
});

test("invalid, future or context-free historical evidence is rejected", () => {
  const { context: c } = fixture();
  for (const value of [{ audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND", verified: true, verifiedAt: 3e15 }, { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND", verified: false, verifiedAt: 1000 }]) {
    assert.throws(() => c.validatedPostSettingsEvidence(value), e => e.code === "POST_SETTINGS_NOT_VERIFIED");
  }
  c.publicationId = "original-id";
  c.request = { recoveryContext: { publicationId: "original-id", title: "Caption", postSettingsEvidence: { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND", verified: true, verifiedAt: 1000 } } };
  assert.throws(() => c.loadRecoveryContext(), e => e.code === "POST_SETTINGS_NOT_VERIFIED");
});

test("publish blocks missing disclosure before EDITOR_READY and before COMMITTING", () => {
  const f = publishFixture({ noCommercialEntry: true });
  assert.throws(() => f.context.runPublish(), e => e.code === "COMMERCIAL_DISCLOSURE_NOT_VERIFIED");
  assert.equal(f.state.posts, 0);
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.trace.includes("POST_CLICK"), false);
});

test("publish rejects a changed disclosure after editor ACK without entering COMMITTING", () => {
  const f = publishFixture({ afterAck: (phase, fixture) => { if (phase === "EDITOR_READY") fixture.state.own = false; } });
  assert.throws(() => f.context.runPublish(), e => e.code === "COMMERCIAL_DISCLOSURE_NOT_VERIFIED");
  assert.deepEqual(f.snapshots.map(s => s.phase), ["EDITOR_READY"]);
  assert.equal(f.state.posts, 0);
  assert.equal(f.context.submitted, false);
});

test("publish rejects replaced bytes after editor ACK without entering COMMITTING", () => {
  const f = publishFixture({ afterAck: (phase, fixture) => { if (phase === "EDITOR_READY") fixture.disk.set("/approved.mp4", Buffer.from("different-style-after-approval")); } });
  assert.throws(() => f.context.runPublish(), e => e.code === "MEDIA_HASH_MISMATCH");
  assert.deepEqual(f.snapshots.map(s => s.phase), ["EDITOR_READY"]);
  assert.equal(f.state.posts, 0);
  assert.equal(f.context.submitted, false);
});

test("wrong-account publish never reaches the editor or settings", () => {
  const f = publishFixture({ actualHandle: "wrong-account" });
  assert.throws(() => f.context.runPublish(), e => e.code === "ACCOUNT_MISMATCH");
  assert.equal(f.trace.includes("share-approved-file"), false);
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.state.public, false);
});

test("publish commits once only after both ACKs and carries the same original proof into an unknown result", () => {
  const f = publishFixture();
  f.context.runPublish();
  assert.deepEqual(f.snapshots.map(s => s.phase), ["EDITOR_READY", "COMMITTING", "SUBMITTED"]);
  assert.equal(f.state.posts, 1);
  assert.equal(f.trace.filter(event => event === "POST_CLICK").length, 1);
  assert(f.trace.indexOf("ACK:COMMITTING") < f.trace.indexOf("POST_CLICK"));
  assert.deepEqual(f.snapshots[1].postSettingsEvidence, f.snapshots[0].postSettingsEvidence);
  assert.deepEqual(f.snapshots[2].postSettingsEvidence, f.snapshots[0].postSettingsEvidence);
  const result = JSON.parse(f.context.taskResult);
  assert.deepEqual(result.postSettingsEvidence, f.snapshots[0].postSettingsEvidence);
  assert.equal(result.retrySafe, false);
  assert.equal(result.nextAction, "recover");
  assert.equal(result.published, false);
});

console.log(`${passed} trusted-script settings regressions passed; no device or account was accessed.`);
