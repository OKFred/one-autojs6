import { Context } from 'hono';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TaskService } from '../service/task.service.js';
import { AutojsService } from '../service/autojs.service.js';
import { ShellService } from '../service/shell.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const taskService = TaskService.getInstance();
const autojsService = AutojsService.getInstance();
const shellService = ShellService.getInstance();

export class TaskController {
  // 下发通用任务 (POST /api/tasks)
  public static async createTask(c: Context) {
    try {
      const body = await c.req.json<{
        cat?: 'autojs6' | 'shell';
        script?: string;
        timeout?: number | string;
        useRoot?: boolean;
      }>();
      const { cat = 'autojs6', script, timeout, useRoot = false } = body;

      if (!script) {
        return c.json({ success: false, error: 'script is required' }, 400);
      }

      const taskTimeout = parseInt(String(timeout || '30'), 10);
      const PORT = parseInt(process.env.PORT || '3000', 10);
      const PC_IP = process.env.PC_IP || '';

      let task;
      if (cat === 'shell') {
        task = await shellService.dispatchTask(script, taskTimeout, PC_IP, PORT, useRoot);
      } else {
        task = await autojsService.dispatchTask(script, taskTimeout, PC_IP, PORT);
      }

      return c.json({
        success: true,
        taskId: task.taskId,
        status: task.status
      });
    } catch (err: any) {
      console.error('[HTTP] Error creating task:', err);
      return c.json({ success: false, error: err.message }, 500);
    }
  }

  // 接收移动端的回调 (POST /api/callback)
  public static async handleCallback(c: Context) {
    try {
      const body = await c.req.json<{ taskId?: string; status?: 'SUCCESS' | 'FAILURE'; message?: string }>();
      const { taskId, status, message } = body;

      if (!taskId || !status) {
        return c.json({ success: false, error: 'taskId and status are required' }, 400);
      }

      const updated = taskService.updateTaskStatus(taskId, status, message);
      if (!updated) {
        const task = taskService.getTask(taskId);
        if (!task) {
          console.warn(`[HTTP] Received callback for missing or untracked task: ${taskId}`);
          return c.json({ success: false, error: 'Task not found' }, 404);
        } else {
          console.log(`[HTTP] Task ${taskId} already in terminal state: ${task.status}. Callback ignored.`);
        }
      }

      return c.json({ success: true });
    } catch (err: any) {
      console.error('[HTTP] Callback handle error:', err);
      return c.json({ success: false, error: err.message }, 500);
    }
  }

  // 获取所有任务 (GET /api/tasks)
  public static getAllTasks(c: Context) {
    return c.json({
      success: true,
      tasks: taskService.getAllTasks()
    });
  }

  // 获取单个任务状态 (GET /api/tasks/:taskId)
  public static getTaskStatus(c: Context) {
    const taskId = c.req.param('taskId') || '';
    const task = taskService.getTask(taskId);

    if (!task) {
      return c.json({
        success: true,
        taskId,
        status: 'MISSING',
        message: 'Task not found in system'
      });
    }

    return c.json({
      success: true,
      task
    });
  }

  // 获取设备应用列表任务 (POST /api/apps/task)
  // 获取包名，通过 Shell 方式异步获取，执行极快
  public static async createAppsTask(c: Context) {
    try {
      const type = c.req.query('type') || 'all'; // all, third, system
      const timeoutStr = c.req.query('timeout') || '15';
      const timeout = parseInt(timeoutStr, 10);

      let pmCmd = 'pm list packages';
      if (type === 'third') {
        pmCmd = 'pm list packages -3';
      } else if (type === 'system') {
        pmCmd = 'pm list packages -s';
      }

      const PORT = parseInt(process.env.PORT || '3000', 10);
      const PC_IP = process.env.PC_IP || '';

      const task = await shellService.dispatchTask(pmCmd, timeout, PC_IP, PORT, false);

      return c.json({
        success: true,
        taskId: task.taskId,
        status: task.status,
        message: 'Apps package task dispatched'
      });
    } catch (err: any) {
      console.error('[HTTP] Error creating apps list task:', err);
      return c.json({ success: false, error: err.message }, 500);
    }
  }

  // 获取应用详细信息列表任务 (POST /api/apps/details-task)
  // 获取包名、中文名称、版本、是否系统应用等详细信息。底层通过 AutoJS6 任务反射获取
  public static async createAppsDetailsTask(c: Context) {
    try {
      const timeoutStr = c.req.query('timeout') || '30';
      const timeout = parseInt(timeoutStr, 10);

      const scriptPath = path.join(__dirname, '../scripts/get_apps_details.js');
      const script = fs.readFileSync(scriptPath, 'utf8');

      const PORT = parseInt(process.env.PORT || '3000', 10);
      const PC_IP = process.env.PC_IP || '';

      const task = await autojsService.dispatchTask(script, timeout, PC_IP, PORT);

      return c.json({
        success: true,
        taskId: task.taskId,
        status: task.status,
        message: 'Apps details task dispatched'
      });
    } catch (err: any) {
      console.error('[HTTP] Error creating apps details task:', err);
      return c.json({ success: false, error: err.message }, 500);
    }
  }
}
