/** A normalized address assigned to one Android network interface. */
export interface AndroidInterfaceAddress {
  family: "ipv4" | "ipv6";
  address: string;
  prefixLength: number;
  scope: string;
}

/** A network interface and its sanitized IP addresses. */
export interface AndroidNetworkInterface {
  name: string;
  addresses: AndroidInterfaceAddress[];
}

/** Structured Wi-Fi state parsed from `cmd wifi status`. */
export interface AndroidWifiSnapshot {
  enabled: boolean;
  connected: boolean;
  ssid: string | null;
  bssid: string | null;
  ipv4Address: string | null;
  rssiDbm: number | null;
  linkSpeedMbps: number | null;
  txLinkSpeedMbps: number | null;
  rxLinkSpeedMbps: number | null;
  frequencyMhz: number | null;
  standard: string | null;
}

/** Sanitized LTE measurements for one modem slot. */
export interface AndroidLteSignal {
  rssiDbm: number | null;
  rsrpDbm: number | null;
  rsrqDb: number | null;
  rssnrDb: number | null;
  level: number | null;
}

/** Sanitized 5G NR measurements for one modem slot. */
export interface AndroidNrSignal {
  csiRsrpDbm: number | null;
  csiRsrqDb: number | null;
  ssRsrpDbm: number | null;
  ssRsrqDb: number | null;
  ssSinrDb: number | null;
  level: number | null;
}

/** Dynamic telephony state parsed for one Android phone slot. */
export interface AndroidTelephonyRegistrySlot {
  slotIndex: number;
  operatorLongName: string | null;
  operatorShortName: string | null;
  voiceRegistrationState: string | null;
  dataRegistrationState: string | null;
  voiceRadioTechnology: string | null;
  dataRadioTechnology: string | null;
  emergencyOnly: boolean | null;
  roaming: boolean | null;
  dataConnectionState: string | null;
  primarySignalTechnology: string | null;
  lte: AndroidLteSignal | null;
  nr: AndroidNrSignal | null;
}

/** A phone number representation that never exposes the complete value. */
export interface SanitizedPhoneNumber {
  availability: "available" | "unavailable";
  masked: string | null;
  reason: string | null;
}

/** Sanitized Android subscription metadata for one active SIM/eSIM slot. */
export interface AndroidSubscription {
  subscriptionId: number;
  slotIndex: number;
  displayName: string | null;
  carrierName: string | null;
  countryIso: string | null;
  mcc: string | null;
  mnc: string | null;
  embedded: boolean | null;
  roaming: boolean | null;
  phoneNumber: SanitizedPhoneNumber;
}

/** Combined, sanitized state returned by the telephony operation. */
export interface AndroidTelephonySnapshot {
  available: boolean;
  subscriptions: Array<{
    subscriptionId: number | null;
    slotIndex: number;
    simState: string | null;
    displayName: string | null;
    carrierName: string | null;
    countryIso: string | null;
    mcc: string | null;
    mnc: string | null;
    embedded: boolean | null;
    roaming: boolean | null;
    phoneNumber: SanitizedPhoneNumber;
    voice: {
      registrationState: string | null;
      radioTechnology: string | null;
    };
    data: {
      registrationState: string | null;
      radioTechnology: string | null;
      connectionState: string | null;
    };
    emergencyOnly: boolean | null;
    signal: {
      primaryTechnology: string | null;
      lte: AndroidLteSignal | null;
      nr: AndroidNrSignal | null;
    };
  }>;
  sensitiveIdentifiersIncluded: false;
}

const ANDROID_SIGNAL_INVALID = 2_147_483_647;
const MAX_NETWORK_ADDRESS_ROWS = 100;
const MAX_TELEPHONY_SLOTS = 8;

/** Escape a literal string before embedding it in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return a parsed integer or null for absent and Android-invalid values. */
function nullableInteger(value: string | undefined): number | null {
  if (value === undefined || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed === ANDROID_SIGNAL_INVALID ||
    parsed === -ANDROID_SIGNAL_INVALID - 1
  ) {
    return null;
  }
  return parsed;
}

/** Read a numeric `key=value` token from a bounded diagnostic section. */
function numericToken(section: string, key: string): number | null {
  return nullableInteger(
    new RegExp(`(?:^|\\s)${escapeRegExp(key)}\\s*=\\s*(-?\\d+)`).exec(
      section,
    )?.[1],
  );
}

/** Read and range-check one numeric signal token. */
function boundedNumericToken(
  section: string,
  key: string,
  minimum: number,
  maximum: number,
): number | null {
  const value = numericToken(section, key);
  return value !== null && value >= minimum && value <= maximum ? value : null;
}

/** Parse LTE signal metrics and drop Android's all-invalid placeholder. */
function parseLteSignal(section: string | undefined): AndroidLteSignal | null {
  if (!section) return null;
  const value: AndroidLteSignal = {
    rssiDbm: boundedNumericToken(section, "rssi", -200, -1),
    rsrpDbm: boundedNumericToken(section, "rsrp", -200, -1),
    rsrqDb: boundedNumericToken(section, "rsrq", -100, 0),
    rssnrDb: boundedNumericToken(section, "rssnr", -500, 500),
    level: boundedNumericToken(section, "level", 0, 4),
  };
  return [value.rssiDbm, value.rsrpDbm, value.rsrqDb, value.rssnrDb].some(
    (measurement) => measurement !== null,
  )
    ? value
    : null;
}

/** Parse 5G NR signal metrics and drop Android's all-invalid placeholder. */
function parseNrSignal(section: string | undefined): AndroidNrSignal | null {
  if (!section) return null;
  const value: AndroidNrSignal = {
    csiRsrpDbm: boundedNumericToken(section, "csiRsrp", -200, -1),
    csiRsrqDb: boundedNumericToken(section, "csiRsrq", -100, 0),
    ssRsrpDbm: boundedNumericToken(section, "ssRsrp", -200, -1),
    ssRsrqDb: boundedNumericToken(section, "ssRsrq", -100, 0),
    ssSinrDb: boundedNumericToken(section, "ssSinr", -500, 500),
    level: boundedNumericToken(section, "level", 0, 4),
  };
  return [
    value.csiRsrpDbm,
    value.csiRsrqDb,
    value.ssRsrpDbm,
    value.ssRsrqDb,
    value.ssSinrDb,
  ].some((measurement) => measurement !== null)
    ? value
    : null;
}

/** Normalize a nullable Android dump field. */
function nullableText(value: string | undefined): string | null {
  const normalized = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 120);
  return !normalized || normalized === "null" ? null : normalized;
}

/** Sanitize a user-visible carrier label and redact phone-like digit runs. */
function sanitizedLabel(value: string | undefined): string | null {
  const normalized = nullableText(value);
  return normalized
    ? normalized.replace(/\+?\d(?:[\s().-]*\d){6,}/g, "[redacted-number]")
    : null;
}

/** Return a bounded decimal carrier code or null. */
function carrierCode(
  value: string | null,
  minimumLength: number,
  maximumLength: number,
): string | null {
  return value &&
    new RegExp(`^\\d{${minimumLength},${maximumLength}}$`).test(value)
    ? value
    : null;
}

/** Return a two-letter subscription country code or null. */
function countryIso(value: string | null): string | null {
  return value && /^[A-Za-z]{2}$/.test(value) ? value.toLowerCase() : null;
}

/** Read one space-delimited `field=value` item from a subscription dump row. */
function subscriptionField(row: string, field: string): string | null {
  const matched = new RegExp(
    `(?:\\{|\\s)${escapeRegExp(field)}=(.*?)(?=\\s+[A-Za-z][A-Za-z0-9]*=|\\}$)`,
  ).exec(row);
  return matched ? nullableText(matched[1]) : null;
}

/** Mask a subscription phone number while retaining only its last four digits. */
function maskedPhoneNumber(value: string | null): SanitizedPhoneNumber {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 7) {
    return {
      availability: "unavailable",
      masked: null,
      reason: "NOT_REPORTED_BY_ANDROID",
    };
  }
  return {
    availability: "available",
    masked: `***${digits.slice(-4)}`,
    reason: null,
  };
}

/** Map Android's data connection integer to a stable display value. */
function dataConnectionState(value: string | undefined): string | null {
  const states: Record<string, string> = {
    "0": "DISCONNECTED",
    "1": "CONNECTING",
    "2": "CONNECTED",
    "3": "SUSPENDED",
    "4": "DISCONNECTING",
  };
  return value === undefined ? null : states[value] || `UNKNOWN_${value}`;
}

/** Parse `ip -o addr show` without returning flags or other raw command text. */
export function parseNetworkInterfaces(
  output: string,
): AndroidNetworkInterface[] {
  const byName = new Map<string, AndroidNetworkInterface>();
  for (const line of output
    .split(/\r?\n/)
    .slice(0, MAX_NETWORK_ADDRESS_ROWS)) {
    const matched =
      /^\s*\d+:\s+(\S+)\s+(inet6?)\s+([^/\s]+)\/(\d+)\b.*?\bscope\s+(\S+)/.exec(
        line,
      );
    if (!matched) continue;
    const name = matched[1].split("@")[0];
    const prefixLength = Number(matched[4]);
    if (!name || !Number.isInteger(prefixLength)) continue;
    const entry = byName.get(name) || { name, addresses: [] };
    entry.addresses.push({
      family: matched[2] === "inet" ? "ipv4" : "ipv6",
      address: matched[3],
      prefixLength,
      scope: matched[5],
    });
    byName.set(name, entry);
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/** Read a comma-delimited text item from Android's `WifiInfo` row. */
function wifiText(row: string, label: string): string | null {
  const matched = new RegExp(
    `(?:^|,)\\s*${escapeRegExp(label)}:\\s*("[^"]*"|[^,]*)`,
  ).exec(row);
  return nullableText(matched?.[1]?.replace(/^"|"$/g, ""));
}

/** Read a comma-delimited integer item from Android's `WifiInfo` row. */
function wifiInteger(row: string, label: string): number | null {
  return nullableInteger(
    new RegExp(`(?:^|,)\\s*${escapeRegExp(label)}:\\s*(-?\\d+)`).exec(
      row,
    )?.[1],
  );
}

/** Parse the stable subset of `cmd wifi status` used by the operations UI. */
export function parseWifiStatus(output: string): AndroidWifiSnapshot {
  const rawRow = output
    .split(/\r?\n/)
    .find((line) => line.includes("WifiInfo:"));
  const row = rawRow?.slice(
    rawRow.indexOf("WifiInfo:") + "WifiInfo:".length,
  );
  const enabled = /\bWi-?Fi is enabled\b/i.test(output);
  const connected = /\bWi-?Fi is connected to\b/i.test(output) || Boolean(row);
  if (!row) {
    return {
      enabled,
      connected: false,
      ssid: null,
      bssid: null,
      ipv4Address: null,
      rssiDbm: null,
      linkSpeedMbps: null,
      txLinkSpeedMbps: null,
      rxLinkSpeedMbps: null,
      frequencyMhz: null,
      standard: null,
    };
  }
  return {
    enabled,
    connected,
    ssid: wifiText(row, "SSID"),
    bssid: wifiText(row, "BSSID"),
    ipv4Address: wifiText(row, "IP")?.replace(/^\//, "") || null,
    rssiDbm: wifiInteger(row, "RSSI"),
    linkSpeedMbps: wifiInteger(row, "Link speed"),
    txLinkSpeedMbps: wifiInteger(row, "Tx Link speed"),
    rxLinkSpeedMbps: wifiInteger(row, "Rx Link speed"),
    frequencyMhz: wifiInteger(row, "Frequency"),
    standard: wifiText(row, "Wi-Fi standard"),
  };
}

/** Parse active subscription rows while dropping SIM and device identifiers. */
export function parseAndroidSubscriptions(output: string): AndroidSubscription[] {
  const bySlot = new Map<number, AndroidSubscription>();
  for (const row of output.split(/\r?\n/)) {
    if (!/(?:^|[\s{])id=-?\d+/.test(row)) continue;
    const slotIndex = nullableInteger(
      subscriptionField(row, "simSlotIndex") || undefined,
    );
    const subscriptionId = nullableInteger(
      subscriptionField(row, "id") || undefined,
    );
    if (
      slotIndex === null ||
      slotIndex < 0 ||
      slotIndex >= MAX_TELEPHONY_SLOTS ||
      subscriptionId === null ||
      subscriptionId < 0 ||
      bySlot.has(slotIndex)
    ) {
      continue;
    }
    const roamingValue = subscriptionField(row, "dataRoaming");
    const embeddedValue = subscriptionField(row, "isEmbedded");
    const reportedNumber =
      subscriptionField(row, "number") ||
      subscriptionField(row, "numberFromCarrier") ||
      subscriptionField(row, "numberFromIms");
    bySlot.set(slotIndex, {
      subscriptionId,
      slotIndex,
      displayName: sanitizedLabel(
        subscriptionField(row, "displayName") || undefined,
      ),
      carrierName: sanitizedLabel(
        subscriptionField(row, "carrierName") || undefined,
      ),
      countryIso: countryIso(subscriptionField(row, "countryIso")),
      mcc: carrierCode(subscriptionField(row, "mcc"), 3, 3),
      mnc: carrierCode(subscriptionField(row, "mnc"), 2, 3),
      embedded:
        embeddedValue === null
          ? null
          : embeddedValue === "true" || embeddedValue === "1",
      roaming:
        roamingValue === null
          ? null
          : roamingValue === "1" || roamingValue === "true",
      phoneNumber: maskedPhoneNumber(reportedNumber),
    });
    if (bySlot.size >= MAX_TELEPHONY_SLOTS) break;
  }
  return [...bySlot.values()].sort(
    (left, right) => left.slotIndex - right.slotIndex,
  );
}

/** Parse per-slot service and signal data from `dumpsys telephony.registry`. */
export function parseTelephonyRegistry(
  output: string,
): AndroidTelephonyRegistrySlot[] {
  const headers = [...output.matchAll(/^\s*Phone Id=(\d+)\s*$/gm)];
  const slots: AndroidTelephonyRegistrySlot[] = [];
  for (
    let index = 0;
    index < Math.min(headers.length, MAX_TELEPHONY_SLOTS);
    index += 1
  ) {
    const header = headers[index];
    const slotIndex = Number(header[1]);
    const start = (header.index || 0) + header[0].length;
    const end = headers[index + 1]?.index ?? output.length;
    const section = output.slice(start, end);
    if (
      !Number.isSafeInteger(slotIndex) ||
      slotIndex < 0 ||
      slotIndex >= MAX_TELEPHONY_SLOTS
    ) {
      continue;
    }
    const service = /mServiceState=\{([^\n]*)/m.exec(section)?.[1] || "";
    const signal = /mSignalStrength=([^\n]*)/m.exec(section)?.[1] || "";
    const lteSection = /mLte=CellSignalStrengthLte:\s*(.*?)(?=,mNr=)/.exec(
      signal,
    )?.[1];
    const nrSection = /mNr=CellSignalStrengthNr:\{(.*?)\},primary=/.exec(
      signal,
    )?.[1];
    const voice = /mVoiceRegState=-?\d+(?:\(([^)]+)\))?/.exec(service)?.[1];
    const data = /mDataRegState=-?\d+(?:\(([^)]+)\))?/.exec(service)?.[1];
    slots.push({
      slotIndex,
      operatorLongName: sanitizedLabel(
        /mOperatorAlphaLong=([^,}]*)/.exec(service)?.[1],
      ),
      operatorShortName: sanitizedLabel(
        /mOperatorAlphaShort=([^,}]*)/.exec(service)?.[1],
      ),
      voiceRegistrationState: nullableText(voice),
      dataRegistrationState: nullableText(data),
      voiceRadioTechnology: nullableText(
        /getRilVoiceRadioTechnology=-?\d+(?:\(([^)]+)\))?/.exec(service)?.[1],
      ),
      dataRadioTechnology: nullableText(
        /getRilDataRadioTechnology=-?\d+(?:\(([^)]+)\))?/.exec(service)?.[1],
      ),
      emergencyOnly: /mIsEmergencyOnly=(true|false)/.test(service)
        ? /mIsEmergencyOnly=(true|false)/.exec(service)?.[1] === "true"
        : null,
      roaming: /mIsDataRoamingFromRegistration=(true|false)/.test(service)
        ? /mIsDataRoamingFromRegistration=(true|false)/.exec(service)?.[1] ===
          "true"
        : null,
      dataConnectionState: dataConnectionState(
        /^\s*mDataConnectionState=(-?\d+)\s*$/m.exec(section)?.[1],
      ),
      primarySignalTechnology: nullableText(
        /primary=CellSignalStrength([A-Za-z0-9]+)/.exec(signal)?.[1],
      )?.toUpperCase() || null,
      lte: parseLteSignal(lteSection),
      nr: parseNrSignal(nrSection),
    });
  }
  return slots.sort((left, right) => left.slotIndex - right.slotIndex);
}

/** Combine registry, subscription and SIM-property data into one safe snapshot. */
export function buildTelephonySnapshot(
  registryOutput: string,
  subscriptionOutput: string,
  simStateOutput: string,
): AndroidTelephonySnapshot {
  const registry = new Map(
    parseTelephonyRegistry(registryOutput).map((value) => [
      value.slotIndex,
      value,
    ]),
  );
  const subscriptions = new Map(
    parseAndroidSubscriptions(subscriptionOutput).map((value) => [
      value.slotIndex,
      value,
    ]),
  );
  const simStates = simStateOutput.trim()
    ? simStateOutput
        .split(",")
        .slice(0, MAX_TELEPHONY_SLOTS)
        .map((value) => nullableText(value))
    : [];
  const slotIndexes = new Set<number>([
    ...registry.keys(),
    ...subscriptions.keys(),
    ...simStates.map((_, index) => index),
  ]);
  return {
    available:
      Boolean(registryOutput.trim()) ||
      Boolean(subscriptionOutput.trim()) ||
      Boolean(simStateOutput.trim()),
    subscriptions: [...slotIndexes]
      .sort((left, right) => left - right)
      .map((slotIndex) => {
        const dynamic = registry.get(slotIndex);
        const subscription = subscriptions.get(slotIndex);
        return {
          subscriptionId: subscription?.subscriptionId ?? null,
          slotIndex,
          simState: simStates[slotIndex] || null,
          displayName: subscription?.displayName || null,
          carrierName:
            subscription?.carrierName || dynamic?.operatorLongName || null,
          countryIso: subscription?.countryIso || null,
          mcc: subscription?.mcc || null,
          mnc: subscription?.mnc || null,
          embedded: subscription?.embedded ?? null,
          roaming: dynamic?.roaming ?? subscription?.roaming ?? null,
          phoneNumber: subscription?.phoneNumber || maskedPhoneNumber(null),
          voice: {
            registrationState: dynamic?.voiceRegistrationState || null,
            radioTechnology: dynamic?.voiceRadioTechnology || null,
          },
          data: {
            registrationState: dynamic?.dataRegistrationState || null,
            radioTechnology: dynamic?.dataRadioTechnology || null,
            connectionState: dynamic?.dataConnectionState || null,
          },
          emergencyOnly: dynamic?.emergencyOnly ?? null,
          signal: {
            primaryTechnology: dynamic?.primarySignalTechnology || null,
            lte: dynamic?.lte || null,
            nr: dynamic?.nr || null,
          },
        };
      }),
    sensitiveIdentifiersIncluded: false,
  };
}
