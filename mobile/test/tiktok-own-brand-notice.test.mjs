import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../task-scripts/tiktok_post_v2.js", import.meta.url), "utf8");
const entrypoint = source.lastIndexOf("\ntry {\n  action = normalizeAction(request);");
assert(entrypoint > 0);
const title = "内容公开设置已开启";
const body = "你的作品将被标记为“推广内容”。作品上线后将无法更改此标记。";
let passed = 0;

/** Exercise the real disclosure/notice functions using only synthetic accessibility boundaries. */
function fixture(options = {}) {
  let clock = 2000000000000;
  const state = { screen: "editor", disclose: false, own: false, branded: false,
    clicks: [], saves: 0, continues: 0, opens: 0, loadDelayMs: 0, ...options };
  let readyAt = clock;
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom,
    width: () => right - left, height: () => bottom - top,
    centerX: () => (left + right) / 2, centerY: () => (top + bottom) / 2 });
  /** Give every semantic node its actual ancestry, visible bounds and optional checked state. */
  function node(text, bounds, { children = [], className = "android.widget.TextView", checked, click, enabled = true } = {}) {
    const n = { text: () => text, desc: () => "", bounds: () => bounds,
      className: () => className, packageName: () => "com.zhiliaoapp.musically", visibleToUser: () => true,
      isEnabled: () => enabled, checkable: () => Boolean(checked), checked: () => checked?.() ?? false, selected: () => false,
      isClickable: () => Boolean(click), click: () => { if (!click || !enabled) return false; state.clicks.push(text); click(); return true; },
      parent: () => n.parentNode || null, childCount: () => children.length, child: index => children[index] };
    for (const child of children) child.parentNode = n;
    return n;
  }
  /** Open a fresh form; only the provider's saved choices may survive a later readback. */
  function openForm() {
    state.opens++;
    if (state.opens > 1 && state.dropSavedOwn) state.own = false;
    state.screen = "loading"; readyAt = clock + state.loadDelayMs;
  }
  /** Render the current provider screen, including the exact observed informational modal. */
  function tree() {
    if (state.screen === "loading" && clock >= readyAt) state.screen = "form";
    const full = rect(0, 0, 1080, 2340);
    if (state.screen === "loading") return node("", full);
    if (state.screen === "editor") return node("", full, { children: [
      node("", rect(30, 100, 1040, 300), { className: "android.widget.EditText" }),
      node("内容披露和广告", rect(30, 500, 1040, 560), { click: openForm }),
      node("Post", rect(700, 2100, 1040, 2200), { click: () => { throw Error("POST_MUST_NOT_BE_CLICKED"); } })] });
    const choices = [
      node("披露商业内容", rect(50, 300, 1030, 380), { className: "android.widget.Switch", checked: () => state.disclose, click: () => { state.disclose = !state.disclose; } }),
      node("你的品牌", rect(50, 500, 1030, 580), { className: "android.widget.CheckBox", checked: () => state.own, click: () => { state.own = !state.own; } }),
      node("品牌内容", rect(50, 680, 1030, 760), { className: "android.widget.CheckBox", checked: () => state.branded, click: () => { state.branded = !state.branded; } }),
      node("保存", rect(40, 2120, 1040, 2240), { click: () => { state.saves++; state.screen = state.noNotice ? "editor" : "notice"; } }),
    ];
    if (state.screen === "form") return node("", full, { children: choices });
    if (state.screen === "unknown") return node("", full, { children: [node("Continue", rect(500, 1200, 900, 1300), { click: () => { throw Error("UNKNOWN_CONTINUE_MUST_NOT_BE_CLICKED"); } })] });
    const h = node(state.wrongTitle ? "Different confirmation" : title, rect(230, 950, 850, 1030));
    const b = node(state.wrongBody ? "Different notice text" : body, rect(200, 1060, 880, 1170));
    const back = node("返回", rect(180, 1240, 535, 1350), { click: () => { throw Error("NOTICE_BACK_MUST_NOT_BE_CLICKED"); } });
    const proceed = node("继续", rect(540, 1240, 895, 1350), { enabled: !state.disabledContinue,
      click: () => { state.continues++; if (!state.persistNotice) state.screen = "form"; } });
    const textChildren = [h, b];
    const buttonChildren = [back, proceed];
    if (state.extraTerms) textChildren.push(node("Terms of Service apply", rect(200, 1180, 880, 1220)));
    if (state.duplicateContinue) buttonChildren.push(node("继续", rect(540, 1380, 895, 1440), { click: () => { throw Error("DUPLICATE_CONTINUE_MUST_NOT_BE_CLICKED"); } }));
    if (state.musicRights) textChildren.push(node("Music usage confirmation", rect(200, 1180, 880, 1220)));
    const modal = node("", rect(150, 900, 930, 1470), { children: state.splitParents ? textChildren : [...textChildren, ...buttonChildren] });
    const extra = state.splitParents ? [node("", rect(150, 1500, 930, 1700), { children: buttonChildren })] : [];
    return node("", full, { children: [...choices, modal, ...extra] });
  }
  /** Flatten only the current tree; nodes retain the parent relationships needed by production. */
  function flatten() {
    const nodes = [tree()];
    for (let i = 0; i < nodes.length; i++) for (let j = 0; j < nodes[i].childCount(); j++) nodes.push(nodes[i].child(j));
    return nodes;
  }
  /** Apply real package-scoped selector predicates rather than replacing any production handler. */
  function selector(packageValue) {
    const predicates = [n => n.packageName() === packageValue];
    const api = {
      textMatches: pattern => { const regex = new RegExp(pattern.replace(/^\(\?i\)/, ""), "i"); predicates.push(n => regex.test(n.text())); return api; },
      descMatches: pattern => { const regex = new RegExp(pattern.replace(/^\(\?i\)/, ""), "i"); predicates.push(n => regex.test(n.desc())); return api; },
      className: value => { predicates.push(n => n.className() === value); return api; },
      find: () => flatten().filter(n => predicates.every(p => p(n))),
      exists: () => flatten().some(n => predicates.every(p => p(n))),
      findOne: timeout => { const n = flatten().find(n => predicates.every(p => p(n))); if (!n) clock += Number(timeout || 1); return n || null; },
    }; return api;
  }
  const c = vm.createContext({ __AUTOJS_TASK_PARAMS__: {}, console: { log() {} },
    device: { width: 1080, height: 2340 }, Date: { now: () => clock }, random: minimum => minimum,
    sleep: ms => { clock += Math.max(1, Number(ms)); }, packageName: selector,
    currentPackage: () => state.wrongPackage || (state.wrongPackageAfterSave && state.saves) ? "synthetic.other" : "com.zhiliaoapp.musically",
    click: (x, y) => { const n = flatten().find(n => n.isClickable() && x >= n.bounds().left && x <= n.bounds().right && y >= n.bounds().top && y <= n.bounds().bottom); return n ? n.click() : false; },
    back: () => { if (state.screen !== "form") throw Error("UNKNOWN_SCREEN_MUST_NOT_BE_DISMISSED"); state.screen = "editor"; },
  });
  vm.runInContext(source.slice(0, entrypoint), c);
  c.requestedPostSettings = { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND" };
  return { c, state, now: () => clock };
}

/** Require a guarded failure without an informational Continue or Post action. */
function refusal(options, expectedCode = "COMMERCIAL_DISCLOSURE_NOT_VERIFIED") {
  const f = fixture(options);
  assert.throws(() => f.c.configureCommercialDisclosure(false), e => e.code === expectedCode);
  assert.equal(f.state.continues, 0); assert(!f.state.clicks.includes("Post")); return f;
}

const good = fixture(); good.c.configureCommercialDisclosure(false);
assert.equal(good.state.saves, 1); assert.equal(good.state.continues, 1); assert.equal(good.state.opens, 2); assert.equal(good.state.screen, "editor"); passed++;
const readonly = fixture({ disclose: true, own: true }); readonly.c.configureCommercialDisclosure(true);
assert.equal(readonly.state.saves, 0); assert.equal(readonly.state.continues, 0); assert.equal(readonly.state.opens, 1); passed++;
for (const field of ["disclose", "own", "branded"]) {
  const f = fixture({ disclose: true, own: true, [field]: field === "branded" });
  assert.throws(() => f.c.configureCommercialDisclosure(true), e => e.code === "COMMERCIAL_DISCLOSURE_NOT_VERIFIED");
  assert.equal(f.state.saves, 0); assert.equal(f.state.continues, 0); passed++;
}
refusal({ wrongTitle: true }); passed++;
refusal({ wrongBody: true }); passed++;
refusal({ extraTerms: true }); passed++;
refusal({ duplicateContinue: true }, "POST_SETTINGS_AMBIGUOUS"); passed++;
refusal({ splitParents: true }); passed++;
refusal({ disabledContinue: true }); passed++;
refusal({ wrongPackage: true }); passed++;
refusal({ wrongPackageAfterSave: true }); passed++;
refusal({ musicRights: true }, "RIGHTS_CONFIRMATION_REQUIRED"); passed++;
const stale = fixture({ dropSavedOwn: true }); assert.throws(() => stale.c.configureCommercialDisclosure(false), e => e.code === "COMMERCIAL_DISCLOSURE_NOT_VERIFIED"); assert.equal(stale.state.saves, 1); assert.equal(stale.state.continues, 1); assert.equal(stale.state.opens, 2); passed++;
const stuck = fixture({ persistNotice: true }); assert.throws(() => stuck.c.configureCommercialDisclosure(false), e => ["COMMERCIAL_DISCLOSURE_NOT_VERIFIED", "POST_SETTINGS_AMBIGUOUS"].includes(e.code)); assert.equal(stuck.state.continues, 1); assert.equal(stuck.state.saves, 1); passed++;
const unknown = fixture(); unknown.state.screen = "unknown"; assert.throws(() => unknown.c.confirmSavedOwnBrandNotice(true), e => e.code === "COMMERCIAL_DISCLOSURE_NOT_VERIFIED"); assert.equal(unknown.state.continues, 0); passed++;
const noOwnedSave = fixture(); noOwnedSave.state.screen = "notice"; assert.throws(() => noOwnedSave.c.confirmSavedOwnBrandNotice(false), e => e.code === "COMMERCIAL_DISCLOSURE_NOT_VERIFIED"); assert.equal(noOwnedSave.state.continues, 0); passed++;
const delayed = fixture({ loadDelayMs: 10000 }); const before = delayed.now(); delayed.c.configureCommercialDisclosure(false); assert(delayed.now() - before >= 20000); assert.equal(delayed.state.continues, 1); passed++;
const timeout = fixture({ loadDelayMs: 30000 }); const timeoutStart = timeout.now(); assert.throws(() => timeout.c.configureCommercialDisclosure(false), e => e.code === "COMMERCIAL_DISCLOSURE_NOT_VERIFIED"); assert.equal(timeout.state.saves, 0); assert.equal(timeout.state.continues, 0); assert(timeout.now() - timeoutStart < 18000); passed++;
const legacy = fixture({ noNotice: true }); legacy.c.configureCommercialDisclosure(false); assert.equal(legacy.state.saves, 1); assert.equal(legacy.state.continues, 0); assert.equal(legacy.state.opens, 2); passed++;
console.log(`${passed} real own-brand notice/form regressions passed; no device, account or provider was used.`);
