var context = context || app.context;
var packageName = "{{packageName}}";
var pm = context.getPackageManager();
var packageInfo = pm.getPackageInfo(packageName, 0);
var currentVersionName = packageInfo.versionName;
var currentVersionCode = packageInfo.versionCode;

var latestVersion = "{{latestVersion}}";
var latestVersionCodeStr = "{{latestVersionCode}}";
var latestVersionCode = latestVersionCodeStr ? parseInt(latestVersionCodeStr, 10) : 0;

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
    canUpdate: canUpdate
};

taskResult = JSON.stringify(result);
