/**
 * 网络切换异步任务测试脚本 (wifi / ethernet / carrier)
 *
 * 运行方式:
 *   node --env-file=pc/.env test/scripts/test_network_switch.js wifi
 */

const PC_IP = process.env.PC_IP || "127.0.0.1";
const PORT = process.env.PORT || "3000";
const API_TOKEN = process.env.ONE_AUTOJS6_API_TOKEN || "";
const CLIENT_ID = process.env.AUTOJS6_CLIENT_ID || "";
const target = process.argv[2] || "wifi";
const deadlineAt = Date.now() + 180_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestJson(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_TOKEN}`,
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.ok !== true) {
    throw new Error(
      `HTTP ${response.status}: ${body?.message || "invalid response"}`,
    );
  }
  return body;
}

async function run() {
  if (!API_TOKEN) throw new Error("ONE_AUTOJS6_API_TOKEN is required");
  if (!CLIENT_ID) throw new Error("AUTOJS6_CLIENT_ID is required");
  if (!new Set(["wifi", "ethernet", "carrier"]).has(target)) {
    throw new Error("target must be wifi, ethernet, or carrier");
  }

  const baseUrl = `http://${PC_IP}:${PORT}`;
  const created = await requestJson(`${baseUrl}/api/network/switch`, {
    method: "POST",
    body: JSON.stringify({
      target,
      timeoutMs: 20_000,
      clientId: CLIENT_ID,
      priority: "HIGH",
      preemptRunning: false,
    }),
  });
  const taskId = created.data?.taskId;
  if (typeof taskId !== "string" || !taskId) {
    throw new Error("dispatch response did not contain taskId");
  }
  process.stdout.write(`[NETWORK TEST] task=${taskId} target=${target}`);

  while (Date.now() < deadlineAt) {
    await delay(1000);
    const statusBody = await requestJson(`${baseUrl}/api/tasks/${taskId}`, {
      method: "GET",
    });
    const task = statusBody.data?.task;
    const status = task?.status;
    if (
      status === "PENDING" ||
      status === "RUNNING" ||
      status === "EXECUTING"
    ) {
      process.stdout.write(".");
      continue;
    }
    process.stdout.write("\n");
    if (status !== "SUCCESS") {
      throw new Error(
        `task finished as ${status || "UNKNOWN"}: ${task?.resultMessage || "no result message"}`,
      );
    }
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  throw new Error("network switch test exceeded 180 seconds");
}

run().catch((error) => {
  console.error(
    `[NETWORK TEST] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
