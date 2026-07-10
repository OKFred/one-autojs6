/**
 * 读取所有短信的测试脚本 (返回结构化 JSON 数组)
 * 
 * 运行方式:
 *   1. 直接运行 (使用默认配置):
 *      node test/scripts/test_sms.js
 * 
 *   2. 加载配置文件运行:
 *      node --env-file=pc/.env test/scripts/test_sms.js
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

const payload = {
  timeout: 30, // 30秒超时
  script: `
// 直接通过 Root 执行 content query 命令行查询所有短信，免去无障碍应用权限申请的限制
var res = shell("content query --uri content://sms/ --projection address:body:date:type --sort 'date desc'", true);
if (res && res.code == 0 && res.result) {
    var lines = res.result.split("\\n");
    var smsList = [];
    lines.forEach(function(line) {
        if (!line || line.indexOf("Row:") < 0) return;
        
        var addressMatch = line.match(/address=(.*?)(?:, \\w+=|$)/);
        var bodyMatch = line.match(/body=(.*?)(?:, \\w+=|$)/);
        var dateMatch = line.match(/date=(.*?)(?:, \\w+=|$)/);
        var typeMatch = line.match(/type=(.*?)(?:, \\w+=|$)/);
        
        if (addressMatch && bodyMatch) {
            var address = addressMatch[1];
            var body = bodyMatch[1];
            
            var dateVal = Date.now();
            if (dateMatch) {
                var parsedDate = parseInt(dateMatch[1]);
                if (!isNaN(parsedDate)) {
                    dateVal = parsedDate;
                }
            }
            
            var typeVal = 1; // 默认为收件箱
            if (typeMatch) {
                var parsedType = parseInt(typeMatch[1]);
                if (!isNaN(parsedType)) {
                    typeVal = parsedType;
                }
            }
            
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
    taskResult = "Failed to query SMS database via root: " + (res ? res.error : "unknown");
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
