var downloadUrl = "{{downloadUrl}}";
var targetPath = "{{targetPath}}";

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

reportProgress("开始下载文件: " + downloadUrl);

try {
    var urlObj = new java.net.URL(downloadUrl);
    var conn = urlObj.openConnection();
    conn.connect();
    
    // 如果返回 404/500 等错误
    var responseCode = conn.getResponseCode();
    if (responseCode >= 400) {
        throw new Error("HTTP Error: " + responseCode);
    }

    var totalBytes = conn.getContentLength();
    var input = conn.getInputStream();
    
    // 确保目标目录存在
    var file = new java.io.File(targetPath);
    var parent = file.getParentFile();
    if (!parent.exists()) {
        parent.mkdirs();
    }
    
    var output = new java.io.FileOutputStream(targetPath);
    var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 4096);
    var len;
    var downloadedBytes = 0;
    var lastReported = 0;
    var lastReportTime = Date.now();
    
    while ((len = input.read(buffer)) !== -1) {
        output.write(buffer, 0, len);
        downloadedBytes += len;
        
        var now = Date.now();
        // 防抖：2秒且超过 1% 时才汇报，避免刷屏
        if (totalBytes > 0 && (downloadedBytes - lastReported >= totalBytes * 0.01) && (now - lastReportTime > 2000)) {
            lastReported = downloadedBytes;
            lastReportTime = now;
            var percent = Math.floor((downloadedBytes / totalBytes) * 100);
            reportProgress("下载进度: " + percent + "% (" + (downloadedBytes/1024/1024).toFixed(2) + "MB / " + (totalBytes/1024/1024).toFixed(2) + "MB)");
        } else if (totalBytes <= 0 && (now - lastReportTime > 2000)) {
            lastReportTime = now;
            reportProgress("下载中... 已下载 " + (downloadedBytes/1024/1024).toFixed(2) + "MB");
        }
    }
    
    output.flush();
    output.close();
    input.close();
    
    reportProgress("文件下载完成！保存路径: " + targetPath);
    taskResult = "下载成功。保存在: " + targetPath;
} catch (e) {
    taskResult = "下载失败: " + e.message;
    throw e;
}
