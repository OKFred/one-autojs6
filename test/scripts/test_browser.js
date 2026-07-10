/**
 * 测试任务下发与状态监控脚本 (浏览器访问与抓取)
 * 
 * 运行方式:
 *   1. 直接运行 (使用默认配置):
 *      node test/scripts/test_browser.js
 * 
 *   2. 加载配置文件运行 (Node.js 20.6+ 支持):
 *      node --env-file=pc/.env test/scripts/test_browser.js
 */

const PC_IP = process.env.PC_IP;
if (!PC_IP) {
  console.error('[ERROR] Environment variable PC_IP is required. Run with --env-file=pc/.env or export PC_IP.');
  process.exit(1);
}
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

// 3. 将 "杭州" 拷贝至系统剪切板，并触发粘贴（或通过 setText 写入）以完美绕过 Android Shell 不支持中文输入的限制
setClip("杭州");
sleep(500);
var pasted = searchInput.paste();
if (!pasted) {
    console.log("Accessibility paste not supported, falling back to setText.");
    searchInput.setText("杭州");
}
console.log("Inputted '杭州' into search box.");
sleep(1500);

// 4. 发送回车键事件 (KeyCode 66) 触发百度搜索
shell("input keyevent 66", true);
console.log("Sent Enter key event via shell.");
sleep(1000);

// 4. 等待百度加载搜索结果
sleep(5000);
console.log("Baidu search result loaded, grabbing page contents...");

// 5. 循环滚动 4 次，抓取整个网页的全部文字内容（解决 Android 只能抓取当前可视区域无障碍节点的限制）
var results = {};
for (var scrollCount = 0; scrollCount < 4; scrollCount++) {
    var nodes = className("android.widget.TextView").find();
    if (nodes.empty()) {
        nodes = className("android.view.View").find();
    }
    
    nodes.forEach(function(node) {
        var txt = node.text();
        if (txt && txt.trim().length > 0) {
            results[txt.trim()] = true; // 去重保存
        }
    });
    
    if (scrollCount < 3) {
        console.log("Scrolling down to load more content... (Step " + (scrollCount + 1) + ")");
        // 向上滑动屏幕以向下滚动网页
        // swipe(startX, startY, endX, endY, duration_ms)
        swipe(500, 1500, 500, 450, 600);
        sleep(1500); // 等待网页数据加载及无障碍树刷新
    }
}

// 汇总全部去重后的文本
var allText = Object.keys(results).join(" | ");
console.log("Grabbed DOM contents (length: " + allText.length + ")");

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
