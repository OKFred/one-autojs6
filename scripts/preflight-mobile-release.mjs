const serverBaseUrl = String(
  process.env.NODE_SERVER_RELEASE_URL || "",
).replace(/\/+$/, "");
const publishToken = process.env.MOBILE_RELEASE_PUBLISH_TOKEN || "";

if (!serverBaseUrl || !publishToken) {
  throw new Error(
    "NODE_SERVER_RELEASE_URL and MOBILE_RELEASE_PUBLISH_TOKEN are required",
  );
}

const runId = String(process.env.GITHUB_RUN_ID || Date.now()).replace(
  /[^0-9A-Za-z.-]/g,
  "-",
);
const releaseVersion = `v0.0.0-preflight.${runId}`;
const artifactSha256 = "0".repeat(64);

/** 提取不会包含上传 URL 或发布令牌的服务端错误摘要。 */
function getErrorSummary(payload) {
  const message =
    typeof payload?.message === "string" ? payload.message : "Unknown error";
  const details = Array.isArray(payload?.data?.details)
    ? payload.data.details
        .map((detail) =>
          typeof detail?.message === "string" ? detail.message : "",
        )
        .filter(Boolean)
        .join("; ")
    : "";
  return `${message}${details ? `: ${details}` : ""}`.slice(0, 2000);
}

const response = await fetch(
  `${serverBaseUrl}/api/v1/admin/mobile/client-release/upload/prepare`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publishToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      releaseVersion,
      artifactSha256,
      artifactSize: 1,
      manifest: {
        formatVersion: 1,
        releaseVersion,
        packageVersion: releaseVersion.slice(1),
        gitCommit: process.env.GITHUB_SHA || "0".repeat(40),
        createdAt: new Date().toISOString(),
        protocolVersion: 2,
        deploymentProtocolVersion: 1,
        minimumSupervisorVersion: "1.0.0",
        entrypoint: "dist/client.js",
        files: {},
      },
    }),
  },
);
const payload = await response.json();

if (!response.ok || payload.ok !== true) {
  throw new Error(
    `Release preflight failed with HTTP ${response.status}: ${getErrorSummary(payload)}`,
  );
}
if (
  typeof payload.data?.uploadUrl !== "string" ||
  !payload.data.uploadUrl.startsWith("https://")
) {
  throw new Error("Release preflight returned an invalid upload URL");
}

process.stdout.write(
  `Release preflight passed for ${serverBaseUrl}; no artifact was uploaded or finalized\n`,
);
