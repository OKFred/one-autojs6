var downloadUrl = "{{downloadUrl}}";
var zipPath = "/sdcard/Download/update_temp.zip";
var destDir = "/sdcard/Download/update_temp_unzip/";

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

reportProgress("开始下载 ZIP: " + downloadUrl);
var urlObj = new java.net.URL(downloadUrl);
var conn = urlObj.openConnection();
conn.connect();
var totalBytes = conn.getContentLength();
var input = conn.getInputStream();
var output = new java.io.FileOutputStream(zipPath);
var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 4096);
var len;
var downloadedBytes = 0;
var lastReported = 0;
var lastReportTime = Date.now();

while ((len = input.read(buffer)) !== -1) {
    output.write(buffer, 0, len);
    downloadedBytes += len;
    
    var now = Date.now();
    if (totalBytes > 0 && downloadedBytes - lastReported >= totalBytes * 0.05 && (now - lastReportTime > 2000)) {
        lastReported = downloadedBytes;
        lastReportTime = now;
        var percent = Math.floor((downloadedBytes / totalBytes) * 100);
        reportProgress("下载进度: " + percent + "% (" + (downloadedBytes/1024/1024).toFixed(1) + "MB / " + (totalBytes/1024/1024).toFixed(1) + "MB)");
    }
}
output.flush();
output.close();
input.close();
reportProgress("ZIP 下载完成. 保存路径: " + zipPath);

files.removeDir(destDir);
files.createWithDirs(destDir);

reportProgress("开始解压ZIP文件...");
var unzipSuccess = false;
try {
    var res = shell("unzip -o '" + zipPath + "' -d '" + destDir + "'", false);
    if (res.code === 0) {
        console.log("Shell unzip executed successfully.");
        unzipSuccess = true;
    } else {
        console.log("Shell unzip failed with code " + res.code + ". Falling back to Java ZipInputStream.");
    }
} catch(e) {
    console.log("Shell unzip exception. Falling back to Java ZipInputStream.");
}

if (!unzipSuccess) {
    var zipFile = new java.util.zip.ZipFile(zipPath);
    var entries = zipFile.entries();
    while (entries.hasMoreElements()) {
        var entry = entries.nextElement();
        if (!entry.isDirectory()) {
            var is = zipFile.getInputStream(entry);
            var outFile = new java.io.File(destDir, entry.getName());
            files.createWithDirs(outFile.getPath());
            var os = new java.io.FileOutputStream(outFile);
            var buf = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 4096);
            var readLen;
            while ((readLen = is.read(buf)) !== -1) {
                os.write(buf, 0, readLen);
            }
            os.close();
            is.close();
        }
    }
    zipFile.close();
    console.log("Java extraction complete.");
}

var apkFiles = files.listDir(destDir, function(name) {
    return name.endsWith(".apk");
});
if (apkFiles.length === 0) {
    throw new Error("No APK found in the downloaded ZIP.");
}
var apkPath = files.join(destDir, apkFiles[0]);
reportProgress("解压完成，找到 APK: " + apkPath);

// 尝试静默安装 (Root)
reportProgress("正在静默安装 APK (绕过 SELinux 限制)...");
var tmpPath = "/data/local/tmp/update_temp.apk";
shell("cp '" + apkPath + "' '" + tmpPath + "' && chmod 777 '" + tmpPath + "'", true);
var result = shell("pm install -r '" + tmpPath + "'", true);
shell("rm -f '" + tmpPath + "'", true);

if (result.code === 0) {
    taskResult = "更新成功！静默安装完成。";
} else {
    reportProgress("静默安装失败 (" + result.error + ")，转为手动安装模式...");
    app.viewFile(apkPath);
    taskResult = "已唤起安装界面，请手动完成安装。";
}
