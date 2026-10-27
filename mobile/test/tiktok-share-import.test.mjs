import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";

const source = fs.readFileSync(new URL("../task-scripts/tiktok_post_v2.js", import.meta.url), "utf8");
const entrypoint = source.lastIndexOf("\ntry {\n  action = normalizeAction(request);");
assert(entrypoint > 0);
let passed = 0;

/** Run actual import/editor functions against a synthetic Android/accessibility boundary. */
function fixture(options = {}) {
  let clock = 2000000000000;
  const approved = Buffer.from("synthetic-approved-video");
  const disk = new Map([["/approved.mp4", approved]]);
  const state = { screen: "profile", clicks: [], intents: [], ...options };
  const bounds = (left, top, right, bottom) => ({ left, top, right, bottom,
    width: () => right - left, height: () => bottom - top,
    centerX: () => (left + right) / 2, centerY: () => (top + bottom) / 2 });
  /** Build semantic UiObjects; parent/child structure is independent of selector result order. */
  function node(text, rectangle, { children = [], className = "android.widget.TextView", click, visible = true, enabled = true } = {}) {
    const item = { text: () => text, desc: () => "", className: () => className,
      packageName: () => "com.zhiliaoapp.musically", visibleToUser: () => visible, isEnabled: () => enabled,
      bounds: () => rectangle, isClickable: () => Boolean(click),
      click: () => { if (!click || !enabled) return false; state.clicks.push(text); click(); return true; },
      childCount: () => children.length, child: i => children[i], parent: () => item.parentNode || null };
    for (const child of children) child.parentNode = item;
    return item;
  }
  /** Render the observed share-choice layout without using real accounts or material assets. */
  function tree() {
    const rootBounds = bounds(0, 0, 1080, 2340);
    if (state.screen === "caption") return node("", rootBounds, { children: [
      node("", bounds(30, 100, 1000, 300), { className: "android.widget.EditText" }),
      node("Post", bounds(650, 2150, 1000, 2250), { click: () => { throw Error("POST_MUST_NOT_BE_CLICKED"); } })] });
    if (state.screen === "preview") return node("", rootBounds, { children: [
      node("Next", bounds(800, 2150, 1000, 2250), { click: () => { state.screen = "caption"; } })] });
    if (state.screen === "feed") return node("", rootBounds, { children: [node("For You", bounds(200, 100, 400, 150))] });
    const header = node(state.unknownHeader ? "Unrecognized sharing screen" : "在 TikTok 上分享", bounds(360, 1340, 710, 1420));
    const video = node("视频", bounds(170, 2040, 440, 2140), { enabled: !state.disabledVideo,
      click: () => { if (!state.stuckShare) state.screen = "preview"; } });
    const messages = node("消息", bounds(640, 2040, 910, 2140), { click: () => { throw Error("MESSAGE_MUST_NOT_BE_CLICKED"); } });
    const children = [video, messages];
    if (state.duplicateVideo) children.push(node("视频", bounds(170, 1900, 440, 2000), { click: () => { throw Error("AMBIGUOUS_CLICK"); } }));
    if (state.hiddenDuplicate) children.push(node("视频", bounds(170, 1900, 440, 2000), { visible: false }));
    if (state.rightsPrompt) children.push(node("Music usage confirmation", bounds(10, 1600, 700, 1660)),
      node("Continue", bounds(10, 1680, 700, 1740), { click: () => { throw Error("RIGHTS_MUST_NOT_BE_ACCEPTED"); } }));
    if (!state.separateHeader) children.unshift(header);
    const sheet = node("", bounds(0, 1290, 1080, 2340), { children });
    const rootChildren = state.separateHeader ? [header, sheet] : [sheet];
    if (state.backgroundCaption) rootChildren.push(
      node("", bounds(30, 300, 1000, 500), { className: "android.widget.EditText" }),
      node("Post", bounds(650, 800, 1000, 900), { click: () => { throw Error("BACKGROUND_POST_MUST_NOT_BE_CLICKED"); } }));
    return node("", rootBounds, { children: rootChildren });
  }
  /** Flatten only the current visible tree for scoped accessibility selectors. */
  function flatten(root = tree()) {
    const all = [root]; for (let i = 0; i < all.length; i++) for (let n = 0; n < all[i].childCount(); n++) all.push(all[i].child(n));
    return all;
  }
  /** Apply real function selector expressions to the synthetic package-local UI. */
  function selector(packageValue) {
    const tests = [n => n.packageName() === packageValue];
    const api = {
      textMatches: p => { const regex = new RegExp(p.replace(/^\(\?i\)/, ""), "i"); tests.push(n => regex.test(n.text())); return api; },
      descMatches: p => { const regex = new RegExp(p.replace(/^\(\?i\)/, ""), "i"); tests.push(n => regex.test(n.desc())); return api; },
      className: value => { tests.push(n => n.className() === value); return api; },
      find: () => flatten().filter(n => tests.every(test => test(n))),
      exists: () => flatten().some(n => tests.every(test => test(n))),
      findOne: ms => { const result = flatten().find(n => tests.every(test => test(n))); if (!result) clock += Number(ms || 1); return result || null; },
    }; return api;
  }
  /** Read exact synthetic bytes through the same chunked Java stream API as production. */
  function File(file) { this.path = String(file); this.getCanonicalPath = () => this.path; this.length = () => disk.get(this.path)?.length || 0; this.isFile = () => disk.has(this.path); }
  function InputStream(file) {
    let offset = 0; const bytes = disk.get(file.path);
    this.read = buffer => { if (offset >= bytes.length) return -1; const part = bytes.subarray(offset, offset + buffer.length); buffer.set(part); offset += part.length; return part.length; };
    this.close = () => {};
  }
  /** Capture Android intent construction without opening any application. */
  function Intent(action) { this.action = action; this.extras = {}; this.setType = value => { this.type = value; }; this.putExtra = (k, value) => { this.extras[k] = value; }; this.setClipData = value => { this.clip = value; }; this.setPackage = value => { this.targetPackage = value; }; this.addFlags = value => { this.flags = value; }; }
  Object.assign(Intent, { ACTION_SEND: "synthetic.SEND", EXTRA_STREAM: "synthetic.STREAM", FLAG_ACTIVITY_NEW_TASK: 1, FLAG_GRANT_READ_URI_PERMISSION: 2 });
  const c = vm.createContext({
    __AUTOJS_TASK_PARAMS__: {}, console: { log() {} }, device: { width: 1080, height: 2340 },
    Date: { now: () => clock }, sleep: ms => { clock += Math.max(1, Number(ms)); }, random: minimum => minimum,
    packageName: selector, currentPackage: () => state.wrongPackage ? "synthetic.other" : "com.zhiliaoapp.musically",
    click: (x, y) => { const target = flatten().find(n => n.isClickable() && x >= n.bounds().left && x <= n.bounds().right && y >= n.bounds().top && y <= n.bounds().bottom); return target ? target.click() : false; },
    app: { startActivity: intent => { state.intents.push(intent); state.screen = state.importDropsToFeed ? "feed" : "share"; } },
    java: { io: { File, FileInputStream: InputStream },
      lang: { Byte: { TYPE: "byte" }, reflect: { Array: { newInstance: (_type, size) => new Uint8Array(size) } } },
      security: { MessageDigest: { getInstance: () => { const digest = crypto.createHash("sha256"); return { update: (bytes, offset, length) => digest.update(bytes.subarray(offset, offset + length)), digest: () => [...digest.digest()] }; } } } },
    android: { os: { StrictMode: { VmPolicy: { Builder: function () { this.build = () => ({}); } }, setVmPolicy() {} } },
      content: { Intent, ClipData: { newRawUri: (_name, uri) => uri }, ContentUris: { withAppendedId: (_collection, id) => "content://synthetic/" + id } },
      provider: { MediaStore: { Files: { getContentUri: () => "content://synthetic", FileColumns: { _ID: "_id" } }, MediaColumns: { DATA: "_data", SIZE: "_size" } } } },
    context: { getContentResolver: () => ({ query: (_uri, columns) => ({
      getCount: () => 1, moveToFirst: () => true,
      getString: () => state.wrongUri ? "/wrong.mp4" : "/approved.mp4",
      getLong: () => columns[0] === "_id" ? 123 : disk.get("/approved.mp4").length, close() {} }) }) },
  });
  vm.runInContext(source.slice(0, entrypoint), c);
  c.selectedMediaPath = "/approved.mp4"; c.selectedMediaType = "video";
  c.selectedExpectedSha256 = crypto.createHash("sha256").update(approved).digest("hex");
  return { c, state, disk };
}

/** Confirm a failed transition did not choose messages, Post, or any unrelated UI control. */
function held(options, expectedCode, beforeReach = () => {}) {
  const f = fixture(options); f.c.openSelectedMediaInTikTok(); beforeReach(f);
  assert.throws(() => f.c.reachCaptionEditor(), e => e.code === expectedCode);
  assert.equal(f.state.clicks.length, 0); return f;
}

const positive = fixture(); positive.c.openSelectedMediaInTikTok(); positive.c.reachCaptionEditor();
assert.deepEqual(positive.state.clicks, ["视频", "Next"]); assert.equal(positive.state.screen, "caption");
assert.equal(positive.state.intents.length, 1); assert.equal(positive.state.intents[0].type, "video/*");
assert.equal(positive.state.intents[0].targetPackage, "com.zhiliaoapp.musically"); passed++;
held({ unknownHeader: true }, "VIDEO_SHARE_CHOICE_UNVERIFIED"); passed++;
held({ duplicateVideo: true }, "VIDEO_SHARE_CHOICE_UNVERIFIED"); passed++;
held({ separateHeader: true }, "VIDEO_SHARE_CHOICE_UNVERIFIED"); passed++;
held({ disabledVideo: true }, "VIDEO_SHARE_CHOICE_UNVERIFIED"); passed++;
held({ wrongPackage: true }, "EDITOR_NOT_READY"); passed++;
held({}, "VIDEO_SHARE_MEDIA_UNVERIFIED", f => { f.c.selectedExpectedSha256 = ""; }); passed++;
held({}, "VIDEO_SHARE_MEDIA_UNVERIFIED", f => { f.c.selectedMediaType = "image"; }); passed++;
held({}, "VIDEO_SHARE_MEDIA_UNVERIFIED", f => { f.c.selectedShareIntentVerified = false; }); passed++;
held({}, "MEDIA_HASH_MISMATCH", f => { f.disk.set("/approved.mp4", Buffer.from("replaced after import")); }); passed++;
held({ rightsPrompt: true }, "RIGHTS_CONFIRMATION_REQUIRED"); passed++;
held({ importDropsToFeed: true }, "EDITOR_NOT_READY"); passed++;
const wrongUri = fixture({ wrongUri: true }); assert.throws(() => wrongUri.c.openSelectedMediaInTikTok(), e => e.code === "MEDIA_URI_IDENTITY_UNVERIFIED"); assert.equal(wrongUri.state.intents.length, 0); passed++;
const hidden = fixture({ hiddenDuplicate: true }); hidden.c.openSelectedMediaInTikTok(); hidden.c.reachCaptionEditor(); assert.deepEqual(hidden.state.clicks, ["视频", "Next"]); passed++;
const oldEditor = fixture(); oldEditor.state.screen = "preview"; oldEditor.c.reachCaptionEditor(); assert.deepEqual(oldEditor.state.clicks, ["Next"]); passed++;
const repeated = fixture({ stuckShare: true }); repeated.c.openSelectedMediaInTikTok(); assert.throws(() => repeated.c.reachCaptionEditor(), e => e.code === "VIDEO_SHARE_MEDIA_UNVERIFIED"); assert.deepEqual(repeated.state.clicks, ["视频"]); passed++;
const background = fixture({ backgroundCaption: true }); background.c.openSelectedMediaInTikTok(); background.c.reachCaptionEditor(); assert.deepEqual(background.state.clicks, ["视频", "Next"]); passed++;
held({ unknownHeader: true, backgroundCaption: true }, "VIDEO_SHARE_CHOICE_UNVERIFIED"); passed++;
console.log(`${passed} actual import/share-choice/editor regressions passed; no device or provider used.`);
