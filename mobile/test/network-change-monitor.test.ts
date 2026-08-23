import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { AndroidNetworkChangeMonitor } from "../src/network-change-monitor.js";

class FakeMonitorProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const children: FakeMonitorProcess[] = [];
let reconciliations = 0;
const monitor = new AndroidNetworkChangeMonitor(
  async () => {
    reconciliations += 1;
  },
  {
    debounceMs: 10,
    restartDelayMs: 10,
    createProcess: () => {
      const child = new FakeMonitorProcess();
      children.push(child);
      return child;
    },
  },
);

monitor.start();
assert.equal(children.length, 1);
children[0].stdout.emit("data", "Deleted 10.0.0.1 dev rmnet_data2\n");
children[0].stdout.emit("data", "10.0.0.2 dev rmnet_data2\n");
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(reconciliations, 1);

children[0].emit("exit", 1, null);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(children.length, 2);

monitor.stop();
assert.equal(children[1].killed, true);
children[1].stdout.emit("data", "default route changed\n");
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(reconciliations, 1);

console.log("network change monitor tests passed");
