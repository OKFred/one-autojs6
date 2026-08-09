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
  | "client.self-update";

/** Node Server 返回的任务创建结果。 */
export interface DispatchedTask {
  taskId: string;
  status: "PENDING";
  traceId: string;
  expiresAtUtc: number;
}

/** Node Server 任务详情的 PC 兼容视图。 */
export interface RemoteTask {
  taskId: string;
  clientId: string;
  scriptId: string | null;
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

/**
 * PC 到 Node Server 的唯一设备任务网关。
 * PC 不直接向手机发布任务，也不传输脚本源码。
 */
export class NodeServerService {
  private static instance: NodeServerService;

  private constructor() {}

  /** 获取 Node Server 网关单例。 */
  public static getInstance(): NodeServerService {
    if (!NodeServerService.instance) {
      NodeServerService.instance = new NodeServerService();
    }
    return NodeServerService.instance;
  }

  /** 调用 Node Server 的 POST API 并解析标准响应信封。 */
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

  /** 下发一项手机本地可信脚本任务。 */
  public async dispatch(
    scriptId: TrustedScriptId,
    params: Record<string, unknown>,
    timeoutSeconds: number,
    clientId?: string,
  ): Promise<DispatchedTask> {
    const targetClientId =
      clientId || String(process.env.AUTOJS6_CLIENT_ID || "");
    if (!targetClientId) throw new Error("AUTOJS6_CLIENT_ID is required");
    const normalizedTimeout = Number.isFinite(timeoutSeconds)
      ? Math.min(900, Math.max(1, Math.trunc(timeoutSeconds)))
      : 120;
    return this.request<DispatchedTask>("/admin/mobile/async-task/dispatch", {
      clientId: targetClientId,
      scriptId,
      params,
      timeoutMs: normalizedTimeout * 1000,
      remark: "Dispatched by one-autojs6 PC compatibility API",
    });
  }

  /** 查询单个设备任务。 */
  public async getTask(taskId: string): Promise<RemoteTask> {
    return this.request<RemoteTask>("/admin/mobile/async-task/get", { taskId });
  }

  /** 查询最近的设备任务。 */
  public async listTasks(clientId?: string): Promise<TaskListResult> {
    const targetClientId =
      clientId || String(process.env.AUTOJS6_CLIENT_ID || "");
    return this.request<TaskListResult>("/admin/mobile/async-task/list", {
      pageNo: 1,
      pageSize: 100,
      ...(targetClientId ? { clientId: targetClientId } : {}),
      descend: true,
    });
  }
}
