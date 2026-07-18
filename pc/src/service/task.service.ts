import crypto from 'crypto';
import { MqttService } from './mqtt.service.js';

/**
 * 任务对象结构定义。
 */
export interface Task {
  taskId: string;
  cat: 'autojs6' | 'shell' | 'update';
  script: string;
  status: 'EXECUTING' | 'SUCCESS' | 'FAILURE' | 'MISSING';
  timeout: number;
  createdAt: number;
  message: string;
}

/**
 * 任务管理服务类，在内存中维护任务状态表，并处理超时判定。
 */
export class TaskService {
  private static instance: TaskService;
  private tasks: Record<string, Task> = {};

  private constructor() {
    this.startTimeoutChecker();
  }

  /**
   * 获取 TaskService 单例实例。
   * 
   * @returns TaskService 实例
   */
  public static getInstance(): TaskService {
    if (!TaskService.instance) {
      TaskService.instance = new TaskService();
    }
    return TaskService.instance;
  }

  /**
   * 在内存中创建并初始化一个任务。
   * 
   * @param cat - 任务类型，支持 autojs6、shell 或 update
   * @param script - 待执行脚本或命令内容
   * @param timeout - 任务超时时间(秒)
   * @returns 创建完成的 Task 对象实例
   */
  public createTask(cat: 'autojs6' | 'shell' | 'update', script: string, timeout: number): Task {
    const taskId = crypto.randomUUID();
    const createdAt = Date.now();
    const task: Task = {
      taskId,
      cat,
      script,
      status: 'EXECUTING',
      timeout,
      createdAt,
      message: 'Task dispatched'
    };
    this.tasks[taskId] = task;
    return task;
  }

  /**
   * 根据任务 ID 获取任务对象。
   * 
   * @param taskId - 任务 ID
   * @returns 匹配的 Task 对象，未找到则返回 undefined
   */
  public getTask(taskId: string): Task | undefined {
    return this.tasks[taskId];
  }

  /**
   * 获取系统中所有的任务列表。
   * 
   * @returns 包含所有 Task 的数组
   */
  public getAllTasks(): Task[] {
    return Object.values(this.tasks);
  }

  /**
   * 更新任务状态，并在任务完成时通过 MQTT 触发移动端本地资源的清理。
   * 
   * @param taskId - 任务 ID
   * @param status - 更新后的状态，如 SUCCESS 或 FAILURE
   * @param message - 可选的状态详情信息
   * @returns 是否成功更新（如果任务不存在或已结束则返回 false）
   */
  public updateTaskStatus(taskId: string, status: 'SUCCESS' | 'FAILURE', message?: string): boolean {
    const task = this.tasks[taskId];
    if (!task) return false;

    if (task.status === 'EXECUTING') {
      task.status = status;
      task.message = message || 'Completed via callback';
      console.log(`[HTTP] Task ${taskId} updated to ${status}. Msg: ${task.message}`);

      // 发布 MQTT 状态更新，通知移动端清理临时文件和定时器，并向前端推送完整结果
      MqttService.getInstance().publish('autojs6/status', { taskId, status, message: task.message });
      return true;
    }
    return false;
  }

  /**
   * 启动任务超时轮询检查器，用于检测并强退失去响应的超时任务。
   */
  private startTimeoutChecker() {
    setInterval(() => {
      const now = Date.now();
      Object.values(this.tasks).forEach((task) => {
        if (task.status === 'EXECUTING') {
          const expirationTime = task.createdAt + (task.timeout + 10) * 1000;
          if (now > expirationTime) {
            task.status = 'FAILURE';
            task.message = `Timeout Failure: No response received after timeout (${task.timeout}s) + 10s grace period.`;
            console.warn(`[TIMEOUT RUNNER] Task ${task.taskId} judged as FAILURE due to timeout.`);
            
            // 虽然判定失败，但依然尝试给移动端发送清理消息以防移动端之后又连接上来
            MqttService.getInstance().publish('autojs6/status', { taskId: task.taskId, status: 'FAILURE', message: task.message });
          }
        }
      });
    }, 2000);
  }
}
