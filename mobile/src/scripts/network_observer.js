events.broadcast.on("android.net.conn.CONNECTIVITY_CHANGE", function(intent) {
    try {
        var cm = context.getSystemService(context.CONNECTIVITY_SERVICE);
        var activeNetwork = cm ? cm.getActiveNetworkInfo() : null;
        var isConnected = activeNetwork != null && activeNetwork.isConnected();
        var typeName = activeNetwork ? String(activeNetwork.getTypeName()) : "DISCONNECTED";
        appendEvent("network", { isConnected: isConnected, type: typeName });
    } catch (err) {
        console.error("Network event error: " + err);
    }
});
