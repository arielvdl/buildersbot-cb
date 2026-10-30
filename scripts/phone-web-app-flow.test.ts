// The phone flow offers only the installable web client at `/app`. This test fails when a phone app
// store, its address or its name is reachable from the Add phone flow, from the sidebar card that
// opens it, or from the address that its QR code shows.

import { resolve } from "node:path";
import { createMobileWebAppUrl, mobileWebAppAddress, parseMobileWebAppUrl } from "@openbot/contracts/mobile-connect";
import { type Message, TRANSLATED_LOCALES } from "@openbot/i18n";
import { MOBILE_WEB_APP_PLATFORMS } from "@openbot/ui/features/mobile-app/mobile-web-app";
import { describe, expect, it } from "vitest";

const STORE_TEXT =
  /app\s?store|google\s?play|play\s?store|testflight|apps\.apple\.com|play\.google\.com|\.apk\b|baixe o app|get the app/iu;

/** The catalog areas of the flow, and the key prefixes of the flow in each area. */
const FLOW_AREAS = {
  settings: "settings.mobileConnect.",
  sidebar: "sidebar.mobileApp.",
} as const;

function messageTexts(message: Message): string[] {
  return typeof message === "string" ? [message] : Object.values(message).filter((text) => typeof text === "string");
}

/** The text of every flow key in `locale`, as `key: text` lines. */
async function flowTexts(locale: string): Promise<string[]> {
  const lines: string[] = [];
  for (const [area, prefix] of Object.entries(FLOW_AREAS)) {
    const module: { messages: Readonly<Record<string, Message>> } = await import(
      resolve(import.meta.dirname, `../packages/i18n/src/messages/${locale}/${area}.ts`)
    );
    for (const [key, message] of Object.entries(module.messages)) {
      if (key.startsWith(prefix)) lines.push(...messageTexts(message).map((text) => `${key}: ${text}`));
    }
  }
  return lines;
}

async function flowText(locale: string, key: string): Promise<string> {
  const line = (await flowTexts(locale)).find((entry) => entry.startsWith(`${key}: `));
  return line?.slice(key.length + 2) ?? "";
}

describe("phone web app flow", () => {
  it.each(TRANSLATED_LOCALES)("names no app store in the %s catalog", async (locale) => {
    expect((await flowTexts(locale)).filter((line) => STORE_TEXT.test(line))).toEqual([]);
  });

  it("gives iPhone and Android their own install steps in English and Portuguese", async () => {
    expect(MOBILE_WEB_APP_PLATFORMS.map((phone) => phone.platform)).toEqual(["ios", "android"]);
    const [ios, android] = MOBILE_WEB_APP_PLATFORMS;
    const english = await Promise.all(
      [...(ios?.steps ?? []), ...(android?.steps ?? [])].map((key) => flowText("en", key)),
    );
    expect(english.join(" ")).toMatch(/Safari.*Add to Home Screen/u);
    expect(english.join(" ")).toMatch(/Chrome.*Install app/u);
    const portuguese = await Promise.all(
      [...(ios?.steps ?? []), ...(android?.steps ?? [])].map((key) => flowText("pt", key)),
    );
    expect(portuguese.join(" ")).toMatch(/Safari.*Adicionar à Tela de Início/u);
    expect(portuguese.join(" ")).toMatch(/Chrome.*Instalar app/u);
    for (const text of [...english, ...portuguese]) expect(text).not.toMatch(STORE_TEXT);
  });

  it("builds the web client address on the origin of the sign-in code", () => {
    expect(createMobileWebAppUrl("https://buildersbot.culturabuilder.com")).toBe(
      "https://buildersbot.culturabuilder.com/app",
    );
    // The development phone reaches the account service of the computer on the local network.
    expect(createMobileWebAppUrl("http://192.168.1.20:3100")).toBe("http://192.168.1.20:3100/app");
    for (const origin of ["http://example.com", "https://example.com/path", "javascript:alert(1)", "openbot://x"]) {
      expect(() => createMobileWebAppUrl(origin)).toThrow();
    }
    expect(mobileWebAppAddress("https://buildersbot.culturabuilder.com/app")).toBe(
      "buildersbot.culturabuilder.com/app",
    );
  });

  it("accepts only the web client address for the QR code", () => {
    expect(parseMobileWebAppUrl("https://buildersbot.culturabuilder.com/app")).toBe(
      "https://buildersbot.culturabuilder.com/app",
    );
    for (const value of [
      "https://apps.apple.com/us/app/openbot-run/id6807024266",
      "https://play.google.com/store/apps/details?id=run.openbot.mobile",
      "openbot://mobile-connect?api=https%3A%2F%2Fapi.openbot.run&ticket=x",
      "http://example.com/app",
      "https://person:secret@example.com/app",
      "https://example.com/app?ticket=x",
      "https://example.com/app#x",
      "https://example.com/",
    ]) {
      expect(parseMobileWebAppUrl(value)).toBeNull();
    }
  });
});
