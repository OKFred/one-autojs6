import type { CampaignTransport } from "./tiktok-campaign.js";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reuse the existing PC process and its task receipts through its authenticated loopback API.
 * @param expectedClientId The one reviewed device in the private campaign manifest.
 * @param env Operator environment containing the existing PC port and API token.
 * @param fetchImpl Injectable HTTP boundary for offline tests; no MQTT client is created.
 * @returns A single-device async transport with no arbitrary host or redirect support.
 */
export function campaignHttpTransport(
  expectedClientId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): CampaignTransport {
  const port = String(env.PORT || "");
  const token = String(env.ONE_AUTOJS6_API_TOKEN || "");
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 ||
      !/^[\x21-\x7e]{16,4096}$/.test(token) ||
      !/^[A-Za-z0-9._:-]{1,100}$/.test(expectedClientId)) {
    throw new Error("Existing loopback PC port, API token and pinned device are required");
  }
  const origin = `http://127.0.0.1:${port}`;

  /**
   * Call one fixed PC endpoint without forwarding credentials to redirects or echoing provider errors.
   * @param pathname Internally constructed endpoint path.
   * @param body Optional normalized v2 task request.
   * @returns The existing standard response envelope data.
   */
  async function call(pathname: string, body?: Record<string, unknown>): Promise<Record<string, any>> {
    const response = await fetchImpl(`${origin}${pathname}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "X-Device-Assertion": expectedClientId,
        ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const value = await response.json() as Record<string, any>;
    if (!response.ok || value?.ok !== true || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
      throw new Error("Existing PC API did not accept the operator request");
    }
    return value.data;
  }

  /**
   * Check the existing process's configured default before delivery; this cannot select another device.
   * @returns Completion only when the process matches the reviewed campaign binding.
   */
  async function assertServerTarget(): Promise<void> {
    const config = await call("/api/config");
    if (typeof config.defaultClientId !== "string" || config.defaultClientId.trim() !== expectedClientId) {
      throw new Error("Existing PC process does not match the campaign's pinned device");
    }
  }

  return {
    dispatch: async (params, clientId) => {
      if (clientId !== expectedClientId) throw new Error("Campaign cannot override its pinned device");
      await assertServerTarget();
      const receipt = await call("/api/tiktok/post", params);
      if (typeof receipt.taskId !== "string" || !TASK_ID.test(receipt.taskId) ||
          !["PENDING", "EXECUTING"].includes(receipt.status) || receipt.contractVersion !== 2 ||
          receipt.publicationId !== params.publicationId || receipt.action !== params.action) {
        throw new Error("PC returned an invalid async task receipt; query the original publication only");
      }
      return { taskId: receipt.taskId };
    },
    inspect: async taskId => {
      if (!TASK_ID.test(taskId)) throw new Error("Invalid original task receipt");
      await assertServerTarget();
      const value = await call(`/api/tasks/${taskId}`);
      const task = value.task;
      if (!task || task.taskId !== taskId || task.clientId !== expectedClientId || task.scriptId !== "tiktok.post" ||
          typeof task.status !== "string" || typeof task.createTimeUtc !== "number" || !Number.isFinite(task.createTimeUtc)) {
        throw new Error("PC task receipt is not bound to this campaign device and script");
      }
      return { status: task.status, clientId: task.clientId, scriptId: task.scriptId, createTimeUtc: task.createTimeUtc, result: value.result };
    },
  };
}
