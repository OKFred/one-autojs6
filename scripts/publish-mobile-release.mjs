import fs from "node:fs";

const metadataPath = process.argv[2];
const serverBaseUrl = String(process.env.NODE_SERVER_RELEASE_URL || "").replace(
  /\/+$/,
  "",
);
const publishToken = process.env.MOBILE_RELEASE_PUBLISH_TOKEN || "";
if (!metadataPath || !serverBaseUrl || !publishToken) {
  throw new Error(
    "Usage: publish-mobile-release.mjs METADATA with NODE_SERVER_RELEASE_URL and MOBILE_RELEASE_PUBLISH_TOKEN",
  );
}
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));

/** 调用机器发布接口并返回 data。 */
async function call(path, body) {
  const response = await fetch(`${serverBaseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publishToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) {
    throw new Error(
      payload.message || `Node Server returned HTTP ${response.status}`,
    );
  }
  return payload.data;
}

const prepared = await call(
  "/api/v1/admin/mobile/client-release/upload/prepare",
  {
    releaseVersion: metadata.releaseVersion,
    artifactSha256: metadata.artifactSha256,
    artifactSize: metadata.artifactSize,
    manifest: metadata.manifest,
  },
);
const artifact = fs.readFileSync(metadata.artifactPath);
const uploadResponse = await fetch(prepared.uploadUrl, {
  method: "PUT",
  headers: {
    "Content-Type": "application/gzip",
    "x-amz-meta-sha256": metadata.artifactSha256,
  },
  body: artifact,
});
if (!uploadResponse.ok) {
  throw new Error(`Artifact upload failed with HTTP ${uploadResponse.status}`);
}
await call("/api/v1/admin/mobile/client-release/upload/finalize", {
  uploadId: prepared.uploadId,
  releaseNotes: process.env.AUTOJS6_RELEASE_NOTES || null,
});
process.stdout.write(`${metadata.releaseVersion} published\n`);
