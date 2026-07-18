var downloadUrl = "{{downloadUrl}}";
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
