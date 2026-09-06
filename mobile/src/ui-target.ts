/** Maximum Android UI hierarchy accepted by the local parser. */
export const OPS_MAX_UI_HIERARCHY_BYTES = 1024 * 1024;

/** Maximum number of UI nodes accepted from one hierarchy dump. */
export const OPS_MAX_UI_NODES = 10_000;

/** Maximum supported Android UI hierarchy nesting depth. */
export const OPS_MAX_UI_DEPTH = 256;

/** Maximum text or content-description length accepted from one UI node. */
export const OPS_MAX_UI_TEXT_LENGTH = 4 * 1024;

/** Maximum non-text attribute length accepted from one UI node. */
const OPS_MAX_UI_ATTRIBUTE_LENGTH = 8 * 1024;

/** Explicitly reviewed generic UI labels that are safe to cross the device boundary. */
const REVIEWED_PUBLIC_UI_LABELS = new Set([
  "add",
  "allow",
  "back",
  "cancel",
  "close",
  "continue",
  "delete",
  "deny",
  "done",
  "edit",
  "home",
  "log in",
  "messages",
  "more",
  "new",
  "next",
  "ok",
  "open",
  "previous",
  "publish",
  "retry",
  "save",
  "search",
  "send",
  "share",
  "sign in",
  "sms",
  "上一步",
  "下一步",
  "主页",
  "主屏幕",
  "允许",
  "信息",
  "保存",
  "关闭",
  "分享",
  "删除",
  "发送",
  "发布",
  "取消",
  "完成",
  "打开",
  "拒绝",
  "新建",
  "更多",
  "消息",
  "添加",
  "短信",
  "确定",
  "继续",
  "编辑",
  "返回",
  "重试",
]);

/** Coordinates supplied by a remote-control recording. */
export interface DeviceUiTargetAtParams {
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
}

/** Privacy-classified text returned for one UI node. */
export type DeviceUiClassifiedText =
  | { mode: "literal"; value: string; reviewed: true }
  | { mode: "parameter"; key: string }
  | { mode: "redacted"; category: string; length: number };

/** Bounded target bounds in current Android display coordinates. */
export interface DeviceUiTargetBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  screenWidth: number;
  screenHeight: number;
}

/** One privacy-safe UI target selected from an Android hierarchy. */
export interface DeviceUiTarget {
  source: "android-uiautomator";
  confidence: "exact-resource-id" | "composite" | "heuristic";
  packageName: string | null;
  activityName: string | null;
  className: string;
  resourceId?: string;
  text?: DeviceUiClassifiedText;
  description?: DeviceUiClassifiedText;
  bounds: DeviceUiTargetBounds;
  clickable: boolean;
  editable: boolean;
}

/** Foreground Android component captured beside a UI hierarchy. */
export interface DeviceUiForeground {
  packageName: string | null;
  activityName: string | null;
}

/** Result of one read-only target-at query. */
export interface DeviceUiTargetAtResult {
  target: DeviceUiTarget | null;
  foreground: DeviceUiForeground;
  display: { width: number; height: number };
  capturedAt: number;
}

/** Internal integer rectangle parsed from one Android bounds attribute. */
interface UiBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Internal node retained while parsing the complete hierarchy. */
interface UiNode {
  attributes: Record<string, string>;
  bounds: UiBounds | null;
  parent: UiNode | null;
  depth: number;
  order: number;
}

/** Internal XML stack frame used to validate matching element tags. */
interface XmlFrame {
  name: string;
  node: UiNode | null;
}

/** Parsed hierarchy metadata and every bounded node. */
interface UiHierarchy {
  nodes: UiNode[];
  rotation: number;
}

/** Actionable node plus the deepest-to-actionable semantic path. */
interface UiTargetSelection {
  node: UiNode & { bounds: UiBounds };
  semanticPath: UiNode[];
}

/** Parsed foreground data including the legacy window label. */
export interface AndroidForegroundSnapshot extends DeviceUiForeground {
  windowTitle: string | null;
}

/** Return whether one character is valid in an XML name. */
function isXmlNameCharacter(value: string): boolean {
  return /^[A-Za-z0-9_.:-]$/.test(value);
}

/** Decode the predefined and numeric entities emitted by uiautomator. */
function decodeXmlAttribute(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_match, entity: string) => {
      if (entity === "amp") return "&";
      if (entity === "lt") return "<";
      if (entity === "gt") return ">";
      if (entity === "quot") return '"';
      if (entity === "apos") return "'";
      const radix = entity.toLowerCase().startsWith("#x") ? 16 : 10;
      const digits = entity.slice(radix === 16 ? 2 : 1);
      const codePoint = Number.parseInt(digits, radix);
      if (
        !Number.isInteger(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        throw new Error("Android UI hierarchy contains an invalid XML entity");
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

/** Locate an XML tag end while respecting quoted attribute values. */
function findXmlTagEnd(xml: string, start: number): number {
  let quote = "";
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  throw new Error("Android UI hierarchy contains an unterminated XML tag");
}

/** Parse one start tag and reject duplicate or malformed attributes. */
function parseXmlStartTag(raw: string): {
  name: string;
  attributes: Record<string, string>;
  selfClosing: boolean;
} {
  let value = raw.trim();
  const selfClosing = value.endsWith("/");
  if (selfClosing) value = value.slice(0, -1).trimEnd();
  let offset = 0;
  while (offset < value.length && isXmlNameCharacter(value[offset])) offset += 1;
  const name = value.slice(0, offset);
  if (!name) throw new Error("Android UI hierarchy contains an invalid XML tag");
  const attributes: Record<string, string> = {};
  while (offset < value.length) {
    while (offset < value.length && /\s/.test(value[offset])) offset += 1;
    if (offset >= value.length) break;
    const nameStart = offset;
    while (offset < value.length && isXmlNameCharacter(value[offset])) offset += 1;
    const attributeName = value.slice(nameStart, offset);
    if (!attributeName || Object.prototype.hasOwnProperty.call(attributes, attributeName)) {
      throw new Error("Android UI hierarchy contains an invalid XML attribute");
    }
    while (offset < value.length && /\s/.test(value[offset])) offset += 1;
    if (value[offset] !== "=") {
      throw new Error("Android UI hierarchy contains an invalid XML attribute");
    }
    offset += 1;
    while (offset < value.length && /\s/.test(value[offset])) offset += 1;
    const quote = value[offset];
    if (quote !== '"' && quote !== "'") {
      throw new Error("Android UI hierarchy contains an unquoted XML attribute");
    }
    offset += 1;
    const attributeStart = offset;
    while (offset < value.length && value[offset] !== quote) offset += 1;
    if (offset >= value.length) {
      throw new Error("Android UI hierarchy contains an unterminated XML attribute");
    }
    const decoded = decodeXmlAttribute(
      value.slice(attributeStart, offset),
    );
    const maximumLength =
      attributeName === "text" || attributeName === "content-desc"
        ? OPS_MAX_UI_TEXT_LENGTH
        : OPS_MAX_UI_ATTRIBUTE_LENGTH;
    if (
      decoded.length > maximumLength ||
      Buffer.byteLength(decoded, "utf8") > maximumLength * 4
    ) {
      throw new Error("Android UI hierarchy contains an oversized XML attribute");
    }
    attributes[attributeName] = decoded;
    offset += 1;
  }
  return { name, attributes, selfClosing };
}

/** Parse one Android bounds attribute into a positive-area rectangle. */
function parseUiBounds(value: string | undefined): UiBounds | null {
  if (!value) return null;
  const matched = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value);
  if (!matched) return null;
  const [left, top, right, bottom] = matched.slice(1).map(Number);
  if (
    ![left, top, right, bottom].every(Number.isSafeInteger) ||
    right <= left ||
    bottom <= top
  ) {
    return null;
  }
  return { left, top, right, bottom };
}

/** Extract only the hierarchy document from bounded uiautomator stdout. */
function extractHierarchyXml(output: string): string {
  if (Buffer.byteLength(output, "utf8") > OPS_MAX_UI_HIERARCHY_BYTES) {
    throw new Error("Android UI hierarchy exceeded the parser limit");
  }
  const start = output.indexOf("<hierarchy");
  const closingTag = "</hierarchy>";
  const end = output.lastIndexOf(closingTag);
  if (start < 0 || end < start) {
    throw new Error("Android UI hierarchy XML was not returned");
  }
  return output.slice(start, end + closingTag.length);
}

/** Parse and validate the complete Android hierarchy without retaining XML text. */
function parseUiHierarchy(output: string): UiHierarchy {
  const xml = extractHierarchyXml(output);
  const nodes: UiNode[] = [];
  const stack: XmlFrame[] = [];
  let rotation = 0;
  let hierarchySeen = false;
  let offset = 0;
  while (offset < xml.length) {
    const tagStart = xml.indexOf("<", offset);
    if (tagStart < 0) {
      if (xml.slice(offset).trim()) {
        throw new Error("Android UI hierarchy contains unexpected text");
      }
      break;
    }
    if (xml.slice(offset, tagStart).trim()) {
      throw new Error("Android UI hierarchy contains unexpected text");
    }
    if (xml.startsWith("<!--", tagStart)) {
      const commentEnd = xml.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) {
        throw new Error("Android UI hierarchy contains an unterminated comment");
      }
      offset = commentEnd + 3;
      continue;
    }
    if (xml.startsWith("<?", tagStart)) {
      const declarationEnd = xml.indexOf("?>", tagStart + 2);
      if (declarationEnd < 0) {
        throw new Error("Android UI hierarchy contains an invalid declaration");
      }
      offset = declarationEnd + 2;
      continue;
    }
    if (xml.startsWith("<!", tagStart)) {
      throw new Error("Android UI hierarchy declarations are not allowed");
    }
    const tagEnd = findXmlTagEnd(xml, tagStart + 1);
    const rawTag = xml.slice(tagStart + 1, tagEnd).trim();
    if (rawTag.startsWith("/")) {
      const closeName = rawTag.slice(1).trim();
      if (!closeName || ![...closeName].every(isXmlNameCharacter)) {
        throw new Error("Android UI hierarchy contains an invalid closing tag");
      }
      const frame = stack.pop();
      if (!frame || frame.name !== closeName) {
        throw new Error("Android UI hierarchy contains mismatched XML tags");
      }
      offset = tagEnd + 1;
      continue;
    }
    const parsed = parseXmlStartTag(rawTag);
    if (parsed.name !== "hierarchy" && parsed.name !== "node") {
      throw new Error("Android UI hierarchy contains an unsupported element");
    }
    if (parsed.name === "hierarchy") {
      if (hierarchySeen || stack.length !== 0) {
        throw new Error("Android UI hierarchy contains multiple roots");
      }
      hierarchySeen = true;
      const parsedRotation = Number(parsed.attributes.rotation || "0");
      rotation = Number.isInteger(parsedRotation) ? parsedRotation : 0;
    } else {
      if (!hierarchySeen || stack.length === 0) {
        throw new Error("Android UI node is outside the hierarchy root");
      }
      if (nodes.length >= OPS_MAX_UI_NODES || stack.length > OPS_MAX_UI_DEPTH) {
        throw new Error("Android UI hierarchy exceeded its structural limit");
      }
      const parent = [...stack].reverse().find((frame) => frame.node)?.node || null;
      const node: UiNode = {
        attributes: parsed.attributes,
        bounds: parseUiBounds(parsed.attributes.bounds),
        parent,
        depth: stack.length,
        order: nodes.length,
      };
      nodes.push(node);
      if (!parsed.selfClosing) stack.push({ name: parsed.name, node });
      offset = tagEnd + 1;
      continue;
    }
    if (!parsed.selfClosing) stack.push({ name: parsed.name, node: null });
    offset = tagEnd + 1;
  }
  if (!hierarchySeen || stack.length !== 0) {
    throw new Error("Android UI hierarchy XML is incomplete");
  }
  return { nodes, rotation };
}

/** Parse Android activity and window dumps into one foreground component. */
export function parseAndroidForeground(
  activity: string,
  windows: string,
): AndroidForegroundSnapshot {
  const resumed =
    /(?:topResumedActivity=|ResumedActivity:\s+)ActivityRecord\{[^}]*\su\d+\s+([A-Za-z0-9._]+)\/([^\s}]+)/.exec(
      activity,
    ) || /mResumedActivity:.*?\s([A-Za-z0-9._]+)\/([^\s}]+)/.exec(activity);
  const focused = /mCurrentFocus=.*?\s([A-Za-z0-9._]+)\/([^\s}]+)/.exec(
    windows,
  );
  const packageName = resumed?.[1] || focused?.[1] || null;
  const rawActivityName = resumed?.[2] || focused?.[2] || null;
  const activityName =
    packageName && rawActivityName?.startsWith(".")
      ? `${packageName}${rawActivityName}`
      : packageName && rawActivityName && !rawActivityName.includes(".")
        ? `${packageName}.${rawActivityName}`
        : rawActivityName;
  return {
    packageName,
    activityName,
    windowTitle:
      /mCurrentFocus=Window\{[^}]*\s([^}]+)\}/.exec(windows)?.[1] || null,
  };
}

/** Parse current Android display dimensions, honoring an override and rotation. */
function parseDisplaySize(
  wmSize: string,
  rotation: number,
  fallbackWidth: number,
  fallbackHeight: number,
): { width: number; height: number } {
  const matches = [
    ...wmSize.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/gi),
  ];
  const selected = matches[matches.length - 1];
  let width = selected ? Number(selected[1]) : fallbackWidth;
  let height = selected ? Number(selected[2]) : fallbackHeight;
  if (Math.abs(rotation) % 2 === 1) [width, height] = [height, width];
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16_384 ||
    height > 16_384
  ) {
    return { width: fallbackWidth, height: fallbackHeight };
  }
  return { width, height };
}

/** Return whether one hierarchy node is visible and has usable bounds. */
function isVisibleNode(node: UiNode): node is UiNode & { bounds: UiBounds } {
  return Boolean(
    node.bounds &&
      node.attributes["visible-to-user"] !== "false" &&
      node.attributes.displayed !== "false",
  );
}

/** Return whether an integer point is inside one half-open bounds rectangle. */
function boundsContain(bounds: UiBounds, x: number, y: number): boolean {
  return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
}

/** Return a stable, bounded Android identifier or no value. */
function safeAndroidIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized &&
    normalized.length <= 200 &&
    /^[A-Za-z0-9_.$:-]+(?:\/[A-Za-z0-9_.$:-]+)?$/.test(normalized)
    ? normalized
    : undefined;
}

/** Build a stable placeholder key for editable UI content. */
function parameterKey(node: UiNode, field: "text" | "description"): string {
  const resourceTail = node.attributes["resource-id"]
    ?.split("/")
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `ui.${resourceTail || field}`.slice(0, 80);
}

/** Return whether one exact generic label was reviewed for selector transport. */
function isReviewedPublicUiLabel(value: string): boolean {
  return REVIEWED_PUBLIC_UI_LABELS.has(
    value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"),
  );
}

/** Classify one node string without returning likely private content. */
function classifyNodeText(
  raw: string | undefined,
  node: UiNode,
  field: "text" | "description",
): DeviceUiClassifiedText | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const hint = `${node.attributes["resource-id"] || ""} ${node.attributes.class || ""}`;
  const editable =
    node.attributes.editable === "true" || /(?:^|\.)EditText$/i.test(node.attributes.class || "");
  const secret =
    node.attributes.password === "true" ||
    /password|passwd|secret|token|otp|pin|验证码|密码/i.test(`${hint} ${value}`);
  if (secret) return { mode: "redacted", category: "credential", length: value.length };
  if (editable) return { mode: "parameter", key: parameterKey(node, field) };
  if (/https?:\/\/|Bearer\s+/i.test(value)) {
    return { mode: "redacted", category: "link-or-token", length: value.length };
  }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) {
    return { mode: "redacted", category: "email-address", length: value.length };
  }
  if (/\d/.test(value)) {
    return { mode: "redacted", category: "numeric-content", length: value.length };
  }
  if (
    /contact|recipient|phone|address|account|username|conversation[_-]?name|message[_-]?(?:text|body|content)|content[_-]?text|联系人|收件人|手机号/i.test(
      hint,
    )
  ) {
    return { mode: "redacted", category: "potential-personal-data", length: value.length };
  }
  if (
    value.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !isReviewedPublicUiLabel(value)
  ) {
    return { mode: "redacted", category: "unreviewed-content", length: value.length };
  }
  return { mode: "literal", value, reviewed: true };
}

/** Select the deepest visible node and any nearest actionable ancestor. */
function selectTargetNode(
  nodes: UiNode[],
  x: number,
  y: number,
): UiTargetSelection | null {
  const matches = nodes
    .filter((node): node is UiNode & { bounds: UiBounds } =>
      isVisibleNode(node) && boundsContain(node.bounds, x, y),
    )
    .sort((left, right) => {
      if (left.depth !== right.depth) return right.depth - left.depth;
      const leftArea =
        (left.bounds.right - left.bounds.left) *
        (left.bounds.bottom - left.bounds.top);
      const rightArea =
        (right.bounds.right - right.bounds.left) *
        (right.bounds.bottom - right.bounds.top);
      return leftArea - rightArea || right.order - left.order;
    });
  const deepest = matches[0];
  if (!deepest) return null;
  if (deepest.attributes.clickable === "true") {
    return { node: deepest, semanticPath: [deepest] };
  }
  const semanticPath: UiNode[] = [deepest];
  let ancestor = deepest.parent;
  while (ancestor) {
    semanticPath.push(ancestor);
    if (
      ancestor.attributes.clickable === "true" &&
      isVisibleNode(ancestor) &&
      boundsContain(ancestor.bounds, x, y)
    ) {
      return { node: ancestor, semanticPath };
    }
    ancestor = ancestor.parent;
  }
  return { node: deepest, semanticPath: [deepest] };
}

/** Build one bounded, privacy-safe result from complete Android diagnostics. */
export function resolveUiTargetAt(
  hierarchyOutput: string,
  activityOutput: string,
  windowsOutput: string,
  wmSizeOutput: string,
  params: DeviceUiTargetAtParams,
  capturedAt: number,
): DeviceUiTargetAtResult {
  const hierarchy = parseUiHierarchy(hierarchyOutput);
  const parsedForeground = parseAndroidForeground(activityOutput, windowsOutput);
  const foreground: DeviceUiForeground = {
    packageName: parsedForeground.packageName,
    activityName: parsedForeground.activityName,
  };
  const display = parseDisplaySize(
    wmSizeOutput,
    hierarchy.rotation,
    params.screenWidth,
    params.screenHeight,
  );
  if (
    Math.sign(params.screenWidth - params.screenHeight) !==
    Math.sign(display.width - display.height)
  ) {
    return { target: null, foreground, display, capturedAt };
  }
  const x = Math.min(
    display.width - 1,
    Math.max(0, Math.floor((params.x / params.screenWidth) * display.width)),
  );
  const y = Math.min(
    display.height - 1,
    Math.max(0, Math.floor((params.y / params.screenHeight) * display.height)),
  );
  const selection = selectTargetNode(hierarchy.nodes, x, y);
  if (!selection || !selection.node.bounds) {
    return { target: null, foreground, display, capturedAt };
  }
  const semanticNodes = [selection.node, ...selection.semanticPath]
    .filter((node, index, nodes) => nodes.indexOf(node) === index)
    .filter(
      (node): node is UiNode & { bounds: UiBounds } =>
        isVisibleNode(node) && boundsContain(node.bounds, x, y),
    );
  const selected =
    semanticNodes.find((node) =>
      safeAndroidIdentifier(node.attributes["resource-id"]),
    ) ||
    semanticNodes.find(
      (node) =>
        Boolean(node.attributes.text?.trim()) ||
        Boolean(node.attributes["content-desc"]?.trim()),
    ) ||
    selection.node;
  const bounds: UiBounds = {
    left: Math.max(0, Math.min(display.width, selected.bounds.left)),
    top: Math.max(0, Math.min(display.height, selected.bounds.top)),
    right: Math.max(0, Math.min(display.width, selected.bounds.right)),
    bottom: Math.max(0, Math.min(display.height, selected.bounds.bottom)),
  };
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    return { target: null, foreground, display, capturedAt };
  }
  const resourceId = safeAndroidIdentifier(selected.attributes["resource-id"]);
  const resourceIdCount = resourceId
    ? hierarchy.nodes.filter(
        (node) => safeAndroidIdentifier(node.attributes["resource-id"]) === resourceId,
      ).length
    : 0;
  const text = classifyNodeText(selected.attributes.text, selected, "text");
  const description = classifyNodeText(
    selected.attributes["content-desc"],
    selected,
    "description",
  );
  const className =
    safeAndroidIdentifier(selected.attributes.class) || "android.view.View";
  const packageName =
    safeAndroidIdentifier(selected.attributes.package) || foreground.packageName;
  return {
    target: {
      source: "android-uiautomator",
      confidence:
        resourceIdCount === 1
          ? "exact-resource-id"
          : resourceId || text || description
            ? "composite"
            : "heuristic",
      packageName,
      activityName: foreground.activityName,
      className,
      ...(resourceId ? { resourceId } : {}),
      ...(text ? { text } : {}),
      ...(description ? { description } : {}),
      bounds: { ...bounds, screenWidth: display.width, screenHeight: display.height },
      clickable: selected.attributes.clickable === "true",
      editable:
        selected.attributes.editable === "true" ||
        /(?:^|\.)EditText$/i.test(selected.attributes.class || ""),
    },
    foreground,
    display,
    capturedAt,
  };
}
