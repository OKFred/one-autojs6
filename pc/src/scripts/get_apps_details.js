var pm = context.getPackageManager();
var packages = pm.getInstalledPackages(0);
var appList = [];
for (var i = 0; i < packages.size(); i++) {
    var packageInfo = packages.get(i);
    var appName = packageInfo.applicationInfo.loadLabel(pm).toString();
    var packageName = packageInfo.packageName;
    var versionName = packageInfo.versionName || "";
    var isSystem = (packageInfo.applicationInfo.flags & android.content.pm.ApplicationInfo.FLAG_SYSTEM) !== 0;
    appList.push({
        name: appName,
        packageName: packageName,
        version: versionName,
        isSystem: isSystem
    });
}
taskResult = JSON.stringify(appList);
