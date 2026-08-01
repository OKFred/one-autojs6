/**
 * 构建并返回 EMQX 代理的连接 URL。
 * 不在此处设置默认值，默认值应在 .env.example 中体现。
 * @returns {string} 完整的 mqtts 协议 URL
 */
export function getEmqxBrokerUrl(): string {
  const EMQX_PROTOCOL = process.env.EMQX_PROTOCOL;
  const EMQX_USERNAME = process.env.EMQX_USERNAME;
  const EMQX_PASSWORD = process.env.EMQX_PASSWORD;
  const EMQX_HOST = process.env.EMQX_HOST;
  const EMQX_PORT = process.env.EMQX_PORT;

  if (!EMQX_PROTOCOL || !EMQX_USERNAME || !EMQX_PASSWORD || !EMQX_HOST || !EMQX_PORT) {
    throw new Error(
      "[ERROR] EMQX_PROTOCOL, EMQX_USERNAME, EMQX_PASSWORD, EMQX_HOST, and EMQX_PORT are all required in .env."
    );
  }

  return `${EMQX_PROTOCOL}://${EMQX_USERNAME}:${EMQX_PASSWORD}@${EMQX_HOST}:${EMQX_PORT}`;
}
