var eventResPath = "__EVENT_RES_PATH__";

function appendEvent(type, data) {
    try {
        var record = JSON.stringify({ type: type, timestamp: Date.now(), data: data });
        files.createWithDirs(eventResPath);
        files.append(eventResPath, record + "\n");
        console.log("[AutoJS_Observer] Event recorded: " + type + " " + JSON.stringify(data));
    } catch (e) {
        console.error("[AutoJS_Observer] Failed to append event: " + e);
    }
}
