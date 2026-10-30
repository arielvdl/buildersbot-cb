import { describe, expect, it } from "vitest";
import { DOWNLOAD_HUB, DOWNLOAD_PAGES } from "../src/lib/download-pages";
import { MOBILE_APP_ORDER, MOBILE_APPS } from "../src/lib/mobile-apps";

// The website offers a phone the installable web client at `/app`, never a phone app store. The
// iPhone and Android pages keep their addresses, which search engines and old posts link to.

const STORE_TEXT =
  /app\s?store|google\s?play|play\s?store|testflight|apps\.apple\.com|play\.google\.com|\.apk\b|get the app/iu;

describe("phone pages of the website", () => {
  it.each(MOBILE_APP_ORDER)("offers the web app for %s and names no store", (platform) => {
    const card = MOBILE_APPS[platform];
    const page = DOWNLOAD_PAGES[platform];
    expect(card.href.startsWith("/")).toBe(true);
    expect(page.installers.map((installer) => installer.href)).toEqual(["/app"]);
    expect(page.installers.some((installer) => installer.external)).toBe(false);
    expect(JSON.stringify(card)).not.toMatch(STORE_TEXT);
    expect(JSON.stringify(page)).not.toMatch(STORE_TEXT);
  });

  it("gives each phone the install steps of its browser", () => {
    const steps = (platform: "ios" | "android") =>
      DOWNLOAD_PAGES[platform].installSteps.map((step) => step.text).join(" ");
    expect(steps("ios")).toMatch(/Safari.*Add to Home Screen/u);
    expect(steps("android")).toMatch(/Chrome.*Install app/u);
  });

  it("names no store on the download hub", () => {
    expect(JSON.stringify(DOWNLOAD_HUB)).not.toMatch(STORE_TEXT);
    expect(JSON.stringify(DOWNLOAD_PAGES.linux)).not.toMatch(/mobile app/iu);
  });
});
