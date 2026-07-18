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

// 循环探测并点击更新按钮
var clicked = false;
var keywords = ["更新", "升级", "Update", "Upgrade"];
for (var i = 0; i < 15; i++) {
    for (var j = 0; j < keywords.length; j++) {
        // 采用模糊包含方式查找，并同时比对 text 与 desc 属性
        var btn = textContains(keywords[j]).findOne(500) || descContains(keywords[j]).findOne(500);
        if (btn) {
            console.log("Found target update widget by keyword: " + keywords[j]);
            
            // 优先采用物理屏幕坐标点击（最稳定，能突破任何自定义及嵌套布局限制）
            var bounds = btn.bounds();
            if (bounds && bounds.centerX() > 0 && bounds.centerY() > 0) {
                console.log("Triggering physical coordinate click at: (" + bounds.centerX() + ", " + bounds.centerY() + ")");
                click(bounds.centerX(), bounds.centerY());
                clicked = true;
            } else {
                // 若无法获取坐标，则回退为无障碍节点向上溯源点击
                var p = btn;
                while (p && !p.isClickable()) {
                    p = p.parent();
                }
                if (p) {
                    console.log("Triggering accessibility click on widget node");
                    p.click();
                    clicked = true;
                }
            }
            if (clicked) break;
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
