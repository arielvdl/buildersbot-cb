import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

/**
 * Notifications of the installed app while it is closed.
 *
 * The browser hands the worker a subscription with its own key pair; the account service stores it
 * against this installation's session and pushes a short message through the push service of the
 * browser when the host reports an event. The worker shows it. Only the subscription and a fixed text
 * travel; the conversation stays on the host.
 *
 * iOS only delivers to an installed app, and only after the person answered the permission prompt from
 * a gesture, so every entry point here is a click.
 */

const PUSH_KEY = "openbot.web.push";
const REQUEST_TIMEOUT_MS = 15_000;

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
  );
}

/** Whether this installation asked for notifications before. The subscription is checked separately. */
export function pushAsked(): boolean {
  try {
    return window.localStorage.getItem(PUSH_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(PUSH_KEY, "1");
    else window.localStorage.removeItem(PUSH_KEY);
  } catch {
    // Without storage the switch reads as off on the next start; the subscription is still there.
  }
}

/** The `applicationServerKey` is base64url; `subscribe` wants the bytes. */
function applicationServerKey(value: string): BufferSource {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function config(fetchImpl: typeof fetch): Promise<string | null> {
  const response = await fetchImpl("/api/browser/v1/push", {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return null;
  const value = await response.json().catch(() => null);
  return isDynamicRecord(value) && isString(value.publicKey) ? value.publicKey : null;
}

/** Whether the worker already holds a subscription that this account service signed. */
export async function pushSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const ready = await navigator.serviceWorker.ready.catch(() => null);
  const subscription = await ready?.pushManager.getSubscription().catch(() => null);
  return Boolean(subscription);
}

export type PushOutcome = "on" | "denied" | "unavailable";

/**
 * Asks the browser and the account service. Must run from a click: iOS ignores a permission prompt
 * that no gesture started.
 */
export async function enablePush(fetchImpl: typeof fetch = fetch): Promise<PushOutcome> {
  if (!pushSupported()) return "unavailable";
  const permission = await Notification.requestPermission().catch(() => "denied" as const);
  if (permission !== "granted") return "denied";
  const key = await config(fetchImpl);
  if (!key) return "unavailable";
  const ready = await navigator.serviceWorker.ready.catch(() => null);
  if (!ready) return "unavailable";
  const subscription =
    (await ready.pushManager.getSubscription().catch(() => null)) ??
    (await ready.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key) })
      .catch(() => null));
  if (!subscription) return "unavailable";
  const response = await fetchImpl("/api/browser/v1/push/subscription", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-OpenBot-Browser": "1" },
    body: JSON.stringify(subscription.toJSON()),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return "unavailable";
  remember(true);
  return "on";
}

/** Forgets the subscription here and at the account service. A failure still drops it locally. */
export async function disablePush(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!pushSupported()) return;
  const ready = await navigator.serviceWorker.ready.catch(() => null);
  const subscription = await ready?.pushManager.getSubscription().catch(() => null);
  remember(false);
  if (!subscription) return;
  await fetchImpl("/api/browser/v1/push/subscription", {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-OpenBot-Browser": "1" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}
