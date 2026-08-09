var request = __AUTOJS_TASK_PARAMS__;
var appType = String(request.type || "all");
if (appType !== "all" && appType !== "third" && appType !== "system") {
  throw new Error("type must be all, third, or system");
}

var pm = context.getPackageManager();
var packages = pm.getInstalledPackages(0);
var appList = [];
for (var i = 0; i < packages.size(); i++) {
  var packageInfo = packages.get(i);
  var appName = packageInfo.applicationInfo.loadLabel(pm).toString();
  var packageName = packageInfo.packageName;
  var versionName = packageInfo.versionName || "";
  var isSystem =
    (packageInfo.applicationInfo.flags &
      android.content.pm.ApplicationInfo.FLAG_SYSTEM) !==
    0;
  if (
    (appType === "third" && isSystem) ||
    (appType === "system" && !isSystem)
  ) {
    continue;
  }
  appList.push({
    name: appName,
    packageName: packageName,
    version: versionName,
    isSystem: isSystem,
  });
}
taskResult = JSON.stringify(appList);
