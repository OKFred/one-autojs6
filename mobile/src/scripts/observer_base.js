var eventResPath = __EVENT_RES_PATH__;
var observerControlPath = __OBSERVER_CONTROL_PATH__;
var observerInstanceId = __OBSERVER_INSTANCE_ID__;

function appendEvent(type, data) {
  try {
    var record = JSON.stringify({
      type: type,
      timestamp: Date.now(),
      data: data,
    });
    files.createWithDirs(eventResPath);
    files.append(eventResPath, record + "\n");
    console.log(
      "[AutoJS_Observer] Event recorded: " + type + " " + JSON.stringify(data),
    );
  } catch (e) {
    console.error("[AutoJS_Observer] Failed to append event: " + e);
  }
}

// 每次客户端重启都会写入新的实例 ID；旧 Observer 发现令牌变化后自行退出，
// 避免重复注册 BroadcastReceiver 导致事件成倍上报。
setInterval(function () {
  try {
    if (
      !files.exists(observerControlPath) ||
      String(files.read(observerControlPath)).trim() !== observerInstanceId
    ) {
      console.log("[AutoJS_Observer] Superseded by a newer observer instance.");
      exit();
    }
  } catch (error) {
    console.error("[AutoJS_Observer] Control check failed: " + error);
  }
}, 2000);
