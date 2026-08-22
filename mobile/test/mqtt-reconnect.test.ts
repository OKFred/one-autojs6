import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { forceReconnectMqtt } from "../src/mqtt-reconnect.js";

class FakeMqttClient extends EventEmitter {
  endedForcefully = false;
  reconnectCalls = 0;
  private endCallback: ((error?: Error) => void) | null = null;

  end(
    force: boolean,
    _options: Record<string, never>,
    callback: (error?: Error) => void,
  ) {
    this.endedForcefully = force;
    this.endCallback = callback;
  }

  completeEnd(error?: Error) {
    this.endCallback?.(error);
  }

  reconnect() {
    this.reconnectCalls += 1;
  }
}

const client = new FakeMqttClient();
const reconnecting = forceReconnectMqtt(client, 1_000);
assert.equal(client.endedForcefully, true);
assert.equal(client.reconnectCalls, 0);
client.completeEnd();
assert.equal(client.reconnectCalls, 1);
client.emit("connect");
await reconnecting;

const failedClient = new FakeMqttClient();
const failed = forceReconnectMqtt(failedClient, 1_000);
failedClient.completeEnd(new Error("close failed"));
await assert.rejects(failed, /close failed/);
assert.equal(failedClient.reconnectCalls, 0);

console.log("MQTT force reconnect tests passed");
