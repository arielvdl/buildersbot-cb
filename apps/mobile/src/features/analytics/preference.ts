import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { mobileAnalytics } from "./mobile-analytics";

/*
 * The app sends no product analytics and no error reports (phase 0 of
 * `.openbot-build/bug-reports/DESIGN.md`). Settings shows a note, not a switch, and the app does not
 * send an answer to the account. The keychain keeps what earlier versions saved, so the format stays
 * readable for a later service: `openbot.mobile.analytics.v1` ("true" or "false"),
 * `openbot.mobile.analytics.account-pending.v1` (JSON `{ enabled, at }`) and
 * `openbot.mobile.analytics.keep-off.v1` ("true" or "false"). No value starts a send.
 */
const key = "openbot.mobile.analytics.v1";
export const useAnalyticsPreference = create<{ enabled: boolean; ready: boolean; saving: boolean }>(() => ({
  enabled: false,
  ready: false,
  saving: false,
}));
let loading: Promise<void> | null = null;

export function loadAnalyticsPreference(): Promise<void> {
  loading ??= SecureStore.getItemAsync(key)
    .then((stored) => {
      const enabled = stored === null || stored === "true";
      mobileAnalytics.setEnabled(enabled);
      useAnalyticsPreference.setState({ enabled, ready: true });
    })
    .catch(() => {
      // An unreadable preference must not turn tracking on.
      mobileAnalytics.setEnabled(false);
      useAnalyticsPreference.setState({ enabled: false, ready: true });
    });
  return loading;
}
