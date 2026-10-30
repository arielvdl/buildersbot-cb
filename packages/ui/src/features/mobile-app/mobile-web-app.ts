import type { AppTextKey } from "@openbot/i18n";

/**
 * How a phone installs the web client: from its browser, to the Home Screen. Builders Bot offers no
 * phone app from a store. Each phone shows the steps of its own browser.
 *
 * The phone is the value of a `PlatformLogo`. It is written here, not imported from the brand
 * package, so that a Node test can read this list without the JSX of the logos.
 */
export interface MobileWebAppPlatform {
  platform: "ios" | "android";
  /** A product name, the same in every language. */
  label: string;
  steps: readonly AppTextKey[];
}

export const MOBILE_WEB_APP_PLATFORMS: readonly MobileWebAppPlatform[] = [
  {
    platform: "ios",
    label: "iPhone",
    steps: ["settings.mobileConnect.webApp.ios.open", "settings.mobileConnect.webApp.ios.add"],
  },
  {
    platform: "android",
    label: "Android",
    steps: ["settings.mobileConnect.webApp.android.open", "settings.mobileConnect.webApp.android.add"],
  },
];
