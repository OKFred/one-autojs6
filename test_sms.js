/**
 * 读取最近一条短信的测试脚本
 * 
 * 运行方式:
 *   node --env-file=pc/.env test_sms.js
 */

const PC_IP = process.env.PC_IP || '192.168.12.240';
const PORT = process.env.PORT || '3000';

const payload = {
  timeout: 30, // 30秒超时
  script: `
try {
    // 方式一：使用 ContentResolver 尝试直接查询
    var Uri = android.net.Uri;
    var cursor = context.getContentResolver().query(
        Uri.parse("content://sms/inbox"),
        ["address", "body", "date"],
        null,
        null,
        "date desc limit 1"
    );
    
    if (cursor != null && cursor.moveToFirst()) {
        var address = cursor.getString(0);
        var body = cursor.getString(1);
        var date = cursor.getLong(2);
        cursor.close();
        
        var dateObj = new java.util.Date(date);
        var sdf = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
        taskResult = "From: " + address + "\\nTime: " + sdf.format(dateObj) + "\\nContent: " + body;
    } else {
        if (cursor != null) cursor.close();
        // 方式二：通过 Root 执行 content query 命令行（免授权）
        var res = shell("content query --uri content://sms/inbox --projection address:body:date --sort 'date desc' --limit 1", true);
        if (res && res.code == 0 && res.result) {
            taskResult = res.result;
        } else {
            taskResult = "No SMS found or failed to read database";
        }
    }
} catch (e) {
    console.log("Normal SMS read failed: " + e + ". Trying root command...");
    // 方式二：通过 Root 执行 content query 命令行（免授权）
    var res = shell("content query --uri content://sms/inbox --projection address:body:date --sort 'date desc' --limit 1", true);
    if (res && res.code == 0 && res.result) {
        taskResult = res.result;
    } else {
        taskResult = "Error reading SMS: " + e.toString() + " | Root error: " + (res ? res.error : "unknown");
    }
}
  `.trim()
};

async function run() {
  const url = `http://${PC_IP}:${PORT}/api/tasks`;
  console.log(`[SMS TEST] Dispatching SMS task to ${url}...`);

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
    console.log('[SMS TEST] Task created. Response:', result);
    
    if (result.success && result.taskId) {
      const taskId = result.taskId;
      console.log(`[SMS TEST] Polling status for task: ${taskId}`);
      
      const interval = setInterval(async () => {
        try {
          const statusRes = await fetch(`http://${PC_IP}:${PORT}/api/tasks/${taskId}`);
          if (!statusRes.ok) return;

          const statusData = await statusRes.json();
          if (statusData.success && statusData.task) {
            const status = statusData.task.status;
            
            if (status !== 'EXECUTING') {
              console.log(`\n========================================`);
              console.log(`[SMS TEST] Task completed with status: ${status}`);
              console.log(`[SMS TEST] Returned SMS Details:\n`);
              console.log(statusData.task.message);
              console.log(`========================================\n`);
              clearInterval(interval);
            } else {
              process.stdout.write('.');
            }
          }
        } catch (err) {
          console.error('[SMS TEST] Polling error:', err.message);
        }
      }, 1500);
    }

  } catch (error) {
    console.error('[SMS TEST] Failed:', error.message);
  }
}

run();
