import crypto from 'crypto';
import { MqttService } from './mqtt.service.js';

export interface Task {
  taskId: string;
  cat: 'autojs6' | 'shell';
  script: string;
  status: 'EXECUTING' | 'SUCCESS' | 'FAILURE' | 'MISSING';
  timeout: number;
  createdAt: number;
  message: string;
}

export class TaskService {
  private static instance: TaskService;
  private tasks: Record<string, Task> = {};

  private constructor() {
    this.startTimeoutChecker();
  }

  public static getInstance(): TaskService {
    if (!TaskService.instance) {
      TaskService.instance = new TaskService();
    }
    return TaskService.instance;
  }

  public createTask(cat: 'autojs6' | 'shell', script: string, timeout: number): Task {
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

  public getTask(taskId: string): Task | undefined {
    return this.tasks[taskId];
  }

  public getAllTasks(): Task[] {
    return Object.values(this.tasks);
  }

  public updateTaskStatus(taskId: string, status: 'SUCCESS' | 'FAILURE', message?: string): boolean {
    const task = this.tasks[taskId];
    if (!task) return false;

    if (task.status === 'EXECUTING') {
      task.status = status;
      task.message = message || 'Completed via callback';
      console.log(`[HTTP] Task ${taskId} updated to ${status}. Msg: ${task.message}`);

      // 发布 MQTT 状态更新，通知移动端清理临时文件和定时器
      MqttService.getInstance().publish('autojs6/status', { taskId, status });
      return true;
    }
    return false;
  }

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
            MqttService.getInstance().publish('autojs6/status', { taskId: task.taskId, status: 'FAILURE' });
          }
        }
      });
    }, 2000);
  }
}
