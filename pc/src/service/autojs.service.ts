import { TaskService } from './task.service.js';
import { MqttService } from './mqtt.service.js';

export class AutojsService {
  private static instance: AutojsService;
  private taskService = TaskService.getInstance();

  private constructor() {}

  public static getInstance(): AutojsService {
    if (!AutojsService.instance) {
      AutojsService.instance = new AutojsService();
    }
    return AutojsService.instance;
  }

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
