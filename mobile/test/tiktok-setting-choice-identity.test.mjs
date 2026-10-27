import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../task-scripts/tiktok_post_v2.js", import.meta.url), "utf8");
const entrypoint = source.lastIndexOf("\ntry {\n  action = normalizeAction(request);");
assert(entrypoint > 0);
let passed = 0;

/** Model the native checkable row plus noncheckable text child without copying private UI dumps. */
function fixture(options = {}) {
  let clock = 2000000000000;
  const state = { screen: "audience", chosen: "public", rowClicks: 0, doneClicks: 0, ...options };
  const rect = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b,
    width: () => r - l, height: () => b - t, centerX: () => (l + r) / 2, centerY: () => (t + b) / 2 });
  /** Build native-shaped semantic objects, including independent checked and visible properties. */
  function node(text, desc, box, { children = [], checkable = false, checked = () => false,
      className = "android.view.ViewGroup", visible = true, pkg = "com.zhiliaoapp.musically", click } = {}) {
    const n = { text: () => text, desc: () => desc, bounds: () => box,
      className: () => className, packageName: () => pkg,
      checkable: () => checkable, checked, selected: () => false, visibleToUser: () => visible,
      isEnabled: () => true, isClickable: () => Boolean(click),
      click: () => { if (!click) return false; click(); return true; },
      parent: () => n.parentNode || null, childCount: () => children.length, child: index => children[index] };
    for (const child of children) child.parentNode = n;
    return n;
  }
  /** Give each independent audience option its own checkable container and child label. */
  function row(label, identity, y, special = false) {
    const child = node(special && state.differentAlias ? "所有人" : label, "", rect(state.outsideBounds && special ? 750 : 140, y + 30, 900, y + 80), {
      className: "android.widget.TextView", checkable: Boolean(special && state.checkableChild), checked: () => false });
    const middle = special && state.nearestMismatch ? node("", "Different row", rect(80, y + 10, 950, y + 110), { checkable: true, checked: () => true, children: [child] }) : child;
    const container = node("", special && state.suffix ? label + ", selected" : label,
      rect(20, y, state.outsideBounds && special ? 700 : 1040, y + 130), {
        checkable: !(special && state.parentNotCheckable), visible: special && state.parentHidden ? false : special && state.visibilityUnknown ? null : true,
        pkg: special && state.wrongAncestorPackage ? "synthetic.other" : "com.zhiliaoapp.musically",
        checked: () => special && state.checkedUnknown ? undefined : state.chosen === identity,
        children: [middle], click: () => { state.rowClicks++; if (!state.doesNotStick) state.chosen = identity; },
      });
    return { container, child };
  }
  let lastPublic;
  /** Render either one editor entry or complete independent audience choices. */
  function tree() {
    const full = rect(0, 0, 1080, 2200);
    if (state.screen === "editor") return node("", "", full, { children: [
      node("", "", rect(30, 100, 1000, 300), { className: "android.widget.EditText" }),
      node("Who can view this post", "", rect(30, 500, 1000, 600), { click: () => { state.screen = "audience"; } }),
      node("Post", "", rect(600, 1950, 1000, 2080), { click: () => { throw Error("POST_MUST_NOT_BE_CLICKED"); } })] });
    const everyone = row("Everyone", "public", 300, true), friends = row("Friends", "friends", 500), only = row("Only you", "private", 700);
    lastPublic = everyone;
    const children = [everyone.container, friends.container, only.container,
      node("Done", "", rect(600, 1100, 1000, 1200), { click: () => { state.doneClicks++; state.screen = "editor"; } })];
    if (state.detachedChild) { everyone.container.childCount = () => 0; everyone.child.parentNode = null; children.push(everyone.child); }
    if (state.duplicatePublic) children.push(row("Everyone", "other-public", 900).container);
    if (state.duplicatePrivate) children.push(row("Only you", "other-private", 900).container);
    return node("", "", full, { children });
  }
  /** Keep ancestor pointers and both text/description matches from the same current synthetic tree. */
  let rendered = tree();
  function flatten() {
    rendered = tree(); const nodes = [rendered];
    for (let i = 0; i < nodes.length; i++) for (let j = 0; j < nodes[i].childCount(); j++) nodes.push(nodes[i].child(j));
    return nodes;
  }
  /** Use the real script's selector patterns and package filtering. */
  function selector(pkg) {
    const predicates = [n => n.packageName() === pkg];
    const api = {
      textMatches: p => { const regex = new RegExp(p.replace(/^\(\?i\)/, ""), "i"); predicates.push(n => regex.test(n.text())); return api; },
      descMatches: p => { const regex = new RegExp(p.replace(/^\(\?i\)/, ""), "i"); predicates.push(n => regex.test(n.desc())); return api; },
      className: v => { predicates.push(n => n.className() === v); return api; },
      find: () => flatten().filter(n => predicates.every(p => p(n))),
      exists: () => flatten().some(n => predicates.every(p => p(n))),
      findOne: timeout => { const n = flatten().find(n => predicates.every(p => p(n))); if (!n) clock += Number(timeout || 1); return n || null; },
    }; return api;
  }
  const c = vm.createContext({ __AUTOJS_TASK_PARAMS__: {}, console: { log() {} },
    Date: { now: () => clock }, sleep: ms => { clock += Math.max(1, Number(ms)); }, random: minimum => minimum,
    packageName: selector, currentPackage: () => "com.zhiliaoapp.musically",
    back: () => { state.screen = "editor"; },
    click: () => { throw Error("UNBOUND_COORDINATE_CLICK"); },
  });
  vm.runInContext(source.slice(0, entrypoint), c);
  return { c, state, publicPair: () => { tree(); return lastPublic; } };
}

const known = fixture();
const selected = known.c.findUniqueSettingNode(["Everyone"], 1);
assert.equal(selected.checkable(), true); assert.equal(selected.checked(), true); assert.equal(selected.bounds().left, 20); passed++;
const privateChoice = known.c.findUniqueSettingNode(["Only you"], 1);
assert.equal(privateChoice.checkable(), true); assert.equal(privateChoice.checked(), false); passed++;
const sameRow = fixture(); const { container, child } = sameRow.publicPair();
assert.equal(sameRow.c.canonicalSettingChoiceNode(child, ["Everyone"]), container); passed++;
for (const option of ["duplicatePublic", "parentNotCheckable", "nearestMismatch", "outsideBounds", "differentAlias", "checkableChild", "checkedUnknown", "visibilityUnknown", "detachedChild"]) {
  const f = fixture({ [option]: true });
  assert.throws(() => f.c.findUniqueSettingNode(["Everyone", "所有人"], 1), e => e.code === "POST_SETTINGS_AMBIGUOUS");
  assert.equal(f.state.rowClicks, 0); passed++;
}
const hidden = fixture({ parentHidden: true }); const hiddenPair = hidden.publicPair();
assert.equal(hidden.c.canonicalSettingChoiceNode(hiddenPair.child, ["Everyone"]), hiddenPair.child); passed++;
const otherPackage = fixture({ wrongAncestorPackage: true }); const otherPair = otherPackage.publicPair();
assert.equal(otherPackage.c.canonicalSettingChoiceNode(otherPair.child, ["Everyone"]), otherPair.child); passed++;
const suffix = fixture({ suffix: true }); assert.equal(suffix.c.findUniqueSettingNode(["Everyone"], 1).checkable(), true); passed++;
const readOnly = fixture({ screen: "editor" }); readOnly.c.configurePublicAudience(true);
assert.equal(readOnly.state.rowClicks, 0); assert.equal(readOnly.state.doneClicks, 1); assert.equal(readOnly.state.screen, "editor"); passed++;
const writable = fixture({ screen: "editor", chosen: "private" }); writable.c.configurePublicAudience(false);
assert.equal(writable.state.chosen, "public"); assert.equal(writable.state.rowClicks, 1); assert.equal(writable.state.doneClicks, 1); passed++;
const duplicate = fixture({ screen: "editor", duplicatePrivate: true });
assert.throws(() => duplicate.c.configurePublicAudience(false), e => e.code === "POST_SETTINGS_AMBIGUOUS"); assert.equal(duplicate.state.rowClicks, 0); assert.equal(duplicate.state.doneClicks, 0); passed++;
const refused = fixture({ screen: "editor", chosen: "private", doesNotStick: true });
assert.throws(() => refused.c.configurePublicAudience(false), e => e.code === "AUDIENCE_PUBLIC_UNAVAILABLE"); assert.equal(refused.state.doneClicks, 0); passed++;
console.log(`${passed} real setting-choice identity/audience regressions passed; no device or provider used.`);
