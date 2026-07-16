import { TaskService } from './task.service.js';
import { MqttService } from './mqtt.service.js';

/**
 * Shell 脚本与命令下发及分发服务类。
 */
export class ShellService {
  private static instance: ShellService;
  private taskService = TaskService.getInstance();

  private constructor() {}

  /**
   * 获取 ShellService 单例实例。
   * 
   * @returns ShellService 实例
   */
  public static getInstance(): ShellService {
    if (!ShellService.instance) {
      ShellService.instance = new ShellService();
    }
    return ShellService.instance;
  }

  /**
   * 向移动端设备下发 Shell 命令行脚本任务。
   * 
   * @param script - 待在 Termux 中执行的 Shell 命令或脚本
   * @param timeout - 超时秒数
   * @param pcIp - PC 端的 IP 地址
   * @param port - PC 端 HTTP 服务的端口号
   * @param useRoot - 是否需要以 Root 权限 (`su -c`) 运行该命令
   * @returns 已创建并下发的 Task 实体
   */
  public async dispatchTask(script: string, timeout: number, pcIp: string, port: number, useRoot = false) {
    const task = this.taskService.createTask('shell', script, timeout);
    
    // 构造推送载荷，注入回调地址和 useRoot 开关
    const payload = {
      taskId: task.taskId,
      cat: 'shell',
      script,
      timeout,
      useRoot,
      callbackUrl: `http://${pcIp}:${port}/api/callback`
    };

    MqttService.getInstance().publish('autojs6/tasks', payload);
    console.log(`[ShellService] Dispatched Shell task ${task.taskId} to mobile, useRoot: ${useRoot}`);
    return task;
  }
}
