interface ReconnectableMqttClient {
  once(event: "connect", listener: () => void): unknown;
  off(event: "connect", listener: () => void): unknown;
  end(
    force: boolean,
    options: Record<string, never>,
    callback: (error?: Error) => void,
  ): unknown;
  reconnect(): unknown;
}

/**
 * 强制关闭旧 MQTT 套接字后再重连，避免 MQTT.js 等待无法 PUBACK 的
 * outgoing 队列而永久停留在 disconnecting 状态。
 */
export function forceReconnectMqtt(
  client: ReconnectableMqttClient,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let completed = false;
    const finish = (error?: Error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      client.off("connect", onConnect);
      if (error) reject(error);
      else resolve();
    };
    const onConnect = () => finish();
    const timer = setTimeout(
      () => finish(new Error("MQTT_RECONNECT_TIMEOUT")),
      timeoutMs,
    );
    client.once("connect", onConnect);
    try {
      client.end(true, {}, (error) => {
        if (error) return finish(error);
        try {
          client.reconnect();
        } catch (reconnectError) {
          finish(
            reconnectError instanceof Error
              ? reconnectError
              : new Error(String(reconnectError)),
          );
        }
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
