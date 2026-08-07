var eventResPath = "__EVENT_RES_PATH__";

function appendEvent(type, data) {
    try {
        var record = JSON.stringify({ type: type, timestamp: Date.now(), data: data });
        files.append(eventResPath, record + "\n");
    } catch (e) {
        console.error("Failed to append event: " + e);
    }
}
