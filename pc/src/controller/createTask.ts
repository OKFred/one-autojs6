import { Context } from 'hono';
import { AutojsService } from '../service/autojs.service.js';
import { ShellService } from '../service/shell.service.js';

const autojsService = AutojsService.getInstance();
const shellService = ShellService.getInstance();

/**
 * 下发通用任务 (支持 AutoJS6 脚本与本地 Shell 命令)。
 */
export async function createTask(c: Context) {
  try {
    const body = await c.req.json<{
      cat?: 'autojs6' | 'shell' | 'kill' | 'config';
      script?: string;
      timeout?: number | string;
      useRoot?: boolean;
      observe?: string[];
    }>();
    const { cat = 'autojs6', script, timeout, useRoot = false, observe = [] } = body;

    if (cat === 'config') {
      const taskId = crypto.randomUUID();
      const { MqttService } = await import('../service/mqtt.service.js');
      MqttService.getInstance().publish('autojs6/tasks', { taskId, cat: 'config', observe });
      return c.json({ ok: true, message: 'Configuration dispatched successfully', data: { taskId, status: 'EXECUTING' } });
    }

    if (cat === 'kill') {
      const taskId = crypto.randomUUID();
      const { MqttService } = await import('../service/mqtt.service.js');
      MqttService.getInstance().publish('autojs6/tasks', { taskId, cat: 'kill', script: '', timeout: 5 });
      return c.json({ ok: true, message: 'Task dispatched successfully', data: { taskId, status: 'EXECUTING' } });
    }

    if (!script) {
      return c.json({ ok: false, message: 'script is required', data: {} }, 400);
    }

    const taskTimeout = parseInt(String(timeout || '30'), 10);

    let task;
    if (cat === 'shell') {
      task = await shellService.dispatchTask(script, taskTimeout, useRoot);
    } else {
      task = await autojsService.dispatchTask(script, taskTimeout);
    }

    return c.json({
      ok: true,
      message: 'Task dispatched successfully',
      data: {
        taskId: task.taskId,
        status: task.status
      }
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating task:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
