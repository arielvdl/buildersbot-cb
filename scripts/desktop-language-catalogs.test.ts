import { describe, expect, it } from "vitest";
import {
  appTranslation,
  formatTranslation,
  loadLocale,
  localeLoaded,
  sourceTranslation,
} from "../packages/i18n/src/desktop-catalogs";
import * as web from "../packages/i18n/src/lazy-catalogs";

/*
 * `electron.vite.config.ts` puts `desktop-catalogs.ts` in place of the static catalog modules in the
 * renderer. A window in English or Portuguese must show its language from the first frame, so these
 * two are in the bundle; every other language loads on first use.
 */
describe("the desktop renderer catalogs", () => {
  it("hold English and Portuguese from the start", () => {
    for (const locale of ["en", "pt"] as const) {
      expect(localeLoaded(locale)).toBe(true);
      expect(appTranslation(locale)).toBeDefined();
      expect(sourceTranslation(locale)).toBeDefined();
      expect(formatTranslation(locale)).toBeDefined();
    }
  });

  it("load another language on first use", async () => {
    expect(localeLoaded("de")).toBe(false);
    expect(appTranslation("de")).toBeUndefined();

    await loadLocale("de");

    expect(localeLoaded("de")).toBe(true);
    expect(appTranslation("de")).toBeDefined();
    expect(sourceTranslation("de")).toBeDefined();
    expect(formatTranslation("de")).toBeDefined();
  });
});

describe("the public web catalogs", () => {
  it("hold English only, and load Portuguese on first use", async () => {
    expect(web.localeLoaded("en")).toBe(true);
    expect(web.localeLoaded("pt")).toBe(false);

    await web.loadLocale("pt");

    expect(web.appTranslation("pt")).toBeDefined();
  });
});
