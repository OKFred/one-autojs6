import { createHash } from "crypto";
import { createRequire } from "module";
import type {
  AedesPublishPacket,
  createBroker as createAedesBroker,
} from "aedes";
import net from "net";
import http from "http";
// @ts-ignore websocket-stream does not publish complete TypeScript declarations.
import websocket from "websocket-stream";
import mqtt, { type MqttClient } from "mqtt";

import { getEmqxBrokerUrl } from "../utils/mqtt.js";

const ONLINE_WINDOW_MS = 150_000;
const MQTT_OPERATION_TIMEOUT_MS = 10_000;
const require = createRequire(import.meta.url);
const createBroker = require("aedes") as typeof createAedesBroker;

type TaskResultHandler = (topicDeviceId: string, payload: unknown) => void;

interface PresencePayload {
  protocolVersion: 2;
  deviceId: string;
  status: "ONLINE" | "OFFLINE";
  timestamp: number;
}

/** 普通 JSON 对象类型守卫。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 隐去 MQTT URL 中的认证信息，避免 PC 日志泄露凭据。 */
function redactBrokerUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return value.replace(/\/\/[^@/]+@/, "//***:***@");
  }
}

/** 生成不可逆设备日志标签。 */
function deviceLogLabel(deviceId: string): string {
  return createHash("sha256").update(deviceId).digest("hex").slice(0, 12);
}

/** 解析可信 Presence。 */
function parsePresence(value: unknown): PresencePayload | null {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 2 ||
    typeof value.deviceId !== "string" ||
    (value.status !== "ONLINE" && value.status !== "OFFLINE") ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp)
  ) {
    return null;
  }
  return {
    protocolVersion: 2,
    deviceId: value.deviceId,
    status: value.status,
    timestamp: value.timestamp,
  };
}

/**
 * PC MQTT 兼容服务。外部 Broker 用于可信任务与结果，本地 Aedes 仅保留旧 Dashboard。
 */
export class MqttService {
  private static instance: MqttService;
  private aedes: ReturnType<typeof createAedesBroker> | null = null;
  private externalClient: MqttClient | null = null;
  private readonly onlineDevices = new Map<string, number>();
  private taskResultHandler: TaskResultHandler | null = null;

  private constructor() {}

  /** 获取 MQTT 服务单例。 */
  public static getInstance(): MqttService {
    if (!MqttService.instance) MqttService.instance = new MqttService();
    return MqttService.instance;
  }

  /** 注册严格任务结果处理器，避免服务之间循环 import。 */
  public setTaskResultHandler(handler: TaskResultHandler): void {
    this.taskResultHandler = handler;
  }

  /** 当前是否配置了可用于可信任务的外部认证 Broker。 */
  public hasExternalBroker(): boolean {
    return this.externalClient !== null;
  }

  /** 返回150秒窗口内唯一在线设备；零台或多台时返回 null。 */
  public getUniqueOnlineDeviceId(): string | null {
    const cutoff = Date.now() - ONLINE_WINDOW_MS;
    for (const [deviceId, seenAt] of this.onlineDevices) {
      if (seenAt < cutoff) this.onlineDevices.delete(deviceId);
    }
    const online = [...this.onlineDevices.keys()];
    return online.length === 1 ? online[0] : null;
  }

  /** 按隔离 Topic 路由 Presence 与任务结果。 */
  private handleMessage(topic: string, payload: Buffer | string): void {
    const matched = /^autojs6\/v2\/devices\/([^/]+)\/(presence|results)$/.exec(
      topic,
    );
    if (!matched) return;
    const topicDeviceId = matched[1];
    const kind = matched[2];
    let value: unknown;
    try {
      value = JSON.parse(payload.toString()) as unknown;
    } catch {
      return;
    }
    if (kind === "presence") {
      const presence = parsePresence(value);
      if (!presence || presence.deviceId !== topicDeviceId) return;
      if (presence.status === "ONLINE") {
        this.onlineDevices.set(topicDeviceId, Date.now());
      } else {
        this.onlineDevices.delete(topicDeviceId);
      }
      console.log(
        `[MQTT] Device [${deviceLogLabel(topicDeviceId)}] ${presence.status}`,
      );
      return;
    }
    this.taskResultHandler?.(topicDeviceId, value);
  }

  /** 初始化外部 MQTT 客户端，未配置外部 Broker 时启动旧本地 Broker。 */
  public init(port: number): void {
    const mqttUsername = process.env.EMQX_USERNAME;
    const mqttHost = process.env.EMQX_HOST;
    if (mqttUsername && mqttHost) {
      const brokerUrl = getEmqxBrokerUrl();
      const configuredClientId = String(
        process.env.AUTOJS6_PC_MQTT_CLIENT_ID || "",
      ).trim();
      const clientId =
        configuredClientId ||
        `one-autojs6-pc-${createHash("sha256").update(mqttUsername).digest("hex").slice(0, 16)}`;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId)) {
        throw new Error("AUTOJS6_PC_MQTT_CLIENT_ID has an invalid format");
      }
      console.log(
        `[MQTT] Connecting to external Broker: ${redactBrokerUrl(brokerUrl)}`,
      );
      this.externalClient = mqtt.connect(brokerUrl, {
        protocolVersion: 5,
        clean: false,
        clientId,
        properties: { sessionExpiryInterval: 86400 },
      });
      this.externalClient.on("connect", () => {
        console.log("[MQTT] Connected to external Broker.");
        this.externalClient?.subscribe(
          ["autojs6/v2/devices/+/presence", "autojs6/v2/devices/+/results"],
          { qos: 1 },
          (error) => {
            if (error) console.error("[MQTT] Subscribe failed", error.message);
          },
        );
      });
      this.externalClient.on("message", (topic, payload) =>
        this.handleMessage(topic, payload),
      );
      this.externalClient.on("error", (error) =>
        console.error("[MQTT] External Broker error:", error.message),
      );
      return;
    }

    this.aedes = createBroker();
    const mqttServer = net.createServer(this.aedes.handle);
    mqttServer.listen(port, () =>
      console.log(`[MQTT] Legacy local Broker is running on port ${port}`),
    );
    const httpServer = http.createServer();
    // @ts-expect-error websocket-stream and Aedes expose incompatible callback declarations.
    websocket.createServer({ server: httpServer }, this.aedes.handle);
    httpServer.listen(port + 1, () =>
      console.log(
        `[MQTT-WS] Legacy local Broker is running on port ${port + 1}`,
      ),
    );
    this.aedes.on("publish", (packet: AedesPublishPacket) => {
      if (packet?.topic && packet.payload) {
        this.handleMessage(packet.topic, packet.payload);
      }
    });
  }

  /** 向外部认证 Broker 发布并等待 QoS 1 PUBACK。 */
  public async publishExternal(topic: string, payload: unknown): Promise<void> {
    const client = this.externalClient;
    if (!client) {
      throw new Error(
        "Trusted task dispatch requires NODE_SERVER_BASE_URL or an authenticated external MQTT Broker",
      );
    }
    const payloadText =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("MQTT publish acknowledgement timed out")),
        MQTT_OPERATION_TIMEOUT_MS,
      );
      client.publish(topic, payloadText, { qos: 1, retain: false }, (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
