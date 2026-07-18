var downloadUrl = "{{downloadUrl}}";
var zipPath = "/sdcard/Download/update_temp.zip";
var destDir = "/sdcard/Download/update_temp_unzip/";

console.log("Start downloading ZIP from: " + downloadUrl);
var urlObj = new java.net.URL(downloadUrl);
var conn = urlObj.openConnection();
conn.connect();
var input = conn.getInputStream();
var output = new java.io.FileOutputStream(zipPath);
var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 4096);
var len;
while ((len = input.read(buffer)) !== -1) {
    output.write(buffer, 0, len);
}
output.flush();
output.close();
input.close();
console.log("ZIP download complete. Saved to: " + zipPath);

files.removeDir(destDir);
files.createWithDirs(destDir);

console.log("Starting extraction...");
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
console.log("Found APK: " + apkPath);

app.installApp(new java.io.File(apkPath));
taskResult = "ZIP downloaded, extracted successfully and installation dialog is launched.";
