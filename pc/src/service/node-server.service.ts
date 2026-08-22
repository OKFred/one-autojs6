import { MqttService } from "./mqtt.service.js";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const LOCAL_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set([
  "SUCCESS",
  "FAILURE",
  "TIMEOUT",
  "REJECTED",
  "CANCELLED",
]);

/** 手机任务调度优先级。 */
export type TaskPriority = "LOW" | "NORMAL" | "HIGH";

/** Node Server 标准响应信封。 */
interface ApiEnvelope<T> {
  ok: boolean;
  message: string;
  data: T;
}

/** PC 允许请求的手机可信脚本标识。 */
export type TrustedScriptId =
  | "device.apps.list"
  | "app.install"
  | "app.version.check"
  | "app.update.store"
  | "app.update.zip"
  | "file.download"
  | "tiktok.post"
  | "device.network.switch";

/** Node Server 客户端部署视图。 */
export interface ClientDeployment {
  deploymentId: string;
  clientId: string;
  releaseVersion: string;
  environment: "development" | "staging" | "production";
  environmentRevision: number;
  activationMode: "GRACEFUL" | "FORCE";
  phase: string;
  resultCode: string | null;
  resultMessage: string | null;
  createTimeUtc: number;
  finishedAtUtc: number | null;
}

export interface NetworkRoutingView {
  id: number;
  clientId: string;
  policyRevision: number;
  generation: number;
  lanCidrs: string[];
  lanProbeUrls: string[];
  internetProbeUrl: string;
  probeTimeoutMs: number;
  desiredTarget: "wifi" | "carrier" | null;
  actualTarget: "wifi" | "carrier" | null;
  state: string;
  lastTaskId: string | null;
  lastErrorCode: string | null;
  lastResult: Record<string, unknown> | null;
  lastVerifiedTimeUtc: number | null;
}

export interface NetworkRoutingTask {
  taskId: string;
  status: "PENDING";
  generation: number;
  traceId: string;
  expiresAtUtc: number;
}

/** Node Server 返回的任务创建结果。 */
export interface DispatchedTask {
  taskId: string;
  status: "PENDING" | "EXECUTING";
  traceId: string;
  expiresAtUtc: number;
}

/** Node Server 任务详情的 PC 兼容视图。 */
export interface RemoteTask {
  taskId: string;
  clientId: string;
  scriptId: string | null;
  traceId: string | null;
  priority: TaskPriority;
  preemptRunning: boolean;
  preemptedByTaskId: string | null;
  status: string;
  resultMessage: string | null;
  resultCode: string | null;
  resultDataJson: string | null;
  createTimeUtc: number;
  expiresAtUtc: number;
  finishedAtUtc: number | null;
  [key: string]: unknown;
}

interface TaskListResult {
  list: RemoteTask[];
  total: number;
  totalPage: number;
  currentPage: number;
  pageNo: number;
  pageSize: number;
}

export interface DeviceTaskResultPayload {
  protocolVersion: 2;
  taskId: string;
  deviceId: string;
  scriptId: string;
  status: "SUCCESS" | "FAILURE" | "TIMEOUT" | "REJECTED" | "CANCELLED";
  code: string;
  message: string;
  data: unknown;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  traceId: string;
}

/** 普通 JSON 对象类型守卫。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 严格解析设备任务终态。 */
export function parseTaskResult(
  value: unknown,
): DeviceTaskResultPayload | null {
  if (!isRecord(value) || value.protocolVersion !== 2) return null;
  const stringKeys = [
    "taskId",
    "deviceId",
    "scriptId",
    "status",
    "code",
    "message",
    "traceId",
  ] as const;
  if (stringKeys.some((key) => typeof value[key] !== "string")) return null;
  if (!TERMINAL_STATUSES.has(value.status as string)) return null;
  const numberKeys = ["startedAt", "finishedAt", "durationMs"] as const;
  if (
    numberKeys.some(
      (key) => typeof value[key] !== "number" || !Number.isFinite(value[key]),
    )
  ) {
    return null;
  }
  return {
    protocolVersion: 2,
    taskId: value.taskId as string,
    deviceId: value.deviceId as string,
    scriptId: value.scriptId as string,
    status: value.status as DeviceTaskResultPayload["status"],
    code: value.code as string,
    message: value.message as string,
    data: value.data ?? null,
    startedAt: value.startedAt as number,
    finishedAt: value.finishedAt as number,
    durationMs: value.durationMs as number,
    traceId: value.traceId as string,
  };
}

/** 校验结果是否精确属于本地已知任务与 Topic。 */
export function isMatchingTaskResult(
  task: RemoteTask,
  topicDeviceId: string,
  result: DeviceTaskResultPayload,
): boolean {
  return (
    !TERMINAL_STATUSES.has(task.status) &&
    task.clientId === topicDeviceId &&
    task.clientId === result.deviceId &&
    task.taskId === result.taskId &&
    task.scriptId === result.scriptId &&
    task.traceId === result.traceId
  );
}

/** 返回脚本未显式指定时的默认优先级。 */
function defaultPriority(scriptId: TrustedScriptId): TaskPriority {
  return scriptId === "device.network.switch" ? "HIGH" : "NORMAL";
}

/** 校验运行时优先级输入。 */
function normalizePriority(
  value: TaskPriority | undefined,
  scriptId: TrustedScriptId,
): TaskPriority {
  if (value === undefined) return defaultPriority(scriptId);
  if (value !== "LOW" && value !== "NORMAL" && value !== "HIGH") {
    throw new Error("priority must be LOW, NORMAL, or HIGH");
  }
  return value;
}

/** PC 到 Node Server / 外部 MQTT 的设备任务网关。 */
export class NodeServerService {
  private static instance: NodeServerService;
  private readonly localTasks = new Map<string, RemoteTask>();

  private constructor() {
    MqttService.getInstance().setTaskResultHandler((topicDeviceId, payload) =>
      this.handleTaskResult(topicDeviceId, payload),
    );
    const cleanupTimer = setInterval(() => this.cleanupLocalTasks(), 60_000);
    cleanupTimer.unref();
  }

  /** 获取 Node Server 网关单例。 */
  public static getInstance(): NodeServerService {
    if (!NodeServerService.instance) {
      NodeServerService.instance = new NodeServerService();
    }
    return NodeServerService.instance;
  }

  /** 将本地过期任务置为超时。 */
  private refreshLocalTask(task: RemoteTask, now = Date.now()): void {
    if (
      !TERMINAL_STATUSES.has(task.status) &&
      task.expiresAtUtc > 0 &&
      task.expiresAtUtc <= now
    ) {
      task.status = "TIMEOUT";
      task.resultCode = "SERVER_TIMEOUT";
      task.resultMessage = "PC waited for the device result until timeout";
      task.finishedAtUtc = now;
    }
  }

  /** 清理超过保留期的本地终态记录。 */
  private cleanupLocalTasks(): void {
    const now = Date.now();
    for (const [taskId, task] of this.localTasks) {
      this.refreshLocalTask(task, now);
      if (
        task.finishedAtUtc !== null &&
        task.finishedAtUtc < now - LOCAL_TASK_RETENTION_MS
      ) {
        this.localTasks.delete(taskId);
      }
    }
  }

  /** 严格关联并保存直接 MQTT 回传。 */
  public handleTaskResult(topicDeviceId: string, payload: unknown): void {
    const result = parseTaskResult(payload);
    if (!result || result.deviceId !== topicDeviceId) return;
    const existing = this.localTasks.get(result.taskId);
    if (!existing) return;
    this.refreshLocalTask(existing);
    if (!isMatchingTaskResult(existing, topicDeviceId, result)) return;
    existing.status = result.status;
    existing.resultCode = result.code;
    existing.resultMessage = result.message;
    existing.resultDataJson = JSON.stringify(result.data ?? null);
    existing.finishedAtUtc = result.finishedAt;
    if (
      result.status === "CANCELLED" &&
      isRecord(result.data) &&
      typeof result.data.preemptedByTaskId === "string"
    ) {
      existing.preemptedByTaskId = result.data.preemptedByTaskId;
    }
  }

  /** 调用 Node Server POST API 并解析标准响应信封。 */
  private async request<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const baseUrl = String(process.env.NODE_SERVER_BASE_URL || "").replace(
      /\/$/,
      "",
    );
    const token = String(process.env.NODE_SERVER_TOKEN || "");
    if (!baseUrl) throw new Error("NODE_SERVER_BASE_URL is required");
    if (!token) throw new Error("NODE_SERVER_TOKEN is required");
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const responseText = await response.text();
    let payload: ApiEnvelope<T>;
    try {
      payload = JSON.parse(responseText) as ApiEnvelope<T>;
    } catch {
      throw new Error(
        `Node Server HTTP ${response.status}: ${responseText.slice(0, 500)}`,
      );
    }
    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || `Node Server HTTP ${response.status}`);
    }
    return payload.data;
  }

  /** 按显式配置或唯一在线设备解析目标设备。 */
  private resolveTargetClientId(clientId?: string): string {
    const configured = String(process.env.AUTOJS6_CLIENT_ID || "").trim();
    const target =
      String(clientId || "").trim() ||
      configured ||
      MqttService.getInstance().getUniqueOnlineDeviceId() ||
      "";
    if (!target) {
      throw new Error(
        "clientId is required when there is not exactly one recently ONLINE device",
      );
    }
    if (!DEVICE_ID_PATTERN.test(target)) {
      throw new Error("clientId contains unsupported characters");
    }
    return target;
  }

  /** 下发一项手机本地可信脚本任务。 */
  public async dispatch(
    scriptId: TrustedScriptId,
    params: Record<string, unknown>,
    timeoutSeconds: number,
    clientId?: string,
    requestedPriority?: TaskPriority,
    preemptRunning = false,
  ): Promise<DispatchedTask> {
    const targetClientId = this.resolveTargetClientId(clientId);
    const priority = normalizePriority(requestedPriority, scriptId);
    if (typeof preemptRunning !== "boolean") {
      throw new Error("preemptRunning must be a boolean");
    }
    let normalizedTimeout = Number.isFinite(timeoutSeconds)
      ? Math.min(900, Math.max(1, Math.trunc(timeoutSeconds)))
      : 120;
    if (scriptId === "device.network.switch") {
      const target = String(params.target || "").toLowerCase();
      if (target !== "wifi" && target !== "ethernet" && target !== "carrier") {
        throw new Error("network target must be wifi, ethernet, or carrier");
      }
      const detectionTimeoutMs = params.timeoutMs ?? 20_000;
      if (
        typeof detectionTimeoutMs !== "number" ||
        !Number.isFinite(detectionTimeoutMs) ||
        detectionTimeoutMs < 1_000 ||
        detectionTimeoutMs > 120_000
      ) {
        throw new Error(
          "network detection timeoutMs must be between 1000 and 120000",
        );
      }
      normalizedTimeout = Math.min(
        150,
        Math.max(normalizedTimeout, Math.ceil(detectionTimeoutMs / 1_000) + 20),
      );
    }
    const baseUrl = String(process.env.NODE_SERVER_BASE_URL || "").trim();
    if (baseUrl) {
      return this.request<DispatchedTask>("/admin/mobile/async-task/dispatch", {
        clientId: targetClientId,
        scriptId,
        params,
        timeoutMs: normalizedTimeout * 1000,
        priority,
        preemptRunning,
        remark: "Dispatched by one-autojs6 PC compatibility API",
      });
    }
    const mqttService = MqttService.getInstance();
    if (!mqttService.hasExternalBroker()) {
      throw new Error(
        "Standalone trusted tasks require an authenticated external MQTT Broker",
      );
    }

    const taskId = crypto.randomUUID();
    const traceId = crypto.randomUUID();
    const now = Date.now();
    const expiresAtUtc = now + normalizedTimeout * 1000;
    const taskRecord: RemoteTask = {
      taskId,
      clientId: targetClientId,
      scriptId,
      traceId,
      priority,
      preemptRunning,
      preemptedByTaskId: null,
      status: "EXECUTING",
      resultMessage: null,
      resultCode: null,
      resultDataJson: null,
      createTimeUtc: now,
      expiresAtUtc,
      finishedAtUtc: null,
    };
    this.localTasks.set(taskId, taskRecord);
    try {
      await mqttService.publishExternal(
        `autojs6/v2/devices/${targetClientId}/tasks`,
        {
          protocolVersion: 2,
          taskId,
          deviceId: targetClientId,
          scriptId,
          params,
          timeoutMs: normalizedTimeout * 1000,
          createdAt: now,
          expiresAt: expiresAtUtc,
          traceId,
          priority,
          preemptRunning,
        },
      );
    } catch (error) {
      taskRecord.status = "FAILURE";
      taskRecord.resultCode = "MQTT_PUBLISH_FAILED";
      taskRecord.resultMessage =
        error instanceof Error ? error.message : String(error);
      taskRecord.finishedAtUtc = Date.now();
      throw error;
    }
    return { taskId, status: "EXECUTING", traceId, expiresAtUtc };
  }

  /** 查询单个设备任务。 */
  public async getTask(taskId: string): Promise<RemoteTask> {
    const baseUrl = String(process.env.NODE_SERVER_BASE_URL || "").trim();
    if (baseUrl) {
      return this.request<RemoteTask>("/admin/mobile/async-task/get", {
        taskId,
      });
    }
    const local = this.localTasks.get(taskId);
    if (local) {
      this.refreshLocalTask(local);
      return local;
    }
    return {
      taskId,
      clientId: "",
      scriptId: null,
      traceId: null,
      priority: "NORMAL",
      preemptRunning: false,
      preemptedByTaskId: null,
      status: "MISSING",
      resultMessage: "Task not found in local system",
      resultCode: "NOT_FOUND",
      resultDataJson: null,
      createTimeUtc: 0,
      expiresAtUtc: 0,
      finishedAtUtc: null,
    };
  }

  /** 查询最近的设备任务。 */
  public async listTasks(clientId?: string): Promise<TaskListResult> {
    const baseUrl = String(process.env.NODE_SERVER_BASE_URL || "").trim();
    if (baseUrl) {
      const targetClientId = clientId
        ? this.resolveTargetClientId(clientId)
        : String(process.env.AUTOJS6_CLIENT_ID || "").trim();
      return this.request<TaskListResult>("/admin/mobile/async-task/list", {
        pageNo: 1,
        pageSize: 100,
        ...(targetClientId ? { clientId: targetClientId } : {}),
        descend: true,
      });
    }
    this.cleanupLocalTasks();
    const list = [...this.localTasks.values()]
      .filter((task) => !clientId || task.clientId === clientId)
      .sort((left, right) => right.createTimeUtc - left.createTimeUtc);
    return {
      list,
      total: list.length,
      totalPage: list.length > 0 ? 1 : 0,
      currentPage: 1,
      pageNo: 1,
      pageSize: 100,
    };
  }

  /** 通过 Node Server 创建不可变客户端部署。 */
  public async applyClientDeployment(input: {
    clientId: string;
    releaseVersion: string;
    environment: "development" | "staging" | "production";
    activationMode: "GRACEFUL" | "FORCE";
    drainTimeoutMs?: number;
    confirmForce?: boolean;
  }): Promise<ClientDeployment> {
    if (!String(process.env.NODE_SERVER_BASE_URL || "").trim()) {
      throw new Error("Client deployment requires NODE_SERVER_BASE_URL");
    }
    const { confirmForce, ...deployment } = input;
    return this.request<ClientDeployment>(
      "/admin/mobile/client-deployment/apply",
      {
        ...deployment,
        forceConfirmed: confirmForce === true,
      },
    );
  }

  /** 查询客户端部署状态。 */
  public async getClientDeployment(
    deploymentId: string,
  ): Promise<ClientDeployment> {
    return this.request<ClientDeployment>(
      "/admin/mobile/client-deployment/get",
      { deploymentId },
    );
  }

  /** 回滚到指定部署的前一个健康组合。 */
  public async rollbackClientDeployment(input: {
    deploymentId: string;
    activationMode: "GRACEFUL" | "FORCE";
    confirmForce?: boolean;
  }): Promise<ClientDeployment> {
    const { confirmForce, ...deployment } = input;
    return this.request<ClientDeployment>(
      "/admin/mobile/client-deployment/rollback",
      { ...deployment, forceConfirmed: confirmForce === true },
    );
  }

  /** 查询 Node Server 持有的每设备网络分流配置。 */
  public getNetworkRouting(clientId: string): Promise<NetworkRoutingView> {
    return this.request<NetworkRoutingView>(
      "/admin/mobile/network-routing/get",
      {
        clientId: this.resolveTargetClientId(clientId),
      },
    );
  }

  /** 仅通过 Node Server 控制面应用持久网络分流。 */
  public applyNetworkRouting(input: {
    clientId: string;
    internetTarget: "wifi" | "carrier";
  }): Promise<NetworkRoutingTask> {
    return this.request<NetworkRoutingTask>(
      "/admin/mobile/network-routing/apply",
      {
        clientId: this.resolveTargetClientId(input.clientId),
        internetTarget: input.internetTarget,
      },
    );
  }

  /** 仅通过 Node Server 控制面停用持久网络分流。 */
  public disableNetworkRouting(clientId: string): Promise<NetworkRoutingTask> {
    return this.request<NetworkRoutingTask>(
      "/admin/mobile/network-routing/disable",
      {
        clientId: this.resolveTargetClientId(clientId),
      },
    );
  }
}
