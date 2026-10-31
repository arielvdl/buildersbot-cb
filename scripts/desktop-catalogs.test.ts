import { describe, expect, it } from "vitest";
import {
  appTranslation,
  formatTranslation,
  loadLocale,
  localeLoaded,
  sourceTranslation,
} from "../packages/i18n/src/desktop-catalogs";
import { catalogReplacement } from "../packages/i18n/vite-plugin";

/*
 * `electron.vite.config.ts` puts `desktop-catalogs.ts` in place of the static catalog modules in the
 * renderer. Failure modes: a window in Portuguese draws in English on its first frame (Portuguese is
 * not in the bundle); each window holds every language again (another language is in the bundle);
 * an import from outside the package gets the replacement.
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

describe("catalogReplacement", () => {
  const source = "/repo/packages/i18n/src";
  const options = { source, replacement: "desktop-catalogs.ts" } as const;

  it("replaces the four catalog modules for an import from inside the package", () => {
    for (const id of ["./app-catalogs", "./source-catalogs", "./format-catalogs", "./locale-loading"]) {
      expect(catalogReplacement(id, `${source}/index.ts`, options)).toBe(`${source}/desktop-catalogs.ts`);
    }
  });

  it("keeps every other import", () => {
    expect(catalogReplacement("./app-catalogs", "/repo/src/renderer/src/i18n-context.tsx", options)).toBeNull();
    expect(catalogReplacement("./app-catalogs", "/repo/packages/i18n/srcx/index.ts", options)).toBeNull();
    expect(catalogReplacement("./plural", `${source}/index.ts`, options)).toBeNull();
    expect(catalogReplacement("./app-catalogs", undefined, options)).toBeNull();
  });
});
