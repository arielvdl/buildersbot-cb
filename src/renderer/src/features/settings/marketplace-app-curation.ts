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
/** The account key is an opaque id that the caller gives. It is never shown. */
const ACCOUNT_KEY_LIMIT = 128;
const ACCOUNT_KEY_PATTERN = /^[\x21-\x7e]+$/u;

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

/** The profile and the account it belongs to. */
interface CachedProfile {
  account: string;
  profile: AppProfile;
}

function isAccountKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= ACCOUNT_KEY_LIMIT && ACCOUNT_KEY_PATTERN.test(value);
}

/**
 * The cached profile, decoded again: local storage is not a trusted source, and an older or newer
 * app version can have written it.
 */
function readCachedProfile(): CachedProfile | null {
  try {
    const text = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!text || text.length > APP_PROFILE_LIMITS.text + ACCOUNT_KEY_LIMIT * 2) return null;
    const value = JSON.parse(text);
    if (!isDynamicRecord(value) || !isAccountKey(value.account)) return null;
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
const [cachedProfile, setCachedProfile] = createSignal<CachedProfile | null>(readCachedProfile());

function readStorageIntoSignals(event: StorageEvent): void {
  if (event.key === null || event.key === SHOW_ALL_STORAGE_KEY) setShowAllSignal(readShowAll());
  if (event.key === null || event.key === PROFILE_STORAGE_KEY) setCachedProfile(readCachedProfile());
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
 * does not send `appProfile` today. The client that reads the Hub's `/session` calls it after each
 * read, sign-in and sign-out (see docs/architecture/marketplace-apps-curation.md).
 *
 * `account` is an opaque, stable key of the signed-in account, such as its Hub user id. It binds the
 * cache to that account, so a profile never applies to another account. An unreachable Hub keeps the
 * cached profile of the same account; any other answer replaces it.
 */
export function receiveAppProfile(answer: AppProfileAnswer): void {
  if (answer.kind === "signed-out" || !isAccountKey(answer.account)) {
    setProfile(null);
    return;
  }
  if (answer.kind === "unreachable") {
    if (cachedProfile()?.account !== answer.account) setProfile(null);
    return;
  }
  const profile = decodeAppProfile(answer.value);
  setProfile(profile ? { account: answer.account, profile } : null);
}

/** The curation of the Apps tab, shared by every Marketplace of this page. */
export const marketplaceAppCuration: MarketplaceAppCuration = {
  profile: () => cachedProfile()?.profile ?? null,
  showAll,
  setShowAll: (show) => {
    writeShowAll(show);
    setShowAllSignal(show);
  },
};
