import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mqtt from "mqtt";

import { loadConfig } from "./config.js";
import {
  PROTOCOL_VERSION,
  isRecord,
  parseDeviceTaskRequest,
  type DeviceEventPayload,
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
} from "./task-registry.js";
import { getEmqxBrokerUrl } from "./utils/mqtt.js";

const currentFile = fileURLToPath(import.meta.url);
const sourceDirectory = path.dirname(currentFile);
const mobileRoot = path.resolve(sourceDirectory, "..");
const logsDirectory = path.join(mobileRoot, "logs");
const clientVersion = "2.0.0";

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
const tempScriptDirectory = process.env.TEMP_SCRIPT_DIR || "/sdcard/Download";
const tasksTopic = `autojs6/v2/devices/${deviceId}/tasks`;
const resultsTopic = `autojs6/v2/devices/${deviceId}/results`;
const eventsTopic = `autojs6/v2/devices/${deviceId}/events`;
const presenceTopic = `autojs6/v2/devices/${deviceId}/presence`;

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
  timeoutTimer: NodeJS.Timeout;
  pollInterval: NodeJS.Timeout;
  tempFilePath: string;
  resultFilePath: string;
}

interface ScriptResultFile {
  status: TaskStatus;
  code: string;
  message: string;
  data: unknown;
}

const taskQueue: DeviceTaskRequest[] = [];
const queuedTaskIds = new Set<string>();
let activeTask: ActiveTask | null = null;
let isStartingTask = false;
let observerWatcher: NodeJS.Timeout | null = null;
let lastEventsSize = 0;
const lastPublishedEvents = new Map<
  string,
  { key: string; timestamp: number }
>();

/** 构造设备能力与在线状态消息。 */
function presence(status: "ONLINE" | "OFFLINE"): DevicePresencePayload {
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    status,
    clientVersion,
    timestamp: Date.now(),
    scripts: listRegisteredScripts().map(({ scriptId, version }) => ({
      scriptId,
      version,
    })),
  };
}

const mqttClient = mqtt.connect(brokerUrl, {
  clean: false,
  clientId: deviceId,
  properties: { sessionExpiryInterval: config.mqtt.sessionExpirySeconds },
  will: {
    topic: presenceTopic,
    payload: JSON.stringify(presence("OFFLINE")),
    qos: config.mqtt.qos,
    retain: true,
  },
});

/** 使用 `su -c` 执行仅由本地代码构造的 Android 命令。 */
function runRootCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("su", ["-c", command], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** 为本地生成的路径添加 POSIX shell 单引号。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** 将设备事件按配置防抖后发布。 */
function publishEvent(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== "string") return;
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
    deviceId,
    type: value.type,
    timestamp,
    data,
  };
  mqttClient.publish(eventsTopic, JSON.stringify(payload), {
    qos: config.mqtt.qos,
  });
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

  const observerPath = path.join(tempScriptDirectory, "autojs_observer.js");
  const eventPath = path.join(tempScriptDirectory, "autojs_events.txt");
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
    `cp ${shellQuote(localControlPath)} ${shellQuote(observerControlPath)} && cp ${shellQuote(localPath)} ${shellQuote(observerPath)} && chmod 600 ${shellQuote(observerControlPath)} ${shellQuote(observerPath)} && rm -f ${shellQuote(localControlPath)} ${shellQuote(localPath)} && am start -n ${autojsPackageName}/org.autojs.autojs.external.open.RunIntentActivity -d file://${observerPath} -t text/javascript`,
  );

  lastEventsSize = fs.existsSync(eventPath) ? fs.statSync(eventPath).size : 0;
  observerWatcher = setInterval(() => {
    if (!fs.existsSync(eventPath)) return;
    try {
      const size = fs.statSync(eventPath).size;
      if (size < lastEventsSize) lastEventsSize = 0;
      if (size === lastEventsSize) return;
      const descriptor = fs.openSync(eventPath, "r");
      const buffer = Buffer.alloc(size - lastEventsSize);
      fs.readSync(descriptor, buffer, 0, buffer.length, lastEventsSize);
      fs.closeSync(descriptor);
      lastEventsSize = size;
      for (const line of buffer.toString().split("\n").filter(Boolean)) {
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

/** 发布统一任务结果。 */
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
  const resultJson = JSON.stringify(result);
  mqttClient.publish(resultsTopic, resultJson, {
    qos: config.mqtt.qos,
  });
  if (request.callbackUrl) {
    try {
      const callbackUrl = new URL(request.callbackUrl);
      if (
        callbackUrl.protocol === "https:" ||
        callbackUrl.protocol === "http:"
      ) {
        void fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: resultJson,
        })
          .then((response) => {
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
          })
          .catch((error) =>
            console.warn(
              `[TASK] HTTP result callback failed for ${request.taskId}`,
              error,
            ),
          );
      }
    } catch (error) {
      console.warn(
        `[TASK] Ignored invalid callback URL for ${request.taskId}`,
        error,
      );
    }
  }
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

/** 清理当前任务并调度队列中的下一项。 */
function cleanupActiveTask(): void {
  const current = activeTask;
  if (!current) return;
  clearTimeout(current.timeoutTimer);
  clearInterval(current.pollInterval);
  for (const filePath of [current.tempFilePath, current.resultFilePath]) {
    void runRootCommand(`rm -f ${shellQuote(filePath)}`).catch((error) =>
      console.warn(`[TASK] Failed to remove ${filePath}`, error),
    );
  }
  queuedTaskIds.delete(current.request.taskId);
  activeTask = null;
  setTimeout(processNextTask, 100);
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
var taskId = ${JSON.stringify(request.taskId)};
var resPath = ${JSON.stringify(resultPath)};
try {
  device.wakeUp();
  ${trustedBody}
  var parsedTaskData = null;
  try { parsedTaskData = JSON.parse(String(taskResult)); } catch (_) { parsedTaskData = taskResult; }
  files.write(resPath, JSON.stringify({
    status: String(taskStatus),
    code: String(taskCode),
    message: String(taskStatus) === "SUCCESS" ? "Script execution succeeded" : String(taskResult),
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
    ),
  );
  const resultPath = path.join(
    tempScriptDirectory,
    `autojs_res_${request.taskId}.json`,
  );
  const targetPath = path.join(
    tempScriptDirectory,
    `autojs_task_${request.taskId}.js`,
  );
  const localPath = path.join(
    sourceDirectory,
    `local_autojs_task_${request.taskId}.js`,
  );

  try {
    const scriptBody = readRegisteredScript(definition);
    fs.writeFileSync(
      localPath,
      buildWrappedScript(request, scriptBody, resultPath),
      "utf8",
    );
    await runRootCommand(
      `rm -f ${shellQuote(resultPath)} && cp ${shellQuote(localPath)} ${shellQuote(targetPath)} && chmod 600 ${shellQuote(targetPath)} && rm -f ${shellQuote(localPath)}`,
    );
  } catch (error) {
    rejectQueuedTask(
      request,
      "SCRIPT_PREPARE_FAILED",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  let firstResultSeenAt = 0;
  const timeoutTimer = setTimeout(() => {
    if (!activeTask || activeTask.request.taskId !== request.taskId) return;
    void runRootCommand(`am force-stop ${autojsPackageName}`).finally(() => {
      publishTaskResult(
        request,
        startedAt,
        "TIMEOUT",
        "TASK_TIMEOUT",
        `Script exceeded ${timeoutMs}ms and was terminated`,
      );
      cleanupActiveTask();
      setTimeout(() => void applyObserverConfig(), 2000);
    });
  }, timeoutMs);

  const pollInterval = setInterval(() => {
    if (!fs.existsSync(resultPath)) return;
    if (!firstResultSeenAt) firstResultSeenAt = Date.now();
    try {
      const result = parseResultFile(fs.readFileSync(resultPath, "utf8"));
      publishTaskResult(
        request,
        startedAt,
        result.status,
        result.code,
        result.message,
        result.data,
      );
      cleanupActiveTask();
    } catch (error) {
      if (Date.now() - firstResultSeenAt < 3000) return;
      publishTaskResult(
        request,
        startedAt,
        "FAILURE",
        "RESULT_PARSE_FAILED",
        error instanceof Error ? error.message : String(error),
      );
      cleanupActiveTask();
    }
  }, config.tasks.resultPollIntervalMs);

  activeTask = {
    request,
    startedAt,
    timeoutTimer,
    pollInterval,
    tempFilePath: targetPath,
    resultFilePath: resultPath,
  };
  isStartingTask = false;

  try {
    await runRootCommand(
      `am start -n ${autojsPackageName}/org.autojs.autojs.external.open.RunIntentActivity -d file://${targetPath} -t text/javascript`,
    );
    console.log(
      `[TASK] Started ${request.taskId} ${request.scriptId} timeout=${timeoutMs}ms`,
    );
  } catch (error) {
    publishTaskResult(
      request,
      startedAt,
      "FAILURE",
      "AUTOJS_LAUNCH_FAILED",
      error instanceof Error ? error.message : String(error),
    );
    cleanupActiveTask();
  }
}

/** 串行执行队列中的下一项任务。 */
function processNextTask(): void {
  if (activeTask || isStartingTask) return;
  const request = taskQueue.shift();
  if (request) {
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

/** 校验、去重并将收到的任务加入本机队列。 */
function enqueueTask(value: unknown): void {
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
    publishTaskResult(
      request,
      Date.now(),
      "REJECTED",
      "QUEUE_FULL",
      "Device task queue is full",
    );
    return;
  }
  queuedTaskIds.add(request.taskId);
  taskQueue.push(request);
  processNextTask();
}

mqttClient.on("connect", () => {
  mqttClient.subscribe(tasksTopic, { qos: config.mqtt.qos }, (error) => {
    if (error) console.error(`[MQTT] Failed to subscribe ${tasksTopic}`, error);
    else console.log(`[MQTT] Subscribed ${tasksTopic}`);
  });
  mqttClient.publish(presenceTopic, JSON.stringify(presence("ONLINE")), {
    qos: config.mqtt.qos,
    retain: true,
  });
  void applyObserverConfig().catch((error) =>
    console.error("[EVENT] Failed to start configured observers", error),
  );
});

mqttClient.on("message", (topic, payload) => {
  if (topic !== tasksTopic) return;
  try {
    enqueueTask(JSON.parse(payload.toString()) as unknown);
  } catch (error) {
    console.warn("[TASK] Ignored non-JSON task payload", error);
  }
});

mqttClient.on("error", (error) =>
  console.error("[MQTT] Connection error", error),
);

console.log(`[CLIENT] AutoJS6 device client ${clientVersion} started`);
console.log(
  `[CLIENT] deviceId=${deviceId} broker=${redactBrokerUrl(brokerUrl)}`,
);
console.log(`[CLIENT] config=${configPath} taskTopic=${tasksTopic}`);
