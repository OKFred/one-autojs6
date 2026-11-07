import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { createRequire } from 'node:module';
import mqtt from 'mqtt';
import { discardPresenceOnDisconnect } from '../src/mqtt-presence.js';

// Exercise the installed MQTT.js wire/store implementation without a socket or broker process.
const codec = createRequire(import.meta.resolve('mqtt'))('mqtt-packet');

test('real MQTT.js reconnect drops old live presence while retaining unacknowledged telemetry', { timeout: 5000 }, async () => {
  for (const discardPresence of [false, true]) {
    const seen: { connection: number; topic: string; payload: string }[] = [], streams: Duplex[] = [];
    let connection = 0;
    const client = new mqtt.MqttClient(() => {
      const current = ++connection, parser = codec.parser({ protocolVersion: 5 });
      const stream = new Duplex({
        read() {},
        write(chunk, _encoding, done) { parser.parse(chunk); done(); },
      });
      streams.push(stream);
      parser.on('packet', (packet: any) => {
        if (packet.cmd === 'connect') queueMicrotask(() => stream.push(codec.generate({
          cmd: 'connack', sessionPresent: false, reasonCode: 0, properties: {},
        }, { protocolVersion: 5 })));
        if (packet.cmd === 'publish') {
          seen.push({ connection: current, topic: packet.topic, payload: packet.payload.toString() });
          // Lose every first-session PUBACK, then positively ACK retransmissions on reconnect.
          if (current > 1) queueMicrotask(() => stream.push(codec.generate({
            cmd: 'puback', messageId: packet.messageId, reasonCode: 0,
          }, { protocolVersion: 5 })));
        }
      });
      return stream;
    }, { manualConnect: true, clean: false, protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 1000, keepalive: 0 });
    client.on('error', () => {});
    const next = (event: 'connect' | 'close') => new Promise<void>(resolve => client.once(event, () => resolve()));
    if (discardPresence) discardPresenceOnDisconnect(client, 'synthetic/status');
    client.on('connect', () => client.publish('synthetic/status', 'birth-' + connection, { qos: 1, retain: true }, () => {}));
    try {
      const firstConnect = next('connect'); client.connect(); await firstConnect;
      client.publish('synthetic/status', 'heartbeat-old', { qos: 1, retain: true }, () => {});
      client.publish('synthetic/telemetry', 'durable-sample', { qos: 1, retain: false }, () => {});
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(seen.map(packet => packet.payload), ['birth-1', 'heartbeat-old', 'durable-sample']);
      const close = next('close'); streams[0].destroy(); await close;
      const reconnect = next('connect');
      // Automatic reconnect preserves these stores. Public reconnect() without options replaces them.
      client.reconnect({ outgoingStore: client.outgoingStore, incomingStore: client.incomingStore });
      await reconnect; await new Promise(resolve => setImmediate(resolve));
      const replay = seen.filter(packet => packet.connection === 2);
      assert.deepEqual(replay.filter(packet => packet.topic === 'synthetic/telemetry').map(packet => packet.payload), ['durable-sample']);
      assert.deepEqual(replay.filter(packet => packet.topic === 'synthetic/status').map(packet => packet.payload),
        discardPresence ? ['birth-2'] : ['birth-1', 'heartbeat-old', 'birth-2']);
    } finally {
      await client.endAsync(true);
      for (const stream of streams) stream.destroy();
    }
  }
});
