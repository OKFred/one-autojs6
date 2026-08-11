var request = __AUTOJS_TASK_PARAMS__ || {};
var target = String(request.target || request.network || "wifi").toLowerCase();

if (target === "cellular" || target === "mobile" || target === "data") {
  target = "carrier";
}

if (target !== "wifi" && target !== "ethernet" && target !== "carrier") {
  throw new Error(
    "Invalid network target: " +
      target +
      ". Must be wifi, ethernet, or carrier.",
  );
}

var timeoutMs = parseInt(
  request.timeoutMs ||
    (request.timeoutSeconds ? request.timeoutSeconds * 1000 : 20000),
  10,
);
if (isNaN(timeoutMs) || timeoutMs <= 0) {
  timeoutMs = 20000;
}

var context = context || app.context;
var cm = context.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
var wifiManager = context.getSystemService(
  android.content.Context.WIFI_SERVICE,
);
var telephonyManager = context.getSystemService(
  android.content.Context.TELEPHONY_SERVICE,
);

/** 获取当前 Wi-Fi 开关状态。 */
function getWifiEnabled() {
  try {
    if (wifiManager) return wifiManager.isWifiEnabled();
  } catch (_) {}
  var res = shell("settings get global wifi_on", true);
  return res && res.result ? res.result.trim() === "1" : false;
}

/** 获取当前蜂窝移动数据开关状态。 */
function getDataEnabled() {
  try {
    if (telephonyManager) return telephonyManager.isDataEnabled();
  } catch (_) {}
  var res = shell("settings get global mobile_data", true);
  return res && res.result ? res.result.trim() === "1" : false;
}

/** 获取当前 Ethernet 网卡 UP 状态。 */
function getEthUp() {
  var res = shell("ip link show eth0", true);
  if (res && res.result) {
    return (
      res.result.indexOf("state UP") !== -1 ||
      res.result.indexOf("RUNNING") !== -1
    );
  }
  return false;
}

/** 获取当前活跃网络类型。 */
function getActiveNetworkType() {
  if (!cm) return "DISCONNECTED";
  var info = cm.getActiveNetworkInfo();
  if (!info || !info.isConnected()) return "DISCONNECTED";
  var type = info.getType();
  var typeName = String(info.getTypeName()).toUpperCase();
  if (type === 1 || typeName.indexOf("WIFI") !== -1) return "WIFI";
  if (
    type === 9 ||
    typeName.indexOf("ETHERNET") !== -1 ||
    typeName.indexOf("ETH") !== -1
  ) {
    return "ETHERNET";
  }
  if (
    type === 0 ||
    typeName.indexOf("MOBILE") !== -1 ||
    typeName.indexOf("CELLULAR") !== -1
  ) {
    return "CARRIER";
  }
  return typeName;
}

var initialWifi = getWifiEnabled();
var initialData = getDataEnabled();
var initialEth = getEthUp();
var initialActiveType = getActiveNetworkType();

console.log(
  "[NETWORK_SWITCH] Initial state -> WiFi: " +
    initialWifi +
    ", Carrier: " +
    initialData +
    ", Eth: " +
    initialEth +
    ", Active: " +
    initialActiveType,
);

/** 设置 Wi-Fi 开关。 */
function setWifi(enable) {
  if (enable) {
    shell("svc wifi enable; cmd wifi set-wifi-enabled enabled", true);
  } else {
    shell("svc wifi disable; cmd wifi set-wifi-enabled disabled", true);
  }
}

/** 设置移动蜂窝数据开关。 */
function setData(enable) {
  if (enable) {
    shell("svc data enable; cmd telephony set-user-data-enabled true", true);
  } else {
    shell("svc data disable; cmd telephony set-user-data-enabled false", true);
  }
}

/** 设置以太网网卡开关。 */
function setEth(enable) {
  if (enable) {
    shell("ip link set eth0 up; ifconfig eth0 up; svc ethernet enable", true);
  } else {
    shell(
      "ip link set eth0 down; ifconfig eth0 down; svc ethernet disable",
      true,
    );
  }
}

console.log("[NETWORK_SWITCH] Switching network to: " + target);

if (target === "wifi") {
  setWifi(true);
  setData(false);
  setEth(false);
} else if (target === "carrier") {
  setData(true);
  setWifi(false);
  setEth(false);
} else if (target === "ethernet") {
  setEth(true);
  setWifi(false);
  setData(false);
}

var startTime = Date.now();
var isAvailable = false;
var currentActive = "DISCONNECTED";

while (Date.now() - startTime < timeoutMs) {
  sleep(1000);
  currentActive = getActiveNetworkType();
  console.log(
    "[NETWORK_SWITCH] Waiting for network connection (" +
      Math.round((Date.now() - startTime) / 1000) +
      "s)... Current active: " +
      currentActive,
  );

  if (
    (target === "wifi" && currentActive === "WIFI") ||
    (target === "ethernet" && currentActive === "ETHERNET") ||
    (target === "carrier" && currentActive === "CARRIER")
  ) {
    isAvailable = true;
    break;
  }
}

if (isAvailable) {
  console.log("[NETWORK_SWITCH] Network switch to " + target + " succeeded!");
  taskStatus = "SUCCESS";
  taskCode = "OK";
  taskResult = JSON.stringify({
    switched: true,
    target: target,
    activeNetworkType: currentActive,
    message: "Successfully switched network to " + target,
  });
} else {
  console.warn(
    "[NETWORK_SWITCH] Network target " +
      target +
      " not available within " +
      timeoutMs / 1000 +
      "s. Resuming previous network state...",
  );

  setWifi(initialWifi);
  setData(initialData);
  setEth(initialEth);

  sleep(3000);

  var restoredActive = getActiveNetworkType();

  taskStatus = "FAILURE";
  taskCode = "NETWORK_UNAVAILABLE";
  taskResult = JSON.stringify({
    switched: false,
    target: target,
    resumedPrevious: true,
    previousState: {
      wifi: initialWifi,
      carrier: initialData,
      ethernet: initialEth,
    },
    restoredActiveNetworkType: restoredActive,
    message:
      "Network target " +
      target +
      " not available within " +
      timeoutMs / 1000 +
      "s, resumed previous network state",
  });
}
