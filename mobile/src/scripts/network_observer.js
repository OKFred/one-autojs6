(function() {
    try {
        var lastState = { isConnected: null, type: null };

        var netFilter = new android.content.IntentFilter("android.net.conn.CONNECTIVITY_CHANGE");
        var receiver = new android.content.BroadcastReceiver({
            onReceive: function(ctx, intent) {
                try {
                    var cm = context.getSystemService(context.CONNECTIVITY_SERVICE);
                    var activeNetwork = cm ? cm.getActiveNetworkInfo() : null;
                    var isConnected = activeNetwork != null && activeNetwork.isConnected();
                    var typeName = activeNetwork ? String(activeNetwork.getTypeName()) : "DISCONNECTED";

                    if (lastState.isConnected === isConnected && lastState.type === typeName) {
                        return;
                    }
                    lastState.isConnected = isConnected;
                    lastState.type = typeName;

                    appendEvent("network", { isConnected: isConnected, type: typeName });
                } catch (err) {
                    console.error("Network receiver error: " + err);
                }
            }
        });
        context.registerReceiver(receiver, netFilter);
    } catch (e) {
        console.error("Network observer setup error: " + e);
    }
})();
