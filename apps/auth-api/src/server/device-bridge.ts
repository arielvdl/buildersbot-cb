// The Cultura Builder sign-in is the Hub device grant, and it lives in the bridge service that the
// Builders Bot app talks to. This Worker owns the rest of the account surface, so it proxies the two
// device steps to the bridge and mints a local session from the account the bridge confirms: the
// session token the app keeps is this Worker's, and every other route finds the account here.

const BRIDGE_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 16 * 1024;

export interface DeviceAuthorizationStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
}

export type DevicePollResult =
  | { status: "pending"; interval: number }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "rate_limited"; retryAfterSeconds: number }
  | { status: "authorized"; user: DeviceAccount };

export interface DeviceAccount {
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

/** The bridge answered something this Worker cannot use; the route turns it into a 502. */
export class DeviceBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceBridgeError";
  }
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown> | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const text = await response.text().catch(() => "");
  if (text === "" || text.length > RESPONSE_LIMIT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max ? value : fallback;
}

function boundedString(value: unknown, max = 4096): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function nullableString(value: unknown, max = 4096): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

async function post(bridgeUrl: string, path: string, body: unknown): Promise<Response> {
  try {
    return await fetch(new URL(path, bridgeUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new DeviceBridgeError(
      `The Cultura Builder sign-in service did not answer: ${error instanceof Error ? `${error.name} ${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error)}`,
    );
  }
}

export async function startDeviceAuthorization(bridgeUrl: string): Promise<DeviceAuthorizationStart> {
  const response = await post(bridgeUrl, "/v1/auth/device/start", { clientName: "Builders Bot" });
  const body = await readBoundedJson(response);
  const flowId = boundedString(body?.flowId, 128);
  const userCode = boundedString(body?.userCode, 64);
  const verificationUri = boundedString(body?.verificationUri, 2048);
  if (!response.ok || body === null || !flowId || !userCode || !verificationUri) {
    throw new DeviceBridgeError(`The sign-in service refused to start (${response.status}).`);
  }
  return {
    flowId,
    userCode,
    verificationUri,
    verificationUriComplete: boundedString(body?.verificationUriComplete, 2048),
    expiresIn: positiveInteger(body?.expiresIn, 900, 60 * 60),
    interval: positiveInteger(body?.interval, 5, 60),
  };
}

export async function pollDeviceAuthorization(bridgeUrl: string, flowId: string): Promise<DevicePollResult> {
  const response = await post(bridgeUrl, "/v1/auth/device/poll", { flowId });
  if (response.status === 202) {
    const body = await readBoundedJson(response);
    return { status: "pending", interval: positiveInteger(body?.interval, 5, 60) };
  }
  if (response.status === 403) return { status: "denied" };
  if (response.status === 410) return { status: "expired" };
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "");
    return {
      status: "rate_limited",
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 5,
    };
  }
  const body = await readBoundedJson(response);
  if (!response.ok || body === null) {
    throw new DeviceBridgeError(`The sign-in service answered ${response.status}.`);
  }
  const user = body.user;
  const record = typeof user === "object" && user !== null ? (user as Record<string, unknown>) : null;
  const email = boundedString(record?.email, 320);
  if (!email) throw new DeviceBridgeError("The sign-in service returned no account.");
  return {
    status: "authorized",
    user: {
      email,
      name: nullableString(record?.name, 200),
      avatarUrl: nullableString(record?.avatarUrl, 2048),
    },
  };
}
