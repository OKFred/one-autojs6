auto.waitFor();

var packageName = "{{packageName}}";
var storePackage = "{{storePackage}}";

console.log("Launching app store for: " + packageName);
var options = {
    action: "android.intent.action.VIEW",
    data: "market://details?id=" + packageName
};
if (storePackage) {
    options.packageName = storePackage;
}
app.startActivity(options);

// 智能物理坐标与控件树兼容点击函数
function performClick(uiObject) {
    if (!uiObject) return false;
    
    // 1. 尝试向上寻找可点击的父节点
    var p = uiObject;
    while (p && !p.isClickable()) {
        p = p.parent();
    }
    if (p && p.click()) {
        console.log("Clicked clickable element successfully.");
        return true;
    }
    
    // 2. 备用手段：暴力物理坐标中点点击
    var bounds = uiObject.bounds();
    if (bounds) {
        var x = bounds.centerX();
        var y = bounds.centerY();
        if (x > 0 && y > 0) {
            console.log("Fallback to coordinate click: (" + x + ", " + y + ")");
            return click(x, y);
        }
    }
    return false;
}

// 循环探测按钮
var clickedBtn = null;
var foundState = ""; // 'update', 'open', 'install'

var updateKeywords = ["更新", "升级", "Update", "UPDATE", "update", "Upgrade", "UPGRADE"];
var openKeywords = ["打开", "Open", "OPEN", "open"];
var installKeywords = ["安装", "下载", "Install", "INSTALL", "install", "Download", "DOWNLOAD", "获取", "Get", "GET"];

for (var i = 0; i < 20; i++) {
    for (var j = 0; j < updateKeywords.length; j++) {
        var btn = textContains(updateKeywords[j]).findOne(50) || descContains(updateKeywords[j]).findOne(50);
        if (btn) { clickedBtn = btn; foundState = "update"; break; }
    }
    if (clickedBtn) break;
    
    for (var j = 0; j < openKeywords.length; j++) {
        var btn = textContains(openKeywords[j]).findOne(50) || descContains(openKeywords[j]).findOne(50);
        if (btn) { clickedBtn = btn; foundState = "open"; break; }
    }
    if (clickedBtn) break;
    
    for (var j = 0; j < installKeywords.length; j++) {
        var btn = textContains(installKeywords[j]).findOne(50) || descContains(installKeywords[j]).findOne(50);
        if (btn) { clickedBtn = btn; foundState = "install"; break; }
    }
    if (clickedBtn) break;
    
    sleep(1000);
}

if (clickedBtn) {
    console.log("Found widget for state: " + foundState);
    if (foundState === "open") {
        taskResult = "无需更新，已经是最新版本 (已检测到“打开”按钮)。";
    } else {
        if (!performClick(clickedBtn)) {
            // fallback if performClick fails
            var bounds = clickedBtn.bounds();
            if (bounds && bounds.centerX() > 0 && bounds.centerY() > 0) {
                click(bounds.centerX(), bounds.centerY());
            } else {
                var p = clickedBtn;
                while (p && !p.isClickable()) p = p.parent();
                if (p) p.click();
            }
        }
        taskResult = foundState === "update" ? "成功唤起应用商店并点击了更新。" : "成功唤起应用商店并点击了安装。";
    }
} else {
    throw new Error("Timeout (20s): 无法在应用商店页面中找到相关的[更新/打开/安装]按钮。如果是特殊应用商店，请考虑使用静默下载安装(mode=download)。");
}
