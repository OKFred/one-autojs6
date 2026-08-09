import {
  NodeServerService,
  type TrustedScriptId,
} from "./node-server.service.js";

/** PC 可信设备任务分发服务。 */
export class AutojsService {
  private static instance: AutojsService;
  private readonly nodeServer = NodeServerService.getInstance();

  private constructor() {}

  /** 获取 AutojsService 单例。 */
  public static getInstance(): AutojsService {
    if (!AutojsService.instance) AutojsService.instance = new AutojsService();
    return AutojsService.instance;
  }

  /**
   * 通过 Node Server 下发手机本地可信脚本。
   *
   * @param scriptId 手机端注册的可信脚本标识。
   * @param params 结构化脚本参数。
   * @param timeoutSeconds 超时秒数。
   * @param clientId 可选目标设备；默认读取 AUTOJS6_CLIENT_ID。
   */
  public async dispatchTask(
    scriptId: TrustedScriptId,
    params: Record<string, unknown>,
    timeoutSeconds: number,
    clientId?: string,
  ) {
    return this.nodeServer.dispatch(scriptId, params, timeoutSeconds, clientId);
  }
}
