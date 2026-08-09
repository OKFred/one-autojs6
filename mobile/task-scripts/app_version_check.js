var request = __AUTOJS_TASK_PARAMS__;
var context = context || app.context;
var packageName = String(request.packageName || "org.autojs.autojs6");
var pm = context.getPackageManager();
var packageInfo = pm.getPackageInfo(packageName, 0);
var currentVersionName = packageInfo.versionName;
var currentVersionCode = packageInfo.versionCode;

var latestVersion = String(request.latestVersion || "");
var latestVersionCodeStr = String(request.latestVersionCode || "");
var latestVersionCode = latestVersionCodeStr
  ? parseInt(latestVersionCodeStr, 10)
  : 0;

var canUpdate = false;
if (latestVersionCode > 0) {
  canUpdate = latestVersionCode > currentVersionCode;
} else if (latestVersion) {
  canUpdate = latestVersion !== currentVersionName;
}

var result = {
  packageName: packageName,
  currentVersionName: currentVersionName,
  currentVersionCode: currentVersionCode,
  latestVersionName: latestVersion || currentVersionName,
  latestVersionCode: latestVersionCode || currentVersionCode,
  canUpdate: canUpdate,
};

taskResult = JSON.stringify(result);
