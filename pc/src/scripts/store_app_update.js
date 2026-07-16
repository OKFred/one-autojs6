auto.waitFor();

var packageName = "{{packageName}}";
var storePackage = "{{storePackage}}";

console.log("Launching app store for: " + packageName);
var intent = new Intent(Intent.ACTION_VIEW);
intent.setData(android.net.Uri.parse("market://details?id=" + packageName));
if (storePackage) {
    intent.setPackage(storePackage);
}
app.startActivity(intent);

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

// 循环探测并点击更新按钮
var clicked = false;
var keywords = ["更新", "升级", "Update", "Upgrade"];
for (var i = 0; i < 15; i++) {
    for (var j = 0; j < keywords.length; j++) {
        var btn = text(keywords[j]).findOne(500) || desc(keywords[j]).findOne(500);
        if (btn && performClick(btn)) {
            clicked = true;
            break;
        }
        var btnContains = textContains(keywords[j]).findOne(500) || descContains(keywords[j]).findOne(500);
        if (btnContains && performClick(btnContains)) {
            clicked = true;
            break;
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
