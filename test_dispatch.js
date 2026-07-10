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
// 1. 启动 Chrome 并打开百度网
app.intent({
    action: "VIEW",
    data: "https://www.baidu.com",
    packageName: "com.android.chrome",
    flags: ["ACTIVITY_NEW_TASK"]
});
console.log("Launched Chrome, waiting for loading...");
sleep(5000);

// 2. 查找百度搜索输入框并输入 "ip"
var searchInput = className("android.widget.EditText").findOne(10000);
if (!searchInput) {
    throw new Error("Timeout waiting for Baidu search input box");
}
searchInput.setText("ip");
console.log("Inputted 'ip' into search box.");
sleep(1000);

// 3. 点击“百度一下”或者直接通过回车搜索
var searchBtn = text("百度一下").findOne(2000) || desc("百度一下").findOne(2000) || text("搜索").findOne(2000);
if (searchBtn) {
    searchBtn.click();
    console.log("Clicked search button.");
} else {
    console.log("Search button not found by text, simulating Enter key...");
    shell("input keyevent 66", true);
}

// 4. 等待百度加载搜索结果
sleep(5000);
console.log("Baidu search result loaded, grabbing page contents...");

// 5. 抓取屏幕上的文本节点信息并筛选 IP 关键字
var results = [];
var nodes = className("android.widget.TextView").find();
if (nodes.empty()) {
    nodes = className("android.view.View").find();
}

nodes.forEach(function(node) {
    var txt = node.text();
    if (txt && txt.trim().length > 0) {
        var cleanTxt = txt.trim();
        results.push(cleanTxt);
    }
});

// 将筛选出来的文字切片提取回传
var allText = results.slice(0, 30).join(" | ");
console.log("Grabbed DOM contents: " + allText);

// 将抓取到的内容赋值给 taskResult，它会被移动端自动捕捉并 POST 回 PC 服务端
taskResult = allText;
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
