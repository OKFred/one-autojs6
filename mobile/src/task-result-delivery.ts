/** Deliver one persisted terminal result through its authoritative channel. */
export async function deliverPersistedTaskResult(options: {
  callbackRequired: boolean;
  mqtt?: () => Promise<void>;
  http?: () => Promise<void>;
}): Promise<boolean> {
  if (options.callbackRequired) {
    if (options.mqtt) void options.mqtt().catch(() => undefined);
    if (!options.http) throw new Error("Authenticated HTTP callback is unavailable");
    await options.http();
    return true;
  }
  if (!options.mqtt) return false;
  await options.mqtt();
  return true;
}
