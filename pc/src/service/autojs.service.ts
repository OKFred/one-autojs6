import { TaskService } from './task.service.js';
import { MqttService } from './mqtt.service.js';

/**
 * AutoJS 脚本下发与分发服务类。
 */
export class AutojsService {
  private static instance: AutojsService;
  private taskService = TaskService.getInstance();

  private constructor() {}

  /**
   * 获取 AutojsService 单例实例。
   * 
   * @returns AutojsService 实例
   */
  public static getInstance(): AutojsService {
    if (!AutojsService.instance) {
      AutojsService.instance = new AutojsService();
    }
    return AutojsService.instance;
  }

  /**
   * 向移动端设备下发 Auto.js 脚本任务。
   * 
   * @param script - 待执行的 Auto.js 脚本代码
   * @param timeout - 超时秒数
   * @param pcIp - PC 端的 IP 地址
   * @param port - PC 端 HTTP 服务的端口号
   * @returns 已创建并下发的 Task 实体
   */
  public async dispatchTask(script: string, timeout: number, pcIp: string, port: number) {
    const task = this.taskService.createTask('autojs6', script, timeout);
    
    // 构造推送载荷，注入回调地址
    const payload = {
      taskId: task.taskId,
      cat: 'autojs6',
      script,
      timeout,
      callbackUrl: `http://${pcIp}:${port}/api/callback`
    };

    MqttService.getInstance().publish('autojs6/tasks', payload);
    console.log(`[AutojsService] Dispatched Auto.js task ${task.taskId} to mobile`);
    return task;
  }
}
