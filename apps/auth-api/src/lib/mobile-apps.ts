import type { MobilePlatformLogoVariant } from "@openbot/brand";
import type { PlatformNavigator } from "./download-platforms";
import { OPENBOT_DOWNLOAD_PAGE_LINKS } from "./landing-links";

export type MobilePlatform = MobilePlatformLogoVariant;

export interface MobileAppDetails {
  action: string;
  description: string;
  href: string;
  id: MobilePlatform;
  label: string;
  status: "Available";
}

/**
 * The web app on the landing cards. A phone installs it from its browser, so each card opens the page
 * with the steps of that phone. The site offers no phone app from a store.
 */
export const MOBILE_APPS: Record<MobilePlatform, MobileAppDetails> = {
  ios: {
    id: "ios",
    label: "iPhone",
    status: "Available",
    description: "Web app · Safari, then Add to Home Screen",
    action: "Install the web app",
    href: OPENBOT_DOWNLOAD_PAGE_LINKS.ios,
  },
  android: {
    id: "android",
    label: "Android",
    status: "Available",
    description: "Web app · Chrome, then Install app",
    action: "Install the web app",
    href: OPENBOT_DOWNLOAD_PAGE_LINKS.android,
  },
};

export const MOBILE_APP_ORDER: readonly MobilePlatform[] = ["ios", "android"];

/**
 * The phone app for a visitor on a phone. Android reports Linux and an iPhone reports "like Mac OS X",
 * so check this before the desktop detection. An iPad in desktop mode reports a Mac and stays one.
 */
export function detectMobilePlatform(source: PlatformNavigator): MobilePlatform | undefined {
  const platform =
    `${source.userAgentData?.platform ?? ""} ${source.platform ?? ""} ${source.userAgent ?? ""}`.toLowerCase();

  if (/iphone|ipad|ipod/.test(platform)) return "ios";
  if (/android/.test(platform)) return "android";
  return undefined;
}
