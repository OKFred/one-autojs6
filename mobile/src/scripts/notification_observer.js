(function () {
  try {
    var packageAllowList = __PACKAGE_ALLOW_LIST__;
    var packageDenyList = __PACKAGE_DENY_LIST__;

    function shouldPublish(packageName) {
      if (packageDenyList.indexOf(packageName) >= 0) return false;
      return (
        packageAllowList.length === 0 ||
        packageAllowList.indexOf(packageName) >= 0
      );
    }

    events.observeNotification();
    events.onNotification(function (notification) {
      try {
        var packageName = String(notification.getPackageName() || "");
        if (!shouldPublish(packageName)) return;
        appendEvent("notification", {
          packageName: packageName,
          title: String(notification.getTitle() || ""),
          text: String(notification.getText() || ""),
          when: Number(notification.when || Date.now()),
        });
      } catch (error) {
        console.error("Notification handler error: " + error);
      }
    });
  } catch (error) {
    console.error("Notification observer setup error: " + error);
  }
})();
