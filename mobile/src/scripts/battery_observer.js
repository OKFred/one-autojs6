events.broadcast.on("android.intent.action.BATTERY_CHANGED", function(intent) {
    try {
        var level = intent.getIntExtra("level", -1);
        var scale = intent.getIntExtra("scale", -1);
        var status = intent.getIntExtra("status", -1);
        var batteryPct = (scale > 0) ? Math.floor((level / scale) * 100) : level;
        var isCharging = (status == 2 || status == 5);
        appendEvent("battery", { level: batteryPct, isCharging: isCharging });
    } catch (err) {
        console.error("Battery event error: " + err);
    }
});
