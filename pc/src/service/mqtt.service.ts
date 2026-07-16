import Aedes from 'aedes';
import net from 'net';

export class MqttService {
  private static instance: MqttService;
  private aedes: any;

  private constructor() {}

  public static getInstance(): MqttService {
    if (!MqttService.instance) {
      MqttService.instance = new MqttService();
    }
    return MqttService.instance;
  }

  public init(port: number) {
    this.aedes = (Aedes as any)();
    const mqttServer = net.createServer(this.aedes.handle);
    mqttServer.listen(port, () => {
      console.log(`[MQTT] Broker is running on port ${port}`);
    });

    this.aedes.on('client', (client: any) => {
      console.log(`[MQTT] Client Connected: ${client ? client.id : 'unknown'}`);
    });

    this.aedes.on('clientDisconnect', (client: any) => {
      console.log(`[MQTT] Client Disconnected: ${client ? client.id : 'unknown'}`);
    });
  }

  public publish(topic: string, payload: any) {
    if (!this.aedes) {
      console.error('[MQTT] Broker not initialized.');
      return;
    }
    this.aedes.publish({
      cmd: 'publish',
      topic,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      qos: 1,
      retain: false,
      dup: false,
      messageId: 0
    }, (err: any) => {
      if (err) {
        console.error(`[MQTT] Publish error on topic ${topic}:`, err);
      }
    });
  }
}
