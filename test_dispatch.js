/**
 * 测试任务下发与状态监控脚本
 * 
 * 运行方式:
 *   1. 直接运行 (使用默认配置):
 *      node test_dispatch.js
 * 
 *   2. 加载配置文件运行 (Node.js 20.6+ 支持):
 *      node --env-file=pc/.env test_dispatch.js
 */

const PC_IP = process.env.PC_IP || '192.168.12.240';
const PORT = process.env.PORT || '3000';

// 待下发的测试任务载荷 (Cat 默认为 autojs6)
const payload = {
  timeout: 60, // 超时时间（秒）
  script: `
app.openUrl("https://www.baidu.com");
console.log("Launched browser, navigating to baidu.com...");
sleep(5000);
  `.trim()
};

async function run() {
  const url = `http://${PC_IP}:${PORT}/api/tasks`;
  console.log(`[TEST] Dispatching task to ${url}...`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log('[TEST] Task created successfully. Response:', result);
    
    if (result.success && result.taskId) {
      const taskId = result.taskId;
      console.log(`[TEST] Starting to poll status for task: ${taskId}`);
      
      // 每 2 秒查询一次任务结果
      const interval = setInterval(async () => {
        try {
          const statusRes = await fetch(`http://${PC_IP}:${PORT}/api/tasks/${taskId}`);
          if (!statusRes.ok) {
            console.error(`[TEST] Failed to query task status, HTTP Code: ${statusRes.status}`);
            return;
          }

          const statusData = await statusRes.json();
          if (statusData.success && statusData.task) {
            const status = statusData.task.status;
            console.log(`[TEST] Current Status: ${status} | Detail: ${statusData.task.message}`);
            
            // 只要不是 EXECUTING，就说明任务已经结束（SUCCESS, FAILURE, 或被轮询强杀）
            if (status !== 'EXECUTING') {
              console.log(`[TEST] Poll ended. Terminal state reached: ${status}`);
              clearInterval(interval);
            }
          } else if (statusData.success && statusData.status === 'MISSING') {
            console.log(`[TEST] Poll ended. Task status is: MISSING`);
            clearInterval(interval);
          }
        } catch (err) {
          console.error('[TEST] Error during status polling:', err.message);
        }
      }, 2000);
    }

  } catch (error) {
    console.error('[TEST] Failed to dispatch task:', error.message);
  }
}

run();
