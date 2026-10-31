import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { APP_PROFILE_LIMITS, type AppProfile, decodeAppProfile } from "@openbot/contracts/app-profile";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { MarketplaceAppCuration } from "@openbot/ui/features/marketplace/marketplace-curation";
import { createSignal } from "solid-js";

/**
 * What the Apps tab of the Marketplace keeps on this computer: the "Show all apps" choice, and the
 * last good app profile of the signed-in organization, for a start with no network.
 *
 * Reading `window.localStorage` throws when the browser blocks storage, so each read and write is
 * inside a guard. Blocked storage keeps the values for this page only.
 */

const SHOW_ALL_STORAGE_KEY = "openbot:marketplace-show-all-apps";
const PROFILE_STORAGE_KEY = "openbot:marketplace-app-profile";
/** The longest account key that the caller can give, in UTF-16 code units. */
const ACCOUNT_KEY_LIMIT = 256;
/** The cache keeps the SHA-256 hash of the account key, as 64 hex digits, and never the key. */
const ACCOUNT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
/**
 * The JSON text of the cache entry: a profile, which `decodeAppProfile` keeps within
 * `APP_PROFILE_LIMITS.text`, and the 89 code units of the wrapper with the hash.
 */
const CACHE_TEXT_LIMIT = APP_PROFILE_LIMITS.text + 128;

/** The choice for this page after the browser did not save it. It wins over an older saved value. */
let unsavedShowAll: boolean | undefined;

function readShowAll(): boolean {
  if (unsavedShowAll !== undefined) return unsavedShowAll;
  try {
    return window.localStorage.getItem(SHOW_ALL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeShowAll(show: boolean): void {
  try {
    window.localStorage.setItem(SHOW_ALL_STORAGE_KEY, String(show));
    unsavedShowAll = undefined;
  } catch {
    unsavedShowAll = show;
  }
}

/** The profile and the hash of the account it belongs to. */
interface CachedProfile {
  account: string;
  profile: AppProfile;
}

/**
 * The hash of an account key, or null when the key is not text, is empty, or is too long. Only the
 * hash goes to storage, so the key can be a name or an e-mail address without a copy on disk.
 */
function accountHash(account: unknown): string | null {
  if (typeof account !== "string" || account.length > ACCOUNT_KEY_LIMIT || account.trim() === "") return null;
  return bytesToHex(sha256(utf8ToBytes(`openbot:marketplace-app-profile:${account}`)));
}

/**
 * The cached profile, decoded again: local storage is not a trusted source, and an older or newer
 * app version can have written it.
 */
function readCachedProfile(): CachedProfile | null {
  try {
    const text = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!text || text.length > CACHE_TEXT_LIMIT) return null;
    const value = JSON.parse(text);
    if (!isDynamicRecord(value) || typeof value.account !== "string" || !ACCOUNT_HASH_PATTERN.test(value.account)) {
      return null;
    }
    const profile = decodeAppProfile(value.profile);
    return profile ? { account: value.account, profile } : null;
  } catch {
    return null;
  }
}

function writeCachedProfile(entry: CachedProfile | null): void {
  try {
    if (entry) window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(entry));
    else window.localStorage.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    // Blocked or full storage keeps the profile for this page only.
  }
}

const [showAll, setShowAllSignal] = createSignal(readShowAll());
/**
 * The cache entry as this page last wrote or read it. `receiveAppProfile` reads this value, not the
 * signal: Solid can give the older signal value until it flushes a write.
 */
let keptEntry = readCachedProfile();
const [cachedProfile, setCachedProfile] = createSignal<CachedProfile | null>(keptEntry);
/**
 * The hash of the account that the last answer to this page named. Null until the first answer, so
 * the cached profile waits until an answer names its account.
 */
const [answeredAccount, setAnsweredAccount] = createSignal<string | null>(null);

function readStorageIntoSignals(event: StorageEvent): void {
  if (event.key === null || event.key === SHOW_ALL_STORAGE_KEY) setShowAllSignal(readShowAll());
  if (event.key === null || event.key === PROFILE_STORAGE_KEY) {
    keptEntry = readCachedProfile();
    setCachedProfile(keptEntry);
  }
}

if (typeof window !== "undefined") {
  // One registration per page: addEventListener ignores the same listener twice, and HMR disposal
  // removes it when this module is replaced.
  window.addEventListener("storage", readStorageIntoSignals);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("storage", readStorageIntoSignals);
  });
}

function setProfile(entry: CachedProfile | null): void {
  keptEntry = entry;
  writeCachedProfile(entry);
  setCachedProfile(entry);
}

/** What the Hub said about the app profile of the signed-in Cultura Builder account. */
export type AppProfileAnswer =
  /**
   * The Hub answered for `account`. `value` is its `appProfile` field as it came, not decoded.
   * Absent, null or malformed: the account has no valid profile, and the default list applies.
   */
  | { readonly kind: "answer"; readonly account: string; readonly value: unknown }
  /** No answer for `account`: no network, a server error, or a body over the limit. */
  | { readonly kind: "unreachable"; readonly account: string }
  /** No Cultura Builder account is signed in. */
  | { readonly kind: "signed-out" };

/**
 * ADAPTER POINT. The one way in for an organization's app profile. Nothing calls it yet: the Hub
 * does not send `appProfile` today. Main reads the Hub's `/session`, so the profile comes to this
 * page through an IPC event, which the preload decodes. Each page calls this after each read,
 * sign-in and sign-out (see docs/architecture/marketplace-apps-curation.md).
 *
 * `account` is a stable key of the signed-in account, 1 to 256 UTF-16 code units, such as the Hub
 * user id. Storage keeps only its SHA-256 hash. The cached profile applies only after an answer to
 * this page names the account that the cache holds, so it never applies to another account. An
 * unreachable Hub keeps the cached profile of the same account; any other answer replaces it.
 */
export function receiveAppProfile(answer: AppProfileAnswer): void {
  const account = answer.kind === "signed-out" ? null : accountHash(answer.account);
  setAnsweredAccount(account);
  if (answer.kind === "signed-out" || account === null) {
    setProfile(null);
    return;
  }
  if (answer.kind === "unreachable") {
    if (keptEntry?.account !== account) setProfile(null);
    return;
  }
  const profile = decodeAppProfile(answer.value);
  setProfile(profile ? { account, profile } : null);
}

/** The curation of the Apps tab, shared by every Marketplace of this page. */
export const marketplaceAppCuration: MarketplaceAppCuration = {
  profile: () => {
    const entry = cachedProfile();
    return entry && entry.account === answeredAccount() ? entry.profile : null;
  },
  showAll,
  setShowAll: (show) => {
    writeShowAll(show);
    setShowAllSignal(show);
  },
};
