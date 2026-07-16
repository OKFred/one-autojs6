/**
 * 测试宿主应用执行更新接口
 * 
 * 运行方式:
 *   # 测试 APK 下载覆盖安装模式:
 *   node --env-file=pc/.env test/scripts/test_execute_update.js download
 * 
 *   # 测试应用商店自动更新模式:
 *   node --env-file=pc/.env test/scripts/test_execute_update.js store
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

const mode = process.argv[2];
if (mode !== 'download' && mode !== 'store') {
  console.log('Usage: node test_execute_update.js [download|store]');
  process.exit(1);
}

async function run() {
  const packageName = 'org.autojs.autojs6';
  
  let url = `http://${PC_IP}:${PORT}/api/apps/execute-update-task?packageName=${packageName}&mode=${mode}`;
  if (mode === 'download') {
    // 使用一个测试的小 APK 地址或者指定的物理下载地址进行模拟
    const testApkUrl = 'https://github.com/okfred/one-autojs6/releases/download/v1.0.0/test.apk';
    url += `&downloadUrl=${encodeURIComponent(testApkUrl)}`;
  } else {
    // 默认应用商店 package (比如 Google Play "com.android.vending")
    url += `&storePackage=com.android.vending`;
  }

  console.log(`[EXECUTE UPDATE TEST] Dispatching update task (mode=${mode}) to ${url}...`);

  try {
    const response = await fetch(url, {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log('[EXECUTE UPDATE TEST] Task created. Response:', result);
    
    if (result.ok && result.data && result.data.taskId) {
      const taskId = result.data.taskId;
      console.log(`[EXECUTE UPDATE TEST] Polling status for task: ${taskId}`);
      
      const interval = setInterval(async () => {
        try {
          const statusRes = await fetch(`http://${PC_IP}:${PORT}/api/tasks/${taskId}`);
          if (!statusRes.ok) return;

          const statusData = await statusRes.json();
          if (statusData.ok && statusData.data && statusData.data.task) {
            const status = statusData.data.task.status;
            
            if (status !== 'EXECUTING') {
              console.log(`\n========================================`);
              console.log(`[EXECUTE UPDATE TEST] Task completed with status: ${status}`);
              console.log(`[EXECUTE UPDATE TEST] Result Message:\n`);
              console.log(statusData.data.task.message);
              console.log(`========================================\n`);
              clearInterval(interval);
            } else {
              process.stdout.write('.');
            }
          }
        } catch (err) {
          console.error('[EXECUTE UPDATE TEST] Polling error:', err.message);
        }
      }, 2000);
    }

  } catch (error) {
    console.error('[EXECUTE UPDATE TEST] Failed:', error.message);
  }
}

run();
