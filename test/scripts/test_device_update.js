/**
 * 异步下发移动端自更新与重启任务的测试脚本
 * 
 * 运行方式:
 *   node --env-file=pc/.env test/scripts/test_device_update.js
 */

const PC_IP = process.env.PC_IP;
if (!PC_IP) {
  console.error('[ERROR] Environment variable PC_IP is required. Run with --env-file=pc/.env or export PC_IP.');
  process.exit(1);
}
const PORT = process.env.PORT;
if (!PORT) {
  console.error('[ERROR] Environment variable PORT is required. Run with --env-file=pc/.env or export PORT.');
  process.exit(1);
}

async function run() {
  const url = `http://${PC_IP}:${PORT}/api/devices/update-task`;
  console.log(`[DEVICE UPDATE TEST] Dispatching update task to ${url}...`);

  try {
    const response = await fetch(url, {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log('[DEVICE UPDATE TEST] Task created. Response:', result);
    
    if (result.ok && result.data && result.data.taskId) {
      const taskId = result.data.taskId;
      console.log(`[DEVICE UPDATE TEST] Polling status for task: ${taskId}`);
      
      const interval = setInterval(async () => {
        try {
          const statusRes = await fetch(`http://${PC_IP}:${PORT}/api/tasks/${taskId}`);
          if (!statusRes.ok) return;

          const statusData = await statusRes.json();
          if (statusData.ok && statusData.data && statusData.data.task) {
            const status = statusData.data.task.status;
            
            if (status !== 'EXECUTING') {
              console.log(`\n========================================`);
              console.log(`[DEVICE UPDATE TEST] Task completed with status: ${status}`);
              console.log(`[DEVICE UPDATE TEST] Git Update Output:\n`);
              
              const rawMessage = statusData.data.task.message;
              console.log(rawMessage);
              console.log(`========================================\n`);
              clearInterval(interval);
            } else {
              process.stdout.write('.');
            }
          }
        } catch (err) {
          console.error('[DEVICE UPDATE TEST] Polling error:', err.message);
        }
      }, 1500);
    }

  } catch (error) {
    console.error('[DEVICE UPDATE TEST] Failed:', error.message);
  }
}

run();
