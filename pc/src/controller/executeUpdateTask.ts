import { Context } from 'hono';
import { AutojsService } from '../service/autojs.service.js';

const autojsService = AutojsService.getInstance();

/**
 * 异步下发“执行宿主应用远程更新”任务。
 * 
 * @swagger
 * /api/apps/execute-update-task:
 *   post:
 *     summary: 异步下发执行应用更新任务
 *     description: 异步下发执行 App 更新的 Auto.js 自动化脚本。支持 mode=download（直接下载 APK 并唤起安装）以及 mode=store（拉起应用商店通过无障碍自动寻找并点击更新按钮）。返回 taskId 供轮询。
 *     parameters:
 *       - in: query
 *         name: packageName
 *         schema:
 *           type: string
 *           default: org.autojs.autojs6
 *         description: 要更新的应用包名
 *       - in: query
 *         name: mode
 *         required: true
 *         schema:
 *           type: string
 *           enum: [download, store]
 *         description: 更新模式：download(直接下载APK包安装)、store(跳转应用商店无障碍点击更新)
 *       - in: query
 *         name: downloadUrl
 *         schema:
 *           type: string
 *         description: APK 下载链接 (当 mode=download 时必填)
 *       - in: query
 *         name: storePackage
 *         schema:
 *           type: string
 *         description: 目标应用商店的包名 (当 mode=store 时可选，如 Google Play "com.android.vending")
 *       - in: query
 *         name: timeout
 *         schema:
 *           type: integer
 *           default: 120
 *         description: 任务超时时间(秒，下载大文件或在商店等待时建议长超时)
 *     responses:
 *       200:
 *         description: 任务下发成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     taskId:
 *                       type: string
 *                     status:
 *                       type: string
 *       400:
 *         description: 参数请求错误
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *       500:
 *         description: 任务下发失败
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 * 
 * @param c - Hono 路由上下文对象
 * @returns Hono JSON 响应
 */
export async function executeUpdateTask(c: Context) {
  try {
    const packageName = c.req.query('packageName') || 'org.autojs.autojs6';
    const mode = c.req.query('mode') || '';
    const downloadUrl = c.req.query('downloadUrl') || '';
    const storePackage = c.req.query('storePackage') || '';
    const timeoutStr = c.req.query('timeout') || '120';
    const timeout = parseInt(timeoutStr, 10);

    if (mode !== 'download' && mode !== 'store') {
      return c.json({ ok: false, message: 'mode must be "download" or "store"', data: {} }, 400);
    }

    if (mode === 'download' && !downloadUrl) {
      return c.json({ ok: false, message: 'downloadUrl is required when mode is "download"', data: {} }, 400);
    }


    const PORT = parseInt(process.env.PORT || '3000', 10);
    const PC_IP = process.env.PC_IP || '';

    let script = '';

    if (mode === 'download') {
      // 下载安装包并拉起系统安装界面
      script = `
var downloadUrl = "${downloadUrl}";
var targetPath = "/sdcard/Download/update_temp.apk";

console.log("Start downloading APK from: " + downloadUrl);
var urlObj = new java.net.URL(downloadUrl);
var conn = urlObj.openConnection();
conn.connect();
var input = conn.getInputStream();
var output = new java.io.FileOutputStream(targetPath);
var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 4096);
var len;
while ((len = input.read(buffer)) !== -1) {
    output.write(buffer, 0, len);
}
output.flush();
output.close();
input.close();
console.log("APK download complete. Saved to: " + targetPath);

// 发起覆盖安装意图
app.installApp(new java.io.File(targetPath));
taskResult = "APK downloaded successfully and installation dialog is launched.";
`;
    } else {
      // 应用商店跳转并无障碍点击更新
      // 增强兼容性：同时通过 text 和 desc (content-description) 进行查找
      script = `
auto.waitFor();

var packageName = "${packageName}";
var storePackage = "${storePackage}";

console.log("Launching app store for: " + packageName);
var intent = new Intent(Intent.ACTION_VIEW);
intent.setData(android.net.Uri.parse("market://details?id=" + packageName));
if (storePackage) {
    intent.setPackage(storePackage);
}
app.startActivity(intent);

// 循环探测并点击更新按钮
var clicked = false;
var keywords = ["更新", "升级", "Update", "Upgrade"];
for (var i = 0; i < 15; i++) {
    for (var j = 0; j < keywords.length; j++) {
        // 兼容一般控件 text 属性与特殊无障碍 desc (content-description) 属性
        var btn = text(keywords[j]).findOne(1000) || desc(keywords[j]).findOne(1000);
        if (btn) {
            btn.click();
            clicked = true;
            break;
        }
        var btnContains = textContains(keywords[j]).findOne(500) || descContains(keywords[j]).findOne(500);
        if (btnContains) {
            var p = btnContains;
            while (p && !p.isClickable()) {
                p = p.parent();
            }
            if (p) {
                p.click();
                clicked = true;
                break;
            }
        }
    }
    if (clicked) break;
    sleep(1000);
}

if (clicked) {
    taskResult = "Successfully launched app store page and clicked the update button.";
} else {
    throw new Error("Update button not found in app store page within 15 seconds.");
}
`;
    }

    const task = await autojsService.dispatchTask(script, timeout, PC_IP, PORT);

    return c.json({
      ok: true,
      message: 'App execute update task dispatched successfully',
      data: {
        taskId: task.taskId,
        status: task.status
      }
    });
  } catch (err: any) {
    console.error('[HTTP] Error creating execute update task:', err);
    return c.json({ ok: false, message: err.message, data: {} }, 500);
  }
}
