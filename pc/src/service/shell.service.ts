import { TaskService } from './task.service.js';
import { MqttService } from './mqtt.service.js';

export class ShellService {
  private static instance: ShellService;
  private taskService = TaskService.getInstance();

  private constructor() {}

  public static getInstance(): ShellService {
    if (!ShellService.instance) {
      ShellService.instance = new ShellService();
    }
    return ShellService.instance;
  }

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
