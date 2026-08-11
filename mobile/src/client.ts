import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mqtt from "mqtt";

import { AdbKeyboardManager } from "./adb-keyboard.js";
import {
  buildAutoJsEngineStopScript,
  parseAutoJsEngineStopResult,
} from "./autojs-engine.js";
import { loadConfig } from "./config.js";
import { collectDeviceInfo } from "./device-info.js";
import {
  PROTOCOL_VERSION,
  isRecord,
  parseDeviceTaskRequest,
  type DeviceEventPayload,
  type DeviceInfoPayload,
  type DevicePresencePayload,
  type DeviceTaskRequest,
  type DeviceTaskResult,
  type TaskStatus,
} from "./protocol.js";
import { buildObserverScript } from "./scripts/index.js";
import {
  getRegisteredScript,
  listRegisteredScripts,
  readRegisteredScript,
  validateRegisteredTaskParams,
} from "./task-registry.js";
import {
  canPreemptRunning,
  findHighPriorityEvictionIndex,
  insertQueuedTask,
  type QueuedDeviceTask,
} from "./task-queue.js";
import { TikTokLedger } from "./tiktok-ledger.js";
import {
  applyTikTokPublicationCheckpoint,
  applyTikTokScriptResult,
  importLegacyTikTokState,
  markTikTokPublicationPhase,
  prepareTikTokTask,
  type PreparedTikTokTask,
} from "./tiktok-policy.js";
import {
  attestTikTokNetwork,
  TikTokNetworkPolicyError,
} from "./tiktok-network-policy.js";
import { getEmqxBrokerUrl } from "./utils/mqtt.js";

const currentFile = fileURLToPath(import.meta.url);
const sourceDirectory = path.dirname(currentFile);
const mobileRoot = path.resolve(sourceDirectory, "..");
const logsDirectory = path.join(mobileRoot, "logs");
const resultOutboxDirectory = path.join(
  mobileRoot,
  "state",
  "task-result-outbox",
);
const stateDirectory = path.join(mobileRoot, "state");
const clientVersion = "2.0.0";
const RESULT_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 格式化本地日期。 */
function formatLocalDate(date: Date, withTime = false): string {
  const pad = (value: number, length = 2) =>
    String(value).padStart(length, "0");
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (!withTime) return datePart;
  return `${datePart} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** 将控制台日志同步写入按天文件。 */
function initializeLogging(): void {
  fs.mkdirSync(logsDirectory, { recursive: true });
  const methods = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
  };
  for (const level of Object.keys(methods) as Array<keyof typeof methods>) {
    console[level] = (...args: unknown[]) => {
      methods[level](...args);
      try {
        const filePath = path.join(
          logsDirectory,
          `${formatLocalDate(new Date())}.log`,
        );
        fs.appendFileSync(
          filePath,
          `[${formatLocalDate(new Date(), true)}] [${level.toUpperCase()}] ${args.map(String).join(" ")}\n`,
          "utf8",
        );
      } catch {
        // 日志失败不能影响守护进程。
      }
    };
  }
}

initializeLogging();
dotenv.config();

const mqttUsername = process.env.EMQX_USERNAME;
const mqttHost = process.env.EMQX_HOST;
if (!mqttUsername || !mqttHost) {
  throw new Error("EMQX_USERNAME and EMQX_HOST are required in .env");
}

const { config, configPath } = loadConfig();
const deviceId = config.deviceId || mqttUsername;
if (!/^[A-Za-z0-9._:-]{1,100}$/.test(deviceId)) {
  throw new Error(
    "deviceId may only contain letters, numbers, dot, underscore, colon and hyphen",
  );
}
const brokerUrl = getEmqxBrokerUrl();
const autojsPackageName = "org.autojs.autojs6";
const autojsAccessibilityService =
  "org.autojs.autojs6/org.autojs.autojs.core.accessibility.AccessibilityServiceUsher";
const tikTokPackageName = "com.zhiliaoapp.musically";
const tempScriptDirectory = process.env.TEMP_SCRIPT_DIR || "/sdcard/Download";
const tasksTopic = `autojs6/v2/devices/${deviceId}/tasks`;
const resultsTopic = `autojs6/v2/devices/${deviceId}/results`;
const eventsTopic = `autojs6/v2/devices/${deviceId}/events`;
const presenceTopic = `autojs6/v2/devices/${deviceId}/presence`;
const infoTopic = `autojs6/v2/devices/${deviceId}/info`;
const deviceLogId = crypto
  .createHash("sha256")
  .update(deviceId)
  .digest("hex")
  .slice(0, 12);
const reportToken = process.env.AUTOJS6_REPORT_TOKEN;
const usesMqttReporting =
  config.report.transport === "mqtt" || config.report.transport === "both";
const usesHttpReporting =
  config.report.transport === "http" || config.report.transport === "both";

if (usesHttpReporting && (!config.report.httpBaseUrl || !reportToken)) {
  throw new Error(
    "HTTP reporting requires report.httpBaseUrl and AUTOJS6_REPORT_TOKEN",
  );
}

/** 将旧共享目录中的 TikTok 去重历史迁移到 Termux 私有账本。 */
function migrateLegacyTikTokState(): void {
  try {
    const result = importLegacyTikTokState(
      new TikTokLedger(stateDirectory),
      "/sdcard/Download/tiktok_post_state.json",
      config.tiktok.allowedMaterialRoots,
    );
    if (result.imported) {
      console.log(
        `[TikTok] Migrated legacy reuse history (${result.materialFingerprints} media, ${result.captionFingerprints} captions)`,
      );
    }
  } catch (error) {
    console.warn(
      "[TikTok] Legacy history migration was deferred; the original file was preserved",
      error,
    );
  }
}

migrateLegacyTikTokState();

const adbKeyboardManager = new AdbKeyboardManager(
  config.tiktok.adbKeyboard,
  stateDirectory,
);
try {
  if (await adbKeyboardManager.recoverOnStartup()) {
    console.log("[TikTok] Recovered input method state after interrupted task");
  }
} catch (error) {
  console.error(
    "[TikTok] Input method recovery failed; refusing to accept device tasks",
    error,
  );
  throw error;
}

/** 隐去 MQTT URL 中的认证信息，避免凭据进入控制台和本地日志。 */
function redactBrokerUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return value.replace(/\/\/[^@/]+@/, "//***:***@");
  }
}

interface ActiveTask {
  request: DeviceTaskRequest;
  startedAt: number;
  deadlineAt: number;
  sideEffectCommitted: boolean;
  checkpointPhase: string;
  timeoutTimer: NodeJS.Timeout | null;
  pollInterval: NodeJS.Timeout;
  tempFilePath: string;
  resultFilePath: string;
  checkpointFilePath: string;
  checkpointAckFilePath: string;
  engineStopScriptPath: string;
  engineStopResultPath: string;
  tiktok?: PreparedTikTokTask;
  adbKeyboardActive: boolean;
  cleanupPromise?: Promise<void>;
}

interface TaskResultOutboxEntry {
  result: DeviceTaskResult;
  callbackUrl?: string;
  persistedAt: number;
}

interface ScriptResultFile {
  status: TaskStatus;
  code: string;
  message: string;
  data: unknown;
}

const taskQueue: QueuedDeviceTask[] = [];
const queuedTaskIds = new Set<string>();
const deliveringResultIds = new Set<string>();
let activeTask: ActiveTask | null = null;
let isStartingTask = false;
let queueSequence = 0;
let taskIntakeChain = Promise.resolve();
let observerWatcher: NodeJS.Timeout | null = null;
let observersStarted = false;
let heartbeatTimer: NodeJS.Timeout | null = null;
let resultOutboxRetryTimer: NodeJS.Timeout | null = null;
const lastPublishedEvents = new Map<
  string,
  { key: string; timestamp: number }
>();

/** 构造最小在线状态消息。 */
function presence(status: "ONLINE" | "OFFLINE"): DevicePresencePayload {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    status,
    timestamp: Date.now(),
  };
}

// 静态信息 Promise 在进程生命周期内只创建一次；MQTT 重连只复用结果。
const deviceInfoPromise: Promise<DeviceInfoPayload> = collectDeviceInfo(
  deviceId,
  clientVersion,
  listRegisteredScripts().map(({ scriptId, version }) => ({
    scriptId,
    version,
  })),
);

const mqttClient = mqtt.connect(brokerUrl, {
  protocolVersion: 5,
  clean: false,
  clientId: deviceId,
  properties: { sessionExpiryInterval: config.mqtt.sessionExpirySeconds },
  ...(usesMqttReporting
    ? {
        will: {
          topic: presenceTopic,
          payload: JSON.stringify(presence("OFFLINE")),
          qos: config.mqtt.qos,
          retain: true,
        },
      }
    : {}),
});

/** 将设备上报发送到配置的 HTTPS 接口。 */
async function postReport(
  kind: "presence" | "info" | "event",
  payload: DevicePresencePayload | DeviceInfoPayload | DeviceEventPayload,
): Promise<void> {
  if (!usesHttpReporting || !config.report.httpBaseUrl || !reportToken) return;
  const response = await fetch(`${config.report.httpBaseUrl}/report/${kind}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Token": reportToken,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.report.requestTimeoutMs),
  });
  const responseBody: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(responseBody) || responseBody.ok !== true) {
    throw new Error(`HTTP report rejected (${response.status})`);
  }
}

/** 发送设备上报；双通道模式复用完全相同的 eventId 和载荷。 */
function publishReport(
  kind: "presence" | "info" | "event",
  topic: string,
  payload: DevicePresencePayload | DeviceInfoPayload | DeviceEventPayload,
  retain = false,
): void {
  if (usesMqttReporting && mqttClient.connected) {
    mqttClient.publish(topic, JSON.stringify(payload), {
      qos: config.mqtt.qos,
      retain,
    });
  }
  if (usesHttpReporting) {
    void postReport(kind, payload).catch((error) =>
      console.warn(`[REPORT] ${kind} HTTP upload failed`, error),
    );
  }
}

/** 使用 `su -c` 执行仅由本地代码构造的 Android 命令。 */
function runRootCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("su", ["-c", command], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** 等待固定时长，不阻塞 Node.js 事件循环。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 使用 `su -c` 读取仅由本地代码构造的 Android 命令输出。 */
function readRootCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "su",
      ["-c", command],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout));
      },
    );
  });
}

/** 为本地生成的路径添加 POSIX shell 单引号。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** 确保固定 AutoJS6 无障碍组件在强制终止脚本后重新启用。 */
async function ensureAutoJsAccessibilityService(): Promise<void> {
  const raw = (
    await readRootCommand("settings get secure enabled_accessibility_services")
  ).trim();
  const current = raw && raw !== "null" ? raw : "";
  const components = current ? current.split(":").filter(Boolean) : [];
  if (
    components.some(
      (component) =>
        !/^[A-Za-z0-9._]+\/[A-Za-z0-9._]+$/.test(component),
    )
  ) {
    throw new Error("AUTOJS_ACCESSIBILITY_SETTINGS_INVALID");
  }
  if (!components.includes(autojsAccessibilityService)) {
    const next = [...components, autojsAccessibilityService].join(":");
    await runRootCommand(
      `settings put secure enabled_accessibility_services ${shellQuote(next)}`,
    );
  }
  const enabled = (
    await readRootCommand("settings get secure accessibility_enabled")
  ).trim();
  if (enabled !== "1") {
    await runRootCommand("settings put secure accessibility_enabled 1");
  }
}

/** 将设备事件按配置防抖后发布。 */
function publishEvent(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== "string") return;
  const allowedTypes = ["battery", "network", "sms", "notification"] as const;
  if (!allowedTypes.some((type) => type === value.type)) return;
  const timestamp =
    typeof value.timestamp === "number" ? value.timestamp : Date.now();
  const data = isRecord(value.data) ? value.data : {};
  const eventConfig = config.events[value.type as keyof typeof config.events];
  const debounceMs = eventConfig?.debounceMs ?? 1000;
  const key = JSON.stringify(data);
  const previous = lastPublishedEvents.get(value.type);
  if (
    previous &&
    previous.key === key &&
    Date.now() - previous.timestamp < debounceMs
  ) {
    return;
  }
  lastPublishedEvents.set(value.type, { key, timestamp: Date.now() });
  const payload: DeviceEventPayload = {
    protocolVersion: PROTOCOL_VERSION,
    eventId: crypto.randomUUID(),
    deviceId,
    type: value.type as DeviceEventPayload["type"],
    timestamp,
    data,
  };
  publishReport("event", eventsTopic, payload);
}

/** 启动配置文件指定的本地事件监听脚本。 */
async function applyObserverConfig(): Promise<void> {
  if (observerWatcher) clearInterval(observerWatcher);
  observerWatcher = null;
  const observerControlPath = path.join(
    tempScriptDirectory,
    "autojs_observer.instance",
  );
  const observerInstanceId = crypto.randomUUID();
  const localControlPath = path.join(
    sourceDirectory,
    "local_autojs_observer.instance",
  );
  fs.writeFileSync(localControlPath, observerInstanceId, "utf8");
  const enabled = Object.values(config.events).some((item) => item.enabled);
  if (!enabled) {
    await runRootCommand(
      `cp ${shellQuote(localControlPath)} ${shellQuote(observerControlPath)} && chmod 600 ${shellQuote(observerControlPath)} && rm -f ${shellQuote(localControlPath)}`,
    );
    return;
  }
  await ensureAutoJsAccessibilityService();

  const observerPath = path.join(tempScriptDirectory, "autojs_observer.js");
  const eventPath = path.join(tempScriptDirectory, "autojs_events.txt");
  const processingEventPath = path.join(
    tempScriptDirectory,
    "autojs_events.processing",
  );
  const localPath = path.join(sourceDirectory, "local_autojs_observer.js");
  fs.writeFileSync(
    localPath,
    buildObserverScript(
      eventPath,
      config.events,
      observerControlPath,
      observerInstanceId,
    ),
    "utf8",
  );
  await runRootCommand(
    `cp ${shellQuote(localControlPath)} ${shellQuote(observerControlPath)} && cp ${shellQuote(localPath)} ${shellQuote(observerPath)} && chmod 600 ${shellQuote(observerControlPath)} ${shellQuote(observerPath)} && rm -f ${shellQuote(localControlPath)} ${shellQuote(localPath)} ${shellQuote(eventPath)} ${shellQuote(processingEventPath)} && am start -n ${autojsPackageName}/org.autojs.autojs.external.open.RunIntentActivity -d file://${observerPath} -t text/javascript`,
  );

  observerWatcher = setInterval(() => {
    if (!fs.existsSync(eventPath)) return;
    try {
      fs.renameSync(eventPath, processingEventPath);
      let content = "";
      try {
        content = fs.readFileSync(processingEventPath, "utf8");
      } finally {
        fs.rmSync(processingEventPath, { force: true });
      }
      for (const line of content.split("\n").filter(Boolean)) {
        try {
          publishEvent(JSON.parse(line) as unknown);
        } catch (error) {
          console.warn("[EVENT] Ignored malformed observer line", error);
        }
      }
    } catch (error) {
      console.error("[EVENT] Failed to read observer result", error);
    }
  }, 1000);
}

/** 返回单个任务结果的本地 outbox 文件。 */
function resultOutboxPath(taskId: string): string {
  return path.join(resultOutboxDirectory, `${taskId}.json`);
}

/** 在任何网络发送之前原子保存任务终态。 */
function persistTaskResult(entry: TaskResultOutboxEntry): void {
  fs.mkdirSync(resultOutboxDirectory, { recursive: true });
  const targetPath = resultOutboxPath(entry.result.taskId);
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(entry), "utf8");
  fs.renameSync(temporaryPath, targetPath);
}

/** 删除已经被至少一个可信通道确认的任务结果。 */
function removePersistedTaskResult(taskId: string): void {
  fs.rmSync(resultOutboxPath(taskId), { force: true });
}

/** 通过 MQTT QoS 1 发布并等待 Broker PUBACK。 */
function publishTaskResultMqtt(result: DeviceTaskResult): Promise<void> {
  if (!mqttClient.connected) {
    return Promise.reject(new Error("MQTT client is disconnected"));
  }
  return new Promise((resolve, reject) => {
    mqttClient.publish(
      resultsTopic,
      JSON.stringify(result),
      { qos: config.mqtt.qos, retain: false },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

/** 通过带设备令牌的 HTTP callback 发送任务结果。 */
async function postTaskResult(entry: TaskResultOutboxEntry): Promise<void> {
  if (!entry.callbackUrl || !reportToken || !config.report.httpBaseUrl) {
    throw new Error("Authenticated HTTP callback is not configured");
  }
  const callbackUrl = new URL(entry.callbackUrl);
  if (callbackUrl.protocol !== "https:") {
    throw new Error("Task callback URL must use HTTPS");
  }
  const trustedReportOrigin = new URL(config.report.httpBaseUrl).origin;
  if (callbackUrl.origin !== trustedReportOrigin) {
    throw new Error(
      "Task callback origin does not match the trusted report origin",
    );
  }
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Token": reportToken,
    },
    body: JSON.stringify(entry.result),
    signal: AbortSignal.timeout(config.report.requestTimeoutMs),
  });
  const responseBody: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(responseBody) || responseBody.ok !== true) {
    throw new Error(`HTTP task callback rejected (${response.status})`);
  }
}

/** 同时尝试可信结果通道，任一确认后清除 outbox。 */
async function deliverTaskResult(entry: TaskResultOutboxEntry): Promise<void> {
  const taskId = entry.result.taskId;
  if (deliveringResultIds.has(taskId)) return;
  const deliveries: Array<Promise<void>> = [];
  if (usesMqttReporting && mqttClient.connected)
    deliveries.push(publishTaskResultMqtt(entry.result));
  if (entry.callbackUrl && reportToken) deliveries.push(postTaskResult(entry));
  if (deliveries.length === 0) return;
  deliveringResultIds.add(taskId);
  try {
    await Promise.any(deliveries);
    removePersistedTaskResult(taskId);
  } catch (error) {
    console.warn(`[TASK] Result delivery pending for ${taskId}`, error);
  } finally {
    deliveringResultIds.delete(taskId);
  }
}

/** 从本地 outbox 读取一条由本进程生成的结果。 */
function readTaskResultOutboxEntry(filePath: string): TaskResultOutboxEntry {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.result) ||
    typeof parsed.result.taskId !== "string" ||
    typeof parsed.persistedAt !== "number"
  ) {
    throw new Error("Invalid task result outbox entry");
  }
  return parsed as unknown as TaskResultOutboxEntry;
}

/** 重放尚未被任一可信通道确认的任务终态。 */
async function replayTaskResultOutbox(): Promise<void> {
  fs.mkdirSync(resultOutboxDirectory, { recursive: true });
  const now = Date.now();
  for (const fileName of fs.readdirSync(resultOutboxDirectory)) {
    if (!fileName.endsWith(".json")) continue;
    const filePath = path.join(resultOutboxDirectory, fileName);
    try {
      const entry = readTaskResultOutboxEntry(filePath);
      if (now - entry.persistedAt > RESULT_OUTBOX_MAX_AGE_MS) {
        fs.rmSync(filePath, { force: true });
        continue;
      }
      await deliverTaskResult(entry);
    } catch (error) {
      console.warn(
        `[TASK] Ignored corrupt result outbox file ${fileName}`,
        error,
      );
      fs.rmSync(filePath, { force: true });
    }
  }
}

/** 构造、持久化并异步投递统一任务结果。 */
function publishTaskResult(
  request: DeviceTaskRequest,
  startedAt: number,
  status: TaskStatus,
  code: string,
  message: string,
  data: unknown = null,
): void {
  const finishedAt = Date.now();
  const result: DeviceTaskResult = {
    protocolVersion: PROTOCOL_VERSION,
    taskId: request.taskId,
    deviceId,
    scriptId: request.scriptId,
    status,
    code,
    message,
    data,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    traceId: request.traceId,
  };
  const entry: TaskResultOutboxEntry = {
    result,
    callbackUrl: request.callbackUrl,
    persistedAt: Date.now(),
  };
  persistTaskResult(entry);
  void deliverTaskResult(entry);
}

/** 从脚本结果文件中解析统一字段。 */
function parseResultFile(content: string): ScriptResultFile {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error("Result file must contain an object");
  const allowedStatuses: TaskStatus[] = [
    "SUCCESS",
    "FAILURE",
    "TIMEOUT",
    "REJECTED",
    "CANCELLED",
  ];
  const status = allowedStatuses.includes(parsed.status as TaskStatus)
    ? (parsed.status as TaskStatus)
    : "FAILURE";
  return {
    status,
    code:
      typeof parsed.code === "string"
        ? parsed.code
        : status === "SUCCESS"
          ? "OK"
          : "SCRIPT_FAILED",
    message:
      typeof parsed.message === "string" ? parsed.message : "Task finished",
    data: parsed.data ?? null,
  };
}

/** 从策略异常中提取不含路径和文案的稳定错误码。 */
function tikTokPolicyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(":", 1)[0];
  return /^[A-Z0-9_]{3,80}$/.test(code) ? code : "INVALID_TIKTOK_PARAMS";
}

/** 从网络门禁异常中提取不包含地址信息的稳定错误码。 */
function tikTokNetworkPolicyError(error: unknown): string {
  return error instanceof TikTokNetworkPolicyError
    ? error.code
    : "TIKTOK_NETWORK_PROBE_FAILED";
}

/** 移除 TikTok 结果中的账号、素材路径和完整文案，只保留运行状态与已验证链接。 */
function sanitizeTikTokResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const account = isRecord(value.account) ? value.account : {};
  const media = isRecord(value.media) ? value.media : {};
  const post = isRecord(value.post) ? value.post : {};
  return {
    contractVersion: value.contractVersion,
    action: value.action,
    publicationId: value.publicationId,
    phase: value.phase,
    outcome: value.outcome,
    published: value.published === true,
    retrySafe: value.retrySafe === true,
    nextAction: value.nextAction,
    account: {
      verified: account.verified === true,
      matched:
        account.matched === undefined
          ? account.verified === true
          : account.matched === true,
    },
    media: {
      kind: media.kind,
      size: media.size,
      metadata: media.metadata,
    },
    post: {
      shareUrl: post.shareUrl,
      canonicalUrl: post.canonicalUrl,
      postId: post.postId,
      postType: post.postType,
      verified: post.verified === true,
    },
    warnings: Array.isArray(value.warnings) ? value.warnings : [],
    error: value.error ?? null,
    success: value.success === true,
    postUrl: value.postUrl,
    mediaType: value.mediaType,
  };
}

/** 将私有 TikTok 发布记录转换为可安全回传的结构化结果。 */
function tikTokPublicationResult(prepared: PreparedTikTokTask): unknown {
  const record =
    prepared.ledger.get(prepared.request.publicationId) ?? prepared.publication;
  if (!record) {
    return {
      contractVersion: 2,
      action: prepared.request.action,
      publicationId: prepared.request.publicationId,
      phase: "PREFLIGHT",
      outcome: "READY",
      published: false,
      retrySafe: true,
      nextAction: "publish",
    };
  }
  const committed = [
    "COMMITTING",
    "SUBMITTED",
    "POST_CONFIRMED",
    "LINK_CONFIRMED",
  ].includes(record.phase);
  const published = ["POST_CONFIRMED", "LINK_CONFIRMED"].includes(
    record.phase,
  );
  const canonicalUrl = record.canonicalUrl || record.postUrl || "";
  return {
    contractVersion: 2,
    action: prepared.request.action,
    publicationId: record.publicationId,
    phase: record.phase,
    outcome: record.outcome,
    published,
    retrySafe: !committed,
    nextAction:
      record.phase === "LINK_CONFIRMED"
        ? "none"
        : committed
          ? "recover"
          : "publish",
    account: {
      verified: record.account !== "LEGACY_UNVERIFIED",
      matched: record.account !== "LEGACY_UNVERIFIED",
    },
    media: {
      kind: record.media.kind,
      size: record.media.size,
    },
    post: {
      shareUrl: record.shareUrl || canonicalUrl,
      canonicalUrl,
      postId: record.postId || "",
      postType: record.media.kind === "image" ? "photo" : "video",
      verified: record.phase === "LINK_CONFIRMED",
    },
    error: record.errorCode
      ? { code: record.errorCode, message: "TikTok publication requires attention" }
      : null,
    success: record.phase === "LINK_CONFIRMED",
    postUrl: canonicalUrl,
    mediaType: record.media.kind,
  };
}

/** 将无需启动 AutoJS 的 TikTok 查询或幂等命中直接完成。 */
function completePreparedTikTokTask(
  request: DeviceTaskRequest,
  prepared: PreparedTikTokTask,
  startedAt: number,
): void {
  const cached = prepared.decision === "CACHED";
  publishTaskResult(
    request,
    startedAt,
    "SUCCESS",
    cached ? "POST_ALREADY_CONFIRMED" : "PUBLICATION_STATUS",
    cached
      ? "TikTok publication was already completed; no new post was created"
      : "TikTok publication status loaded from the private device ledger",
    tikTokPublicationResult(prepared),
  );
  queuedTaskIds.delete(request.taskId);
  isStartingTask = false;
  setTimeout(processNextTask, 100);
}

/** 将 TikTok 执行失败写入私有账本；账本故障不覆盖原任务结果。 */
function recordTikTokFailure(
  prepared: PreparedTikTokTask | undefined,
  code: string,
  published = false,
): void {
  if (!prepared?.publication) return;
  try {
    applyTikTokScriptResult(prepared, { code, published });
  } catch (error) {
    console.warn("[TikTok] Failed to update the private publication ledger", error);
  }
}

/** 清理当前任务、恢复输入法并在完成后调度下一项。 */
async function cleanupActiveTask(): Promise<void> {
  const current = activeTask;
  if (!current) return;
  if (current.cleanupPromise) return current.cleanupPromise;
  if (current.timeoutTimer) clearTimeout(current.timeoutTimer);
  clearInterval(current.pollInterval);
  current.timeoutTimer = null;
  current.cleanupPromise = (async () => {
    if (current.adbKeyboardActive || adbKeyboardManager.hasPendingRecovery()) {
      await adbKeyboardManager.restore();
      current.adbKeyboardActive = false;
    }
    for (const filePath of [
      current.tempFilePath,
      current.resultFilePath,
      current.checkpointFilePath,
      current.checkpointAckFilePath,
      current.engineStopScriptPath,
      current.engineStopResultPath,
    ]) {
      await runRootCommand(`rm -f ${shellQuote(filePath)}`).catch((error) =>
        console.warn(`[TASK] Failed to remove ${filePath}`, error),
      );
    }
    queuedTaskIds.delete(current.request.taskId);
    if (activeTask === current) activeTask = null;
    setTimeout(processNextTask, 100);
  })().catch((error) => {
    console.error(
      "[TikTok] Input method restore failed; restarting client before another task",
      error,
    );
    setTimeout(() => process.exit(1), 250);
  });
  return current.cleanupPromise;
}

/** 通过一个独立 AutoJS6 控制引擎停止指定任务脚本。 */
async function stopActiveTaskEngine(current: ActiveTask): Promise<boolean> {
  const localStopPath = path.join(
    sourceDirectory,
    `local_autojs_stop_${current.request.taskId}.js`,
  );
  fs.writeFileSync(
    localStopPath,
    buildAutoJsEngineStopScript(
      current.tempFilePath,
      current.engineStopResultPath,
    ),
    "utf8",
  );
  try {
    await ensureAutoJsAccessibilityService();
    await runRootCommand(
      `rm -f ${shellQuote(current.engineStopResultPath)} && cp ${shellQuote(localStopPath)} ${shellQuote(current.engineStopScriptPath)} && chmod 600 ${shellQuote(current.engineStopScriptPath)} && rm -f ${shellQuote(localStopPath)} && am start -n ${autojsPackageName}/org.autojs.autojs.external.open.RunIntentActivity -d file://${current.engineStopScriptPath} -t text/javascript`,
    );
    for (let attempt = 0; attempt < 25; attempt += 1) {
      if (fs.existsSync(current.engineStopResultPath)) {
        const result = parseAutoJsEngineStopResult(
          fs.readFileSync(current.engineStopResultPath, "utf8"),
        );
        return result.stopped && result.matchedEngines === 1;
      }
      await delay(200);
    }
    return false;
  } finally {
    fs.rmSync(localStopPath, { force: true });
  }
}

/**
 * 优先停止指定任务引擎；失败时才终止 AutoJS6 整包并恢复无障碍。
 */
async function terminateActiveTask(current: ActiveTask): Promise<boolean> {
  try {
    if (await stopActiveTaskEngine(current)) {
      console.log(`[TASK] Stopped task engine ${current.request.taskId}`);
      return true;
    }
    console.warn(
      `[TASK] Target engine was not stopped; using package fallback for ${current.request.taskId}`,
    );
  } catch (error) {
    console.warn(
      `[TASK] Target engine stop failed; using package fallback for ${current.request.taskId}`,
      error,
    );
  }
  try {
    await runRootCommand(`am force-stop ${autojsPackageName}`);
    await delay(500);
    await ensureAutoJsAccessibilityService();
    console.warn(
      `[TASK] AutoJS6 package fallback was required for ${current.request.taskId}`,
    );
    return true;
  } catch (error) {
    console.error(
      `[TASK] Failed to terminate ${current.request.taskId}; queue remains blocked`,
      error,
    );
    return false;
  }
}

/** 终止超过本机执行时限的运行中任务。 */
async function timeoutActiveTask(current: ActiveTask): Promise<void> {
  if (activeTask !== current) return;
  if (!(await terminateActiveTask(current))) {
    current.timeoutTimer = setTimeout(
      () => void timeoutActiveTask(current),
      1000,
    );
    return;
  }
  if (activeTask !== current) return;
  recordTikTokFailure(
    current.tiktok,
    current.sideEffectCommitted ? "PUBLISH_OUTCOME_UNKNOWN" : "TASK_TIMEOUT",
  );
  publishTaskResult(
    current.request,
    current.startedAt,
    "TIMEOUT",
    current.sideEffectCommitted ? "PUBLISH_OUTCOME_UNKNOWN" : "TASK_TIMEOUT",
    current.sideEffectCommitted
      ? "TikTok publish crossed the commit boundary before timing out; do not retry publish"
      : `Script exceeded ${Math.max(0, current.deadlineAt - current.startedAt)}ms and was terminated`,
    current.sideEffectCommitted
      ? current.tiktok
        ? tikTokPublicationResult(current.tiktok)
        : {
            contractVersion: 2,
            action: "publish",
            publicationId:
              typeof current.request.params.publicationId === "string"
                ? current.request.params.publicationId
                : current.request.taskId,
            phase: current.checkpointPhase || "COMMITTING",
            outcome: "UNKNOWN",
            published: false,
            retrySafe: false,
            nextAction: "recover",
          }
      : null,
  );
  await cleanupActiveTask();
  setTimeout(() => void applyObserverConfig(), 2000);
}

/** 根据剩余截止时间为运行中任务安装超时定时器。 */
function scheduleActiveTaskTimeout(current: ActiveTask): void {
  if (current.timeoutTimer) clearTimeout(current.timeoutTimer);
  current.timeoutTimer = setTimeout(
    () => void timeoutActiveTask(current),
    Math.max(1, current.deadlineAt - Date.now()),
  );
}

/** 显式中断当前任务并让不低于其优先级的新任务优先执行。 */
async function preemptActiveTask(incoming: DeviceTaskRequest): Promise<void> {
  const current = activeTask;
  if (!current) return;
  if (current.cleanupPromise) return;
  if (
    current.sideEffectCommitted &&
    canPreemptRunning(incoming, current.request, false)
  ) {
    console.warn(
      `[TASK] Deferred preemption of ${current.request.taskId}; TikTok publish is past the commit boundary`,
    );
    return;
  }
  if (
    !canPreemptRunning(
      incoming,
      current.request,
      current.sideEffectCommitted,
    )
  )
    return;
  if (current.timeoutTimer) {
    clearTimeout(current.timeoutTimer);
    current.timeoutTimer = null;
  }
  if (!(await terminateActiveTask(current))) {
    if (activeTask === current) scheduleActiveTaskTimeout(current);
    return;
  }
  if (activeTask !== current) return;
  recordTikTokFailure(current.tiktok, "PREEMPTED_BY_TASK");
  publishTaskResult(
    current.request,
    current.startedAt,
    "CANCELLED",
    "PREEMPTED_BY_TASK",
    `Task was preempted by ${incoming.taskId}`,
    { preemptedByTaskId: incoming.taskId },
  );
  await cleanupActiveTask();
  setTimeout(() => void applyObserverConfig(), 2000);
}

/** 完成尚未进入执行状态的任务并继续队列。 */
function rejectQueuedTask(
  request: DeviceTaskRequest,
  code: string,
  message: string,
): void {
  publishTaskResult(request, Date.now(), "REJECTED", code, message);
  queuedTaskIds.delete(request.taskId);
  isStartingTask = false;
  setTimeout(processNextTask, 100);
}

/** 为可信脚本添加固定结果协议包装。 */
function buildWrappedScript(
  request: DeviceTaskRequest,
  scriptBody: string,
  resultPath: string,
  checkpointPath: string,
  checkpointAckPath: string,
  deadlineAt: number,
): string {
  const paramsLiteral = JSON.stringify(request.params);
  const trustedBody = scriptBody.replace(
    "__AUTOJS_TASK_PARAMS__",
    paramsLiteral,
  );
  return `
var taskResult = "Script execution succeeded";
var taskStatus = "SUCCESS";
var taskCode = "OK";
var taskMessage = "Script execution succeeded";
var taskId = ${JSON.stringify(request.taskId)};
var resPath = ${JSON.stringify(resultPath)};
var taskCheckpointPath = ${JSON.stringify(checkpointPath)};
var taskCheckpointAckPath = ${JSON.stringify(checkpointAckPath)};
var taskDeadlineAt = ${JSON.stringify(deadlineAt)};
try {
  device.wakeUp();
  ${trustedBody}
  var parsedTaskData = null;
  try { parsedTaskData = JSON.parse(String(taskResult)); } catch (_) { parsedTaskData = taskResult; }
  files.write(resPath, JSON.stringify({
    status: String(taskStatus),
    code: String(taskCode),
    message: String(taskMessage),
    data: parsedTaskData
  }));
} catch (error) {
  files.write(resPath, JSON.stringify({
    status: "FAILURE",
    code: "SCRIPT_EXCEPTION",
    message: String(error && error.message ? error.message : error),
    data: null
  }));
}
`;
}

/** 执行一项已经完成协议校验的可信脚本任务。 */
async function executeTask(request: DeviceTaskRequest): Promise<void> {
  const definition = getRegisteredScript(request.scriptId);
  if (
    !definition ||
    !config.security.allowedScriptIds.includes(request.scriptId)
  ) {
    rejectQueuedTask(
      request,
      "SCRIPT_NOT_ALLOWED",
      `Script is not allowed: ${request.scriptId}`,
    );
    return;
  }
  if (request.scriptVersion && request.scriptVersion !== definition.version) {
    rejectQueuedTask(
      request,
      "SCRIPT_VERSION_MISMATCH",
      "Requested script version is not installed",
    );
    return;
  }
  if (request.expiresAt <= Date.now()) {
    publishTaskResult(
      request,
      Date.now(),
      "TIMEOUT",
      "TASK_EXPIRED",
      "Task expired before execution",
    );
    queuedTaskIds.delete(request.taskId);
    isStartingTask = false;
    setTimeout(processNextTask, 100);
    return;
  }

  const paramsBytes = Buffer.byteLength(JSON.stringify(request.params), "utf8");
  if (paramsBytes > config.security.maxParamsBytes) {
    rejectQueuedTask(
      request,
      "PARAMS_TOO_LARGE",
      `Task params exceed ${config.security.maxParamsBytes} bytes`,
    );
    return;
  }
  const remainingTaskMs = Math.min(
    request.timeoutMs,
    request.expiresAt - Date.now(),
  );
  const paramsError = validateRegisteredTaskParams(
    request.scriptId,
    request.params,
    remainingTaskMs,
  );
  if (paramsError) {
    rejectQueuedTask(request, "INVALID_PARAMS", paramsError);
    return;
  }

  if (definition.kind === "client") {
    const startedAt = Date.now();
    if (definition.scriptId !== "client.self-update") {
      rejectQueuedTask(
        request,
        "CLIENT_ACTION_NOT_SUPPORTED",
        `Unsupported client action: ${definition.scriptId}`,
      );
      return;
    }
    publishTaskResult(
      request,
      startedAt,
      "SUCCESS",
      "CLIENT_UPDATE_TRIGGERED",
      "Client update signal accepted; daemon will restart",
    );
    queuedTaskIds.delete(request.taskId);
    isStartingTask = false;
    setTimeout(() => process.exit(99), 1500);
    return;
  }

  const startedAt = Date.now();
  const timeoutMs = Math.max(
    1000,
    Math.min(
      request.timeoutMs || definition.defaultTimeoutMs,
      definition.maxTimeoutMs,
      config.tasks.maxTimeoutMs,
      request.expiresAt - Date.now(),
    ),
  );
  const resultPath = path.join(
    tempScriptDirectory,
    `autojs_res_${request.taskId}.json`,
  );
  const checkpointPath = path.join(
    tempScriptDirectory,
    `autojs_checkpoint_${request.taskId}.json`,
  );
  const checkpointAckPath = path.join(
    tempScriptDirectory,
    `autojs_checkpoint_${request.taskId}.ack`,
  );
  const engineStopScriptPath = path.join(
    tempScriptDirectory,
    `autojs_stop_${request.taskId}.js`,
  );
  const engineStopResultPath = path.join(
    tempScriptDirectory,
    `autojs_stop_${request.taskId}.json`,
  );
  const targetPath = path.join(
    tempScriptDirectory,
    `autojs_task_${request.taskId}.js`,
  );
  const localPath = path.join(
    sourceDirectory,
    `local_autojs_task_${request.taskId}.js`,
  );
  const deadlineAt = startedAt + timeoutMs;
  let tiktok: PreparedTikTokTask | undefined;
  let adbKeyboardActive = false;
  let scriptRequest = request;

  if (request.scriptId === "tiktok.post") {
    try {
      tiktok = prepareTikTokTask(request.params, config.tiktok, {
        stateDirectory,
      });
      if (!tiktok.scriptParams) {
        completePreparedTikTokTask(request, tiktok, startedAt);
        return;
      }
      scriptRequest = { ...request, params: tiktok.scriptParams };
      if (Date.now() >= deadlineAt) {
        recordTikTokFailure(tiktok, "TASK_EXPIRED_DURING_PREFLIGHT");
        publishTaskResult(
          request,
          startedAt,
          "TIMEOUT",
          "TASK_EXPIRED_DURING_PREFLIGHT",
          "TikTok task expired while validating media and local policy",
          tikTokPublicationResult(tiktok),
        );
        queuedTaskIds.delete(request.taskId);
        isStartingTask = false;
        setTimeout(processNextTask, 100);
        return;
      }
    } catch (error) {
      const code = tikTokPolicyError(error);
      rejectQueuedTask(
        request,
        code,
        `TikTok task rejected by local policy: ${code}`,
      );
      return;
    }
  }

  if (tiktok?.scriptParams && tiktok.request.action !== "status") {
    try {
      const attestation = await attestTikTokNetwork(
        config.tiktok.networkPolicy,
        {
          readConnectivityState: () =>
            readRootCommand(
              "dumpsys connectivity | grep 'NetworkAgentInfo'",
            ),
        },
      );
      if (attestation) {
        console.log(
          `[TikTok] Network policy passed ipv4=${attestation.ipv4Countries.join(",")} ipv6=${attestation.ipv6.status} durationMs=${attestation.durationMs}`,
        );
      }
    } catch (error) {
      const code = tikTokNetworkPolicyError(error);
      recordTikTokFailure(tiktok, code);
      publishTaskResult(
        request,
        startedAt,
        "REJECTED",
        code,
        "TikTok task was blocked by the device network policy",
        tikTokPublicationResult(tiktok),
      );
      queuedTaskIds.delete(request.taskId);
      isStartingTask = false;
      setTimeout(processNextTask, 100);
      return;
    }
  }

  if (tiktok?.scriptParams) {
    try {
      await runRootCommand(`am force-stop --user 0 ${tikTokPackageName}`);
    } catch (error) {
      recordTikTokFailure(tiktok, "TIKTOK_RESET_FAILED");
      publishTaskResult(
        request,
        startedAt,
        "REJECTED",
        "TIKTOK_RESET_FAILED",
        error instanceof Error ? error.message : String(error),
        tikTokPublicationResult(tiktok),
      );
      queuedTaskIds.delete(request.taskId);
      isStartingTask = false;
      setTimeout(processNextTask, 100);
      return;
    }
  }

  if (tiktok?.request.action === "publish") {
    try {
      adbKeyboardActive = await adbKeyboardManager.activateForPublish(
        request.taskId,
      );
    } catch (error) {
      const restorePending = adbKeyboardManager.hasPendingRecovery();
      recordTikTokFailure(tiktok, "ADB_KEYBOARD_PREPARE_FAILED");
      publishTaskResult(
        request,
        startedAt,
        "REJECTED",
        "ADB_KEYBOARD_PREPARE_FAILED",
        error instanceof Error ? error.message : String(error),
        tikTokPublicationResult(tiktok),
      );
      queuedTaskIds.delete(request.taskId);
      isStartingTask = false;
      if (restorePending) {
        console.error(
          "[TikTok] AdbKeyboard rollback is pending; restarting client",
        );
        setTimeout(() => process.exit(1), 250);
      } else {
        setTimeout(processNextTask, 100);
      }
      return;
    }
    if (Date.now() >= deadlineAt) {
      recordTikTokFailure(tiktok, "TASK_EXPIRED_DURING_IME_PREPARE");
      publishTaskResult(
        request,
        startedAt,
        "TIMEOUT",
        "TASK_EXPIRED_DURING_IME_PREPARE",
        "TikTok task expired while preparing the trusted input method",
        tikTokPublicationResult(tiktok),
      );
      queuedTaskIds.delete(request.taskId);
      isStartingTask = false;
      try {
        if (adbKeyboardActive) await adbKeyboardManager.restore();
      } catch (error) {
        console.error("[TikTok] AdbKeyboard restore failed", error);
        setTimeout(() => process.exit(1), 250);
        return;
      }
      setTimeout(processNextTask, 100);
      return;
    }
  }

  try {
    await ensureAutoJsAccessibilityService();
    const scriptBody = readRegisteredScript(definition);
    fs.writeFileSync(
      localPath,
      buildWrappedScript(
        scriptRequest,
        scriptBody,
        resultPath,
        checkpointPath,
        checkpointAckPath,
        deadlineAt,
      ),
      "utf8",
    );
    await runRootCommand(
      `rm -f ${shellQuote(resultPath)} ${shellQuote(checkpointPath)} ${shellQuote(checkpointAckPath)} && cp ${shellQuote(localPath)} ${shellQuote(targetPath)} && chmod 600 ${shellQuote(targetPath)} && rm -f ${shellQuote(localPath)}`,
    );
  } catch (error) {
    recordTikTokFailure(tiktok, "SCRIPT_PREPARE_FAILED");
    if (adbKeyboardActive) {
      try {
        await adbKeyboardManager.restore();
        adbKeyboardActive = false;
      } catch (restoreError) {
        publishTaskResult(
          request,
          startedAt,
          "FAILURE",
          "ADB_KEYBOARD_RESTORE_FAILED",
          "Input method restore failed; the mobile client will restart",
          tikTokPublicationResult(tiktok as PreparedTikTokTask),
        );
        queuedTaskIds.delete(request.taskId);
        isStartingTask = false;
        console.error("[TikTok] AdbKeyboard restore failed", restoreError);
        setTimeout(() => process.exit(1), 250);
        return;
      }
    }
    rejectQueuedTask(
      request,
      "SCRIPT_PREPARE_FAILED",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  let firstResultSeenAt = 0;
  const pollInterval = setInterval(async () => {
    const current = activeTask;
    if (
      current?.request.taskId === request.taskId &&
      fs.existsSync(checkpointPath)
    ) {
      try {
        const checkpoint: unknown = JSON.parse(
          fs.readFileSync(checkpointPath, "utf8"),
        );
        if (isRecord(checkpoint) && typeof checkpoint.phase === "string") {
          if (
            current.tiktok &&
            checkpoint.publicationId !== current.tiktok.request.publicationId
          ) {
            throw new Error("TikTok checkpoint publicationId mismatch");
          }
          const checkpointChanged =
            current.checkpointPhase !== checkpoint.phase;
          current.checkpointPhase = checkpoint.phase;
          if (checkpoint.phase === "EDITOR_READY") {
            fs.writeFileSync(checkpointAckPath, checkpoint.phase, "utf8");
          }
          if (
            checkpoint.phase === "COMMITTING" ||
            checkpoint.phase === "SUBMITTED"
          ) {
            current.sideEffectCommitted = true;
            if (checkpointChanged && current.tiktok) {
              const baselinePostIds = Array.isArray(checkpoint.baselinePostIds)
                ? checkpoint.baselinePostIds.filter(
                    (value): value is string => typeof value === "string",
                  )
                : undefined;
              const baselineTileCount =
                typeof checkpoint.baselineTileCount === "number"
                  ? checkpoint.baselineTileCount
                  : undefined;
              applyTikTokPublicationCheckpoint(current.tiktok, {
                baselinePostIds,
                baselineTileCount,
                postId:
                  typeof checkpoint.postId === "string"
                    ? checkpoint.postId
                    : undefined,
                canonicalUrl:
                  typeof checkpoint.canonicalUrl === "string"
                    ? checkpoint.canonicalUrl
                    : undefined,
              });
              markTikTokPublicationPhase(
                current.tiktok,
                checkpoint.phase,
              );
            }
            fs.writeFileSync(checkpointAckPath, checkpoint.phase, "utf8");
          }
        }
      } catch (error) {
        console.warn(`[TASK] Ignored malformed TikTok checkpoint`, error);
      }
    }
    if (!fs.existsSync(resultPath)) return;
    if (!firstResultSeenAt) firstResultSeenAt = Date.now();
    try {
      const result = parseResultFile(fs.readFileSync(resultPath, "utf8"));
      if (tiktok) applyTikTokScriptResult(tiktok, result.data);
      publishTaskResult(
        request,
        startedAt,
        result.status,
        result.code,
        result.message,
        tiktok ? sanitizeTikTokResult(result.data) : result.data,
      );
      await cleanupActiveTask();
    } catch (error) {
      if (Date.now() - firstResultSeenAt < 3000) return;
      publishTaskResult(
        request,
        startedAt,
        "FAILURE",
        "RESULT_PARSE_FAILED",
        error instanceof Error ? error.message : String(error),
      );
      recordTikTokFailure(tiktok, "RESULT_PARSE_FAILED", Boolean(activeTask?.sideEffectCommitted));
      await cleanupActiveTask();
    }
  }, config.tasks.resultPollIntervalMs);

  const currentTask: ActiveTask = {
    request,
    startedAt,
    deadlineAt,
    sideEffectCommitted: false,
    checkpointPhase: "",
    timeoutTimer: null,
    pollInterval,
    tempFilePath: targetPath,
    resultFilePath: resultPath,
    checkpointFilePath: checkpointPath,
    checkpointAckFilePath: checkpointAckPath,
    engineStopScriptPath,
    engineStopResultPath,
    tiktok,
    adbKeyboardActive,
  };
  activeTask = currentTask;
  scheduleActiveTaskTimeout(currentTask);
  isStartingTask = false;

  const queuedPreemptor = taskQueue.find((queued) =>
    canPreemptRunning(queued.request, request),
  );
  if (queuedPreemptor) {
    await preemptActiveTask(queuedPreemptor.request);
    if (activeTask !== currentTask) return;
  }

  try {
    await runRootCommand(
      `am start -n ${autojsPackageName}/org.autojs.autojs.external.open.RunIntentActivity -d file://${targetPath} -t text/javascript`,
    );
    console.log(
      `[TASK] Started ${request.taskId} ${request.scriptId} timeout=${timeoutMs}ms`,
    );
  } catch (error) {
    recordTikTokFailure(tiktok, "AUTOJS_LAUNCH_FAILED");
    publishTaskResult(
      request,
      startedAt,
      "FAILURE",
      "AUTOJS_LAUNCH_FAILED",
      error instanceof Error ? error.message : String(error),
    );
    await cleanupActiveTask();
  }
}

/** 串行执行队列中的下一项任务。 */
function processNextTask(): void {
  if (activeTask || isStartingTask) return;
  const queued = taskQueue.shift();
  if (queued) {
    const request = queued.request;
    isStartingTask = true;
    void executeTask(request).catch((error) => {
      publishTaskResult(
        request,
        Date.now(),
        "FAILURE",
        "CLIENT_EXECUTOR_ERROR",
        error instanceof Error ? error.message : String(error),
      );
      queuedTaskIds.delete(request.taskId);
      isStartingTask = false;
      setTimeout(processNextTask, 100);
    });
  }
}

/** 校验、去重并将收到的任务加入本机优先队列。 */
async function enqueueTask(value: unknown): Promise<void> {
  let request: DeviceTaskRequest;
  try {
    request = parseDeviceTaskRequest(value);
  } catch (error) {
    console.warn("[TASK] Rejected malformed v2 payload", error);
    return;
  }
  if (request.deviceId !== deviceId) {
    publishTaskResult(
      request,
      Date.now(),
      "REJECTED",
      "DEVICE_MISMATCH",
      "Task targets another device",
    );
    return;
  }
  if (queuedTaskIds.has(request.taskId)) {
    console.warn(`[TASK] Ignored duplicate task ${request.taskId}`);
    return;
  }
  if (taskQueue.length >= config.tasks.queueLimit) {
    const evictionIndex = findHighPriorityEvictionIndex(taskQueue, request);
    if (evictionIndex < 0) {
      publishTaskResult(
        request,
        Date.now(),
        "REJECTED",
        "QUEUE_FULL",
        "Device task queue is full",
      );
      return;
    }
    const [evicted] = taskQueue.splice(evictionIndex, 1);
    queuedTaskIds.delete(evicted.request.taskId);
    publishTaskResult(
      evicted.request,
      Date.now(),
      "CANCELLED",
      "QUEUE_EVICTED",
      `Queued task was replaced by high-priority task ${request.taskId}`,
      { replacedByTaskId: request.taskId },
    );
  }
  queuedTaskIds.add(request.taskId);
  insertQueuedTask(taskQueue, { request, sequence: queueSequence++ });
  if (activeTask) await preemptActiveTask(request);
  processNextTask();
}

mqttClient.on("connect", () => {
  mqttClient.subscribe(tasksTopic, { qos: config.mqtt.qos }, (error) => {
    if (error) {
      console.error(`[MQTT] Task subscription failed device=${deviceLogId}`, error);
    } else {
      console.log(`[MQTT] Task subscription ready device=${deviceLogId}`);
    }
  });
  publishReport("presence", presenceTopic, presence("ONLINE"), true);
  void deviceInfoPromise
    .then((info) => publishReport("info", infoTopic, info, true))
    .catch((error) =>
      console.error("[DEVICE_INFO] Static collection failed safely", error),
    );
  void replayTaskResultOutbox();
});

mqttClient.on("message", (topic, payload) => {
  if (topic !== tasksTopic) return;
  try {
    const value: unknown = JSON.parse(payload.toString());
    taskIntakeChain = taskIntakeChain
      .then(() => enqueueTask(value))
      .catch((error) =>
        console.error("[TASK] Failed to process queued task", error),
      );
  } catch (error) {
    console.warn("[TASK] Ignored non-JSON task payload", error);
  }
});

mqttClient.on("error", (error) =>
  console.error("[MQTT] Connection error", error),
);

/** 启动与 MQTT 连接解耦的本地监听和 HTTP 心跳。 */
function startDeviceReporting(): void {
  if (!observersStarted) {
    observersStarted = true;
    void applyObserverConfig().catch((error) =>
      console.error("[EVENT] Failed to start configured observers", error),
    );
  }
  publishReport("presence", presenceTopic, presence("ONLINE"), true);
  void deviceInfoPromise
    .then((info) => publishReport("info", infoTopic, info, true))
    .catch((error) =>
      console.error("[DEVICE_INFO] Static collection failed safely", error),
    );
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    publishReport("presence", presenceTopic, presence("ONLINE"), true);
  }, config.report.heartbeatSeconds * 1000);
  if (resultOutboxRetryTimer) clearInterval(resultOutboxRetryTimer);
  resultOutboxRetryTimer = setInterval(
    () => void replayTaskResultOutbox(),
    30_000,
  );
  void replayTaskResultOutbox();
}

startDeviceReporting();

console.log(`[CLIENT] AutoJS6 device client ${clientVersion} started`);
console.log(
  `[CLIENT] deviceId=configured broker=${redactBrokerUrl(brokerUrl)}`,
);
console.log(`[CLIENT] config=${configPath} MQTT task subscription configured`);
