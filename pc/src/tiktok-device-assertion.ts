/**
 * Bind an optional operator assertion to the PC's configured single device.
 * @param assertion Optional HTTP header; absence preserves existing requests.
 * @param configuredTarget Existing AUTOJS6_CLIENT_ID setting.
 * @returns The pinned target, or undefined for an unchanged legacy request.
 */
export function assertedTikTokTarget(assertion: string | undefined, configuredTarget: string | undefined): string | undefined {
  if (assertion === undefined) return undefined;
  const configured = String(configuredTarget || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(assertion) ||
      !/^[A-Za-z0-9._:-]{1,100}$/.test(configured) || assertion !== configured) {
    throw new Error("Pinned device assertion does not match the configured PC target");
  }
  return configured;
}
