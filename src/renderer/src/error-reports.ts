import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isNumber } from "@openbot/contracts/runtime-values";
import { analyticsOnByDefault, type FailureProperties } from "@openbot/telemetry";

/*
 * Failure reports of the desktop app and of the web client. They are off in every build.
 *
 * The upstream OpenBot app sent them, with the account ID, to an analytics service of the upstream
 * project. Builders Bot does not control that service, so phase 0 of
 * `.openbot-build/bug-reports/DESIGN.md` removed the queue and its transport. Builders Bot has no
 * diagnostics service of its own yet. `reportNotification` and `reportErrorBanner` keep their
 * signatures and do nothing. The web preference below stays readable, so a saved answer is kept for
 * a later service, but no value starts a send.
 */

/** The web analytics preference. The key keeps its first name, so stored choices stay. */
export const WEB_PREFERENCE = "openbot:web:error-reports-enabled";
/** A choice of this browser that the account has not saved yet, "true" or "false". */
const WEB_ACCOUNT_PENDING = "openbot:web:analytics-account-pending";
/** "true" or "false". Missing: an app from before the account kept answers saved the choice. */
const WEB_KEEP_OFF = "openbot:web:analytics-keep-off";

/** True while this browser has a signed-in account. `configureWebReports` sets it. */
let webSignedIn = false;
/** The choice of this page, for a browser that cannot save it. */
let webChoice: boolean | null = null;

/**
 * The web choice for failure reports and product analytics. With no saved choice, a signed-in
 * account keeps the earlier default, on: it signed in before the sign-in screen asked. A signed-out
 * browser uses the default of its region until the sign-in screen saves a choice.
 */
export function webReportsEnabled(): boolean {
  try {
    const stored = localStorage.getItem(WEB_PREFERENCE);
    if (stored !== null) return stored === "true";
  } catch {
    return false;
  }
  return webChoice ?? (webSignedIn || webAnalyticsDefault());
}

/** True when this browser saved "on". The sign-in screen then keeps it and does not ask again. */
export function webReportsAgreed(): boolean {
  try {
    return localStorage.getItem(WEB_PREFERENCE) === "true";
  } catch {
    return false;
  }
}

/** On only when the region of the browser language and the time zone are in a default-on country. */
function webAnalyticsDefault(): boolean {
  try {
    const region = new Intl.Locale(navigator.language).region;
    return region !== undefined && analyticsOnByDefault(region, Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return false;
  }
}

/** Records whether this browser has a signed-in account, for the default of the web preference. */
export function configureWebReports(user: Pick<CentralAuthUser, "id" | "email"> | null): void {
  webSignedIn = user !== null;
}

/**
 * True when this browser keeps an "off" that it saved before the account kept answers. An account
 * answer of "on" does not replace it; only a choice in this browser does. Storage that cannot be
 * read keeps "off".
 */
export function webKeepsOff(): boolean {
  try {
    return localStorage.getItem(WEB_PREFERENCE) === "false" && localStorage.getItem(WEB_KEEP_OFF) !== "false";
  } catch {
    return true;
  }
}

/** Saves the web preference. Returns the saved value: false when this browser cannot save it. */
export function setWebReportsEnabled(value: boolean): boolean {
  webChoice = value;
  try {
    // A kept "off" stays kept until this browser turns analytics on. The value goes first: when the
    // mark write fails, an "off" without its mark reads as kept.
    const keepOff = !value && webKeepsOff();
    localStorage.setItem(WEB_PREFERENCE, String(value));
    localStorage.setItem(WEB_KEEP_OFF, String(keepOff));
    return value;
  } catch {
    return false;
  }
}

/** A choice of the user that the account does not have yet, and its time (ms). */
export interface WebAccountPending {
  enabled: boolean;
  at: number;
}

/** The user's choice that the account must still save, so their other devices follow it. */
export function webAccountPending(): WebAccountPending | null {
  try {
    const stored = JSON.parse(localStorage.getItem(WEB_ACCOUNT_PENDING) ?? "null");
    return isDynamicRecord(stored) && isBoolean(stored.enabled) && isNumber(stored.at)
      ? { enabled: stored.enabled, at: stored.at }
      : null;
  } catch {
    return null;
  }
}

/** Marks a choice that the account must save, or clears it after the account has it. */
export function setWebAccountPending(value: boolean | null): void {
  try {
    if (value === null) localStorage.removeItem(WEB_ACCOUNT_PENDING);
    else localStorage.setItem(WEB_ACCOUNT_PENDING, JSON.stringify({ enabled: value, at: Date.now() }));
  } catch {
    // Without storage the choice stays on this page only; the account does not get it.
  }
}

/** A toast or banner that shows a failure. No sink: nothing is kept or sent. */
export function reportNotification(_properties: FailureProperties): void {
  // No sink: see the module comment.
}

/** An error banner. No sink: nothing is kept or sent. */
export function reportErrorBanner(_error: unknown, _operation: FailureProperties["operation"] = "other"): void {
  // No sink: see the module comment.
}
