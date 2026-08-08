(function() {
    try {
        var batteryFilter = new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED);
        var initialIntent = context.registerReceiver(null, batteryFilter);
        if (initialIntent != null) {
            var level = initialIntent.getIntExtra("level", -1);
            var scale = initialIntent.getIntExtra("scale", -1);
            var status = initialIntent.getIntExtra("status", -1);
            var batteryPct = (scale > 0) ? Math.floor((level / scale) * 100) : level;
            var isCharging = (status == 2 || status == 5);
            appendEvent("battery", { level: batteryPct, isCharging: isCharging });
        }

        var receiver = new android.content.BroadcastReceiver({
            onReceive: function(ctx, intent) {
                try {
                    var level = intent.getIntExtra("level", -1);
                    var scale = intent.getIntExtra("scale", -1);
                    var status = intent.getIntExtra("status", -1);
                    var batteryPct = (scale > 0) ? Math.floor((level / scale) * 100) : level;
                    var isCharging = (status == 2 || status == 5);
                    appendEvent("battery", { level: batteryPct, isCharging: isCharging });
                } catch (err) {
                    console.error("Battery receiver error: " + err);
                }
            }
        });
        context.registerReceiver(receiver, batteryFilter);
    } catch (e) {
        console.error("Battery observer setup error: " + e);
    }
})();
