import Aedes from "aedes";
import net from "net";
import http from "http";
// @ts-ignore
import websocket from "websocket-stream";
import mqtt, { MqttClient } from "mqtt";
import { TaskService } from "./task.service.js";
import { getEmqxBrokerUrl } from "../utils/mqtt.js";

/**
 * MQTT 代理服务类，用于初始化和管理 MQTT Broker 实例或云端 MQTT 连接。
 * 支持通过 MQTT 接收移动端回传的任务结果 (完全不依赖 HTTP 局域网回调)。
 */
export class MqttService {
  private static instance: MqttService;
  private aedes: any;
  private externalClient: MqttClient | null = null;

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
   * 初始化并启动 MQTT 服务。
   * 若配置了 MQTT_BROKER_URL 环境变量，则自动连云端 EMQX 代理；
   * 否则在本地启动 Aedes 内网 MQTT Broker。
   *
   * @param port - MQTT 代理监听的端口号 (仅本地模式起效)
   */
  public init(port: number) {
    const MQTT_USERNAME = process.env.EMQX_USERNAME;
    const MQTT_HOST = process.env.EMQX_HOST;

    if (MQTT_USERNAME && MQTT_HOST) {
      const brokerUrl = getEmqxBrokerUrl();
      console.log(
        `[MQTT] Connecting to External Cloud EMQX Broker: ${brokerUrl}`,
      );
      this.externalClient = mqtt.connect(brokerUrl, {
        clean: false,
        clientId: MQTT_USERNAME,
        properties: {
          sessionExpiryInterval: 86400, // 设置 EMQX 离线消息暂存 24 小时 (86400秒)
        },
      });

      this.externalClient.on("connect", () => {
        console.log("[MQTT] Connected to External EMQX Broker successfully.");

        // 订阅移动端回传任务结果的主题
        this.externalClient?.subscribe("autojs6/results", (err) => {
          if (!err) {
            console.log("[MQTT] Subscribed to cloud topic: autojs6/results");
          }
        });
      });

      this.externalClient.on("message", (topic, payload) => {
        if (topic === "autojs6/results") {
          this.handleTaskResult(payload.toString());
        }
      });

      this.externalClient.on("error", (err) => {
        console.error("[MQTT] External Broker Connection Error:", err.message);
      });
    } else {
      // 本地 Aedes 模式
      this.aedes = (Aedes as any)();
      const mqttServer = net.createServer(this.aedes.handle);
      mqttServer.listen(port, () => {
        console.log(`[MQTT] Local Broker is running on port ${port}`);
      });

      const wsPort = port + 1;
      const httpServer = http.createServer();
      websocket.createServer({ server: httpServer }, this.aedes.handle);
      httpServer.listen(wsPort, () => {
        console.log(
          `[MQTT-WS] Local Broker WebSocket is running on port ${wsPort}`,
        );
      });

      // Aedes 内部订阅/监听 publish 事件以捕捉 autojs6/results
      this.aedes.on("publish", (packet: any, client: any) => {
        if (packet && packet.topic === "autojs6/results") {
          this.handleTaskResult(packet.payload.toString());
        }
      });

      this.aedes.on("client", (client: any) => {
        console.log(
          `[MQTT] Client Connected: ${client ? client.id : "unknown"}`,
        );
      });

      this.aedes.on("clientDisconnect", (client: any) => {
        console.log(
          `[MQTT] Client Disconnected: ${client ? client.id : "unknown"}`,
        );
      });
    }
  }

  /**
   * 处理移动端回传的任务结果 JSON
   */
  private handleTaskResult(payloadStr: string) {
    try {
      const data = JSON.parse(payloadStr);
      const { taskId, status, message } = data;
      if (taskId && status) {
        console.log(
          `[MQTT-RESULT] Received task feedback via MQTT for task ${taskId}: ${status}`,
        );
        TaskService.getInstance().updateTaskStatus(taskId, status, message);
      }
    } catch (err: any) {
      console.error(
        "[MQTT-RESULT] Failed to parse task result payload:",
        err.message,
      );
    }
  }

  /**
   * 向指定的主题发布 MQTT 消息载荷。
   *
   * @param topic - MQTT 主题
   * @param payload - 消息载荷对象或字符串
   */
  public publish(topic: string, payload: any) {
    const payloadStr =
      typeof payload === "string" ? payload : JSON.stringify(payload);

    if (this.externalClient) {
      this.externalClient.publish(topic, payloadStr, { qos: 1 }, (err) => {
        if (err) {
          console.error(`[MQTT] Publish error on topic ${topic}:`, err.message);
        } else {
          console.log(
            `[MQTT] Successfully published to Cloud EMQX topic: ${topic}`,
          );
        }
      });
    } else if (this.aedes) {
      this.aedes.publish(
        {
          cmd: "publish",
          topic,
          payload: payloadStr,
          qos: 1,
          retain: false,
          dup: false,
          messageId: 0,
        },
        (err: any) => {
          if (err) {
            console.error(`[MQTT] Publish error on topic ${topic}:`, err);
          }
        },
      );
    } else {
      console.error(
        "[MQTT] Neither external client nor local aedes broker is initialized.",
      );
    }
  }
}
