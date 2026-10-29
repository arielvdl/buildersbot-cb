import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { createSignal, onCleanup } from "solid-js";

/**
 * The lock of the installed app, through the passkey the device already has: Face ID, Touch ID, the
 * fingerprint reader or the screen lock of the phone. The account session stays where it is; the lock
 * only stands in front of it, as the app lock of the phone app does, so someone who picks up an
 * unlocked phone cannot read the agents of the account.
 *
 * The credential is made for this origin and this installation, and the id stays on the device. A
 * verification the platform answers is the only way back in; there is no code to type and nothing to
 * guess. The lock is a guard of the screen, not of the transport: a request that is already in flight
 * still reaches the host.
 */

const LOCK_KEY = "openbot.web.app-lock";
/** After this long with the app hidden, the next look at it asks for the passkey again. */
const LOCK_AFTER_HIDDEN_MS = 60_000;
const TIMEOUT_MS = 60_000;

interface StoredLock {
  credentialId: string;
  createdAt: number;
}

function encode(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decode(value: string): BufferSource {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function readStored(): StoredLock | null {
  try {
    const raw = window.localStorage.getItem(LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isDynamicRecord(parsed)) return null;
    const { credentialId, createdAt } = parsed;
    if (!isString(credentialId) || !credentialId) return null;
    if (!isNumber(createdAt) || !Number.isFinite(createdAt)) return null;
    return { credentialId, createdAt };
  } catch {
    return null;
  }
}

function writeStored(lock: StoredLock | null): void {
  try {
    if (lock) window.localStorage.setItem(LOCK_KEY, JSON.stringify(lock));
    else window.localStorage.removeItem(LOCK_KEY);
  } catch {
    // Without storage the lock still holds for this load.
  }
}

/** Whether the device has a platform authenticator that can check the person. */
export async function appLockSupported(): Promise<boolean> {
  if (typeof window === "undefined" || !window.PublicKeyCredential || !navigator.credentials) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function appLockEnabled(): boolean {
  return readStored() !== null;
}

export type AppLockResult = "unlocked" | "cancelled" | "lost";

/** Asks for the passkey of this installation. `lost` means the device no longer has the credential. */
async function verify(credentialId: string): Promise<AppLockResult> {
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: window.location.hostname,
        timeout: TIMEOUT_MS,
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id: decode(credentialId), transports: ["internal"] }],
      },
    });
    return assertion ? "unlocked" : "cancelled";
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    // The device forgot the credential: it was removed in the passkey list of the system.
    return name === "NotAllowedError" ? "lost" : "cancelled";
  }
}

/** Makes the passkey of this installation. Throws when the device refuses one. */
export async function createAppLock(label: string): Promise<void> {
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: window.location.hostname, name: "OpenBot" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred",
      },
      timeout: TIMEOUT_MS,
      attestation: "none",
    },
  });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("no_credential");
  writeStored({ credentialId: encode(new Uint8Array(credential.rawId)), createdAt: Date.now() });
}

export function disableAppLock(): void {
  writeStored(null);
}

export interface WebAppLock {
  /** Whether the screen is covered right now. */
  locked: () => boolean;
  /** Whether a lock is set at all. */
  enabled: () => boolean;
  /** Sets the lock, or throws when the device refuses a passkey. */
  enable: (label: string) => Promise<void>;
  disable: () => void;
  /** Asks for the passkey and uncovers the screen. */
  unlock: () => Promise<AppLockResult>;
  /** Covers the screen now, for example from the menu. */
  lock: () => void;
}

/** The lock of the running app. The app starts covered whenever a lock is set, and covers itself again
 * after a while hidden: a reload, a task switch or a locked phone all pass through the same place.
 */
export function createWebAppLock(): WebAppLock {
  const [enabled, setEnabled] = createSignal(appLockEnabled());
  const [locked, setLocked] = createSignal(enabled());
  let hiddenSince: number | null = null;

  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      hiddenSince = Date.now();
      return;
    }
    const since = hiddenSince;
    hiddenSince = null;
    if (since !== null && Date.now() - since >= LOCK_AFTER_HIDDEN_MS && enabled()) setLocked(true);
  };
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));

  return {
    locked,
    enabled,
    lock: () => {
      if (enabled()) setLocked(true);
    },
    async enable(label) {
      await createAppLock(label);
      setEnabled(true);
      setLocked(false);
    },
    disable() {
      disableAppLock();
      setEnabled(false);
      setLocked(false);
    },
    async unlock() {
      const stored = readStored();
      if (!stored) {
        setEnabled(false);
        setLocked(false);
        return "lost";
      }
      const result = await verify(stored.credentialId);
      if (result === "unlocked") setLocked(false);
      if (result === "lost") {
        setEnabled(false);
        setLocked(false);
      }
      return result;
    },
  };
}

/**
 * The lock of this page, for the settings row that changes it. The app shell makes it and hands it
 * over, so the row and the cover share one state; before the shell has, the row stays hidden.
 */
let current: WebAppLock | null = null;

export function provideWebAppLock(lock: WebAppLock | null): void {
  current = lock;
}

export function webAppLock(): WebAppLock | null {
  return current;
}
