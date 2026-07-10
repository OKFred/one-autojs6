/**
 * 读取所有短信的测试脚本 (返回结构化 JSON 数组)
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
    // 方式一：使用 ContentResolver 进行原生数据库查询 (获取收发信箱的全部短信)
    var Uri = android.net.Uri;
    var cursor = context.getContentResolver().query(
        Uri.parse("content://sms/"),
        ["address", "body", "date", "type"],
        null,
        null,
        "date desc"
    );
    
    var smsList = [];
    if (cursor != null) {
        while (cursor.moveToNext()) {
            var address = cursor.getString(0);
            var body = cursor.getString(1);
            var date = cursor.getLong(2);
            var type = cursor.getInt(3);
            
            var dateObj = new java.util.Date(date);
            var sdf = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
            var formattedDate = sdf.format(dateObj);
            
            smsList.push({
                time: String(formattedDate),
                from: type === 1 ? String(address) : "Me",
                to: type === 2 ? String(address) : "Me",
                content: String(body)
            });
        }
        cursor.close();
        taskResult = JSON.stringify(smsList);
    } else {
        throw new Error("Cursor is null");
    }
} catch (e) {
    console.log("Normal SMS ContentResolver read failed: " + e + ". Trying root command...");
    
    // 方式二：通过 Root 执行 content query 命令行（免授权），查询所有短信
    var res = shell("content query --uri content://sms/ --projection address:body:date:type --sort 'date desc'", true);
    if (res && res.code == 0 && res.result) {
        var lines = res.result.split("\\n");
        var smsList = [];
        lines.forEach(function(line) {
            if (!line || line.indexOf("Row:") < 0) return;
            
            var addressMatch = line.match(/address=(.*?)(?:, body=)/);
            var bodyMatch = line.match(/body=(.*?)(?:, date=)/);
            var dateMatch = line.match(/date=(.*?)(?:, type=)/);
            var typeMatch = line.match(/type=(\d+)/);
            
            if (addressMatch && bodyMatch && dateMatch && typeMatch) {
                var address = addressMatch[1];
                var body = bodyMatch[1];
                var dateVal = parseInt(dateMatch[1]);
                var typeVal = parseInt(typeMatch[1]);
                
                var formattedDate = "";
                try {
                    var dateObj = new java.util.Date(dateVal);
                    var sdf = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
                    formattedDate = sdf.format(dateObj);
                } catch(err) {
                    formattedDate = String(dateVal);
                }
                
                smsList.push({
                    time: formattedDate,
                    from: typeVal === 1 ? address : "Me",
                    to: typeVal === 2 ? address : "Me",
                    content: body
                });
            }
        });
        taskResult = JSON.stringify(smsList);
    } else {
        taskResult = "Error reading SMS: " + e.toString() + " | Root error: " + (res ? res.error : "unknown");
    }
}
  `.trim()
};

async function run() {
  const url = `http://${PC_IP}:${PORT}/api/tasks`;
  console.log(`[SMS LIST TEST] Dispatching task to query all SMS to ${url}...`);

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
    console.log('[SMS LIST TEST] Task created. Response:', result);
    
    if (result.success && result.taskId) {
      const taskId = result.taskId;
      console.log(`[SMS LIST TEST] Polling status for task: ${taskId}`);
      
      const interval = setInterval(async () => {
        try {
          const statusRes = await fetch(`http://${PC_IP}:${PORT}/api/tasks/${taskId}`);
          if (!statusRes.ok) return;

          const statusData = await statusRes.json();
          if (statusData.success && statusData.task) {
            const status = statusData.task.status;
            
            if (status !== 'EXECUTING') {
              console.log(`\n========================================`);
              console.log(`[SMS LIST TEST] Task completed with status: ${status}`);
              console.log(`[SMS LIST TEST] Returned SMS List:\n`);
              
              const rawMessage = statusData.task.message;
              try {
                // 尝试解析 JSON 数组并进行表格美化输出
                const smsArray = JSON.parse(rawMessage);
                if (Array.isArray(smsArray)) {
                  console.table(smsArray);
                  console.log(`[SMS LIST TEST] Total retrieved: ${smsArray.length} messages.`);
                } else {
                  console.log(rawMessage);
                }
              } catch(e) {
                // 如果解析失败（例如返回了错误提示），直接输出纯文本
                console.log(rawMessage);
              }
              console.log(`========================================\n`);
              clearInterval(interval);
            } else {
              process.stdout.write('.');
            }
          }
        } catch (err) {
          console.error('[SMS LIST TEST] Polling error:', err.message);
        }
      }, 1500);
    }

  } catch (error) {
    console.error('[SMS LIST TEST] Failed:', error.message);
  }
}

run();
