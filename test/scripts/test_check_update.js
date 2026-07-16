/**
 * 测试宿主应用版本检查接口
 * 
 * 运行方式:
 *   node --env-file=pc/.env test/scripts/test_check_update.js
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
  const packageName = 'org.autojs.autojs6';
  const latestVersion = '6.4.0';
  const latestVersionCode = '60400';
  
  const url = `http://${PC_IP}:${PORT}/api/apps/check-update-task?packageName=${packageName}&latestVersion=${latestVersion}&latestVersionCode=${latestVersionCode}`;
  console.log(`[CHECK UPDATE TEST] Dispatching task to ${url}...`);

  try {
    const response = await fetch(url, {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log('[CHECK UPDATE TEST] Task created. Response:', result);
    
    if (result.ok && result.data && result.data.taskId) {
      const taskId = result.data.taskId;
      console.log(`[CHECK UPDATE TEST] Polling status for task: ${taskId}`);
      
      const interval = setInterval(async () => {
        try {
          const statusRes = await fetch(`http://${PC_IP}:${PORT}/api/tasks/${taskId}`);
          if (!statusRes.ok) return;

          const statusData = await statusRes.json();
          if (statusData.ok && statusData.data && statusData.data.task) {
            const status = statusData.data.task.status;
            
            if (status !== 'EXECUTING') {
              console.log(`\n========================================`);
              console.log(`[CHECK UPDATE TEST] Task completed with status: ${status}`);
              console.log(`[CHECK UPDATE TEST] Result Message:\n`);
              
              const rawMessage = statusData.data.task.message;
              try {
                const parsed = JSON.parse(rawMessage);
                console.log(JSON.stringify(parsed, null, 2));
              } catch (e) {
                console.log(rawMessage);
              }
              console.log(`========================================\n`);
              clearInterval(interval);
            } else {
              process.stdout.write('.');
            }
          }
        } catch (err) {
          console.error('[CHECK UPDATE TEST] Polling error:', err.message);
        }
      }, 1500);
    }

  } catch (error) {
    console.error('[CHECK UPDATE TEST] Failed:', error.message);
  }
}

run();
