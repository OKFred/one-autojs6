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

app.openUrl("https://www.baidu.com");
console.log("Launched Chrome, waiting for loading...");
sleep(5000);

// 2. 查找百度搜索输入框，先点击聚焦
var searchInput = className("android.widget.EditText").findOne(10000);
if (!searchInput) {
    throw new Error("Timeout waiting for Baidu search input box");
}

// 物理点击输入框中心以激活光标并唤起输入焦点
var inputX = searchInput.bounds().centerX();
var inputY = searchInput.bounds().centerY();
click(inputX, inputY);
console.log("Clicked search input box to focus. Position: " + inputX + ", " + inputY);
sleep(1500);

// 3. 使用 Root 权限的 shell input text 输入 "ip" (能真实触动网页 DOM 的键盘输入与交互监听)
shell("input text 'ip'", true);
console.log("Inputted 'ip' into search box via shell input.");
sleep(1500);

// 4. 发送回车键事件 (KeyCode 66) 触发百度搜索
shell("input keyevent 66", true);
console.log("Sent Enter key event via shell.");
sleep(1000);

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
