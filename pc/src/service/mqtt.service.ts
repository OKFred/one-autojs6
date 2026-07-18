import Aedes from 'aedes';
import net from 'net';
import http from 'http';
// @ts-ignore
import websocket from 'websocket-stream';

/**
 * MQTT 代理服务类，用于初始化和管理 MQTT Broker 实例。
 */
export class MqttService {
  private static instance: MqttService;
  private aedes: any;

  private constructor() {}

  /**
   * 获取 MqttService 单例实例。
   * 
   * @returns MqttService 实例
   */
  public static getInstance(): MqttService {
    if (!MqttService.instance) {
      MqttService.instance = new MqttService();
    }
    return MqttService.instance;
  }

  /**
   * 初始化并启动 MQTT 代理。
   * 
   * @param port - MQTT 代理监听的端口号
   */
  public init(port: number) {
    this.aedes = (Aedes as any)();
    const mqttServer = net.createServer(this.aedes.handle);
    mqttServer.listen(port, () => {
      console.log(`[MQTT] Broker is running on port ${port}`);
    });

    // 启动 WebSocket 服务器
    const wsPort = port + 1;
    const httpServer = http.createServer();
    websocket.createServer({ server: httpServer }, this.aedes.handle);
    httpServer.listen(wsPort, () => {
      console.log(`[MQTT-WS] Broker WebSocket is running on port ${wsPort}`);
    });

    this.aedes.on('client', (client: any) => {
      console.log(`[MQTT] Client Connected: ${client ? client.id : 'unknown'}`);
    });

    this.aedes.on('clientDisconnect', (client: any) => {
      console.log(`[MQTT] Client Disconnected: ${client ? client.id : 'unknown'}`);
    });
  }

  /**
   * 向指定的主题发布 MQTT 消息载荷。
   * 
   * @param topic - MQTT 主题
   * @param payload - 消息载荷对象或字符串
   */
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
