auto.waitFor();

var title = "{{title}}";
var details = "{{details}}";
var imagePath = "{{imagePath}}";
var packageName = "com.zhiliaoapp.musically";

// 辅助方法：向 PC 发送实时进度
function reportProgress(msg) {
    console.log(msg);
    if (typeof callbackUrl !== 'undefined') {
        try {
            http.postJson(callbackUrl, {
                taskId: typeof taskId !== 'undefined' ? taskId : 'unknown',
                status: 'PROGRESS',
                message: msg
            });
        } catch (e) {}
    }
}

reportProgress("Starting TikTok auto-post process...");

// 智能点击函数
function performClick(uiObject) {
    if (!uiObject) return false;
    var p = uiObject;
    while (p && !p.isClickable()) {
        p = p.parent();
    }
    if (p && p.click()) return true;
    var bounds = uiObject.bounds();
    if (bounds && bounds.centerX() > 0 && bounds.centerY() > 0) {
        return click(bounds.centerX(), bounds.centerY());
    }
    return false;
}

// 找任意关键字
function findAndClick(keywords, timeout) {
    var start = Date.now();
    while (Date.now() - start < timeout) {
        for (var i = 0; i < keywords.length; i++) {
            var btn = textMatches("(?i).*" + keywords[i] + ".*").findOne(50) || 
                      descMatches("(?i).*" + keywords[i] + ".*").findOne(50);
            if (btn) {
                if (performClick(btn)) {
                    reportProgress("Clicked: " + keywords[i]);
                    return true;
                }
            }
        }
        sleep(500);
    }
    return false;
}

function physicalClick(x, y) {
    click(x, y);
    sleep(1000);
}

// 0. 发送图片直接直达 TikTok 发布/编辑页
if (imagePath) {
    reportProgress("Sending image directly to TikTok via Intent...");
    // 突破 Android 7.0+ 的 FileUriExposedException 限制
    var builder = new android.os.StrictMode.VmPolicy.Builder();
    android.os.StrictMode.setVmPolicy(builder.build());
    
    var intent = new android.content.Intent(android.content.Intent.ACTION_SEND);
    intent.setType("image/*");
    var file = new java.io.File(imagePath);
    var uri = android.net.Uri.fromFile(file);
    intent.putExtra(android.content.Intent.EXTRA_STREAM, uri);
    intent.setPackage(packageName);
    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
    app.startActivity(intent);
    sleep(8000); // 等待 TikTok 编辑器加载完成
} else {
    // 1. 启动应用
    reportProgress("Launching TikTok (No image provided)...");
    app.launch(packageName);
    sleep(5000);

    // 2. 点击底部中间的“+”号 (如果没有找到，就点击屏幕下边缘中央)
    reportProgress("Clicking '+' button...");
    var addBtn = descContains("拍摄").findOne(1000) || descContains("Create").findOne(1000) || textContains("Create").findOne(1000);
    if (addBtn) {
        performClick(addBtn);
    } else {
        // 盲点底部中央
        physicalClick(device.width / 2, device.height - 100);
    }
    sleep(3000);

    // 3. 点击“相册” / "Upload"
    reportProgress("Clicking 'Album/Upload'...");
    if (!findAndClick(["相册", "Upload", "上传"], 5000)) {
        // 盲点右下角相册位置
        physicalClick(device.width * 0.75, device.height - 300);
    }
    sleep(3000);

    // 4. 选择第一张图片 (强制盲点网格第一个元素，兼容性最高)
    reportProgress("Selecting first image from album...");
    // 第一行第二列或第一列（避免点到相机图标，根据手机分辨率不同，通常 x=device.width*0.25, y=300~500）
    physicalClick(device.width * 0.3, 400); 
    sleep(1500);
}

// 5. 点击下一步 (可能会有多次)
reportProgress("Clicking 'Next'...");
findAndClick(["下一步", "Next"], 5000);
sleep(2000);
// 视频编辑页可能还有一次下一步
if (textContains("下一步").exists() || textContains("Next").exists() || descContains("Next").exists() || descContains("下一步").exists()) {
    findAndClick(["下一步", "Next"], 3000);
}
sleep(3000);

// 6. 输入文本
reportProgress("Entering title and details...");
var inputNodes = className("android.widget.EditText").find();
if (inputNodes && inputNodes.length > 0) {
    if (inputNodes.length >= 2) {
        // 如果有两个或以上的输入框，通常第一个是标题，第二个是正文详情
        inputNodes[0].setText(title);
        sleep(500);
        inputNodes[1].setText(details);
    } else {
        // 如果只有一个输入框（旧版或特殊界面），则拼在一起
        inputNodes[0].setText(title + " " + details);
    }
    sleep(1000);
    physicalClick(device.width / 2, 200); // 点一下空白处收起键盘
} else {
    reportProgress("Warning: Cannot find any EditText for caption.");
}

// 7. 发布
reportProgress("Clicking 'Post'...");
if (!findAndClick(["发布", "Post"], 5000)) {
    // 盲点右下角发布按钮
    physicalClick(device.width * 0.8, device.height - 100);
}

// 8. 等待上传完成
reportProgress("Waiting for upload to complete (40s)...");
sleep(15000); // 至少等 15 秒
// 不断检测回到主页或个人主页
for (var i = 0; i < 25; i++) {
    if (textContains("我").exists() || textContains("Profile").exists() || descContains("Profile").exists() || descContains("我").exists()) {
        break;
    }
    sleep(1000);
}
// 额外给后台上传留一点时间
sleep(10000);

// 9. 获取链接
reportProgress("Navigating to Profile to get link...");
// 点击底部“我”
if (!findAndClick(["我", "Profile"], 5000)) {
    physicalClick(device.width - 100, device.height - 100);
}
sleep(4000);

// 下拉刷新个人主页以确保新视频刷出
reportProgress("Refreshing profile...");
swipe(device.width / 2, device.height * 0.3, device.width / 2, device.height * 0.8, 600);
sleep(5000);

// 清空剪贴板，防止读到旧的
setClip("");

// 点击第一个视频 (主页左上角第一个宫格)
reportProgress("Opening latest video...");
// 为了兼容更长的个人简介，稍微往下点一点或者多尝试几个位置
physicalClick(device.width * 0.16, device.height * 0.65);
sleep(3000);

// 点击分享
reportProgress("Clicking Share...");
if (!findAndClick(["分享", "Share"], 5000)) {
    physicalClick(device.width - 100, device.height - 300); // 盲点右下角分享图标
}
sleep(2000);

// 点击复制链接
reportProgress("Clicking Copy Link...");
if (findAndClick(["复制链接", "Copy link"], 5000)) {
    sleep(2000);
    var link = getClip();
    reportProgress("Success! Link copied: " + link);
    taskResult = "TikTok 发帖成功，作品链接: " + link;
} else {
    taskResult = "发帖大概率成功，但未能找到复制链接按钮。";
}
