// The phone flow offers only the installable web client at `/app`. This test fails when a phone app
// store, its address or its name is reachable from the Add phone flow, from the sidebar card that
// opens it, or from the address that its QR code shows.
//
// It also fails when the sign-in of the phone can break or leak again: when the code has a header
// name with a space, which `fetch` and Node refuse before they send the request, or when a deployed
// account service returns the sign-in code in its answer instead of sending it by email.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMobileWebAppUrl, mobileWebAppAddress, parseMobileWebAppUrl } from "@openbot/contracts/mobile-connect";
import { type Message, TRANSLATED_LOCALES } from "@openbot/i18n";
import { MOBILE_WEB_APP_PLATFORMS } from "@openbot/ui/features/mobile-app/mobile-web-app";
import { describe, expect, it } from "vitest";

const STORE_TEXT =
  /app\s?store|google\s?play|play\s?store|testflight|apps\.apple\.com|play\.google\.com|\.apk\b|baixe o app|get the app/iu;

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

/**
 * A header name of the product in code: `X-` and words with a space before a dash, or a quoted
 * `OpenBot-` or `Builders Bot-` name with a capital letter after the dash. A lower case word after the
 * dash is a header value or a file name, such as `Builders Bot-runtime-installer`, so it stays out.
 */
const HEADER_NAME =
  /X-[A-Za-z0-9]+(?: [A-Za-z0-9]+)+(?:-[A-Za-z0-9]+)+|(?<=["'`])(?:OpenBot|Builders Bot)(?:-[A-Z][A-Za-z0-9]*)+/gu;

/**
 * Each product header name in the tracked code, as `path:line: name`. The catalogs hold prose, such as
 * German words that join the product name and a noun with a dash, and the lint rule fixtures hold bad
 * names on purpose.
 */
function codeHeaderNames(): string[] {
  const result = spawnSync(
    "git",
    [
      "grep",
      "-n",
      "-I",
      "-E",
      "X-[A-Za-z0-9]+ [A-Za-z0-9]+-|[\"'`](OpenBot|Builders Bot)-[A-Z]",
      "--",
      "*.ts",
      "*.tsx",
      "*.js",
      "*.mjs",
      "*.cjs",
      ":!packages/i18n",
      ":!tools/biome/anti-slop/fixtures",
      ":!.agents/skills/biome-anti-slop/assets/anti-slop/fixtures",
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  // `git grep` exits with 1 when no line matches.
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr);
  return result.stdout.split("\n").flatMap((line) => {
    const place = /^[^:]+:\d+/u.exec(line)?.[0];
    if (!place) return [];
    return [...line.slice(place.length + 1).matchAll(HEADER_NAME)].map((match) => `${place}: ${match[0]}`);
  });
}

/** Whether `fetch` and Node can send `name`: `Headers` refuses a name that is not a token. */
function sendableHeaderName(name: string): boolean {
  try {
    new Headers().append(name, "1");
    return true;
  } catch {
    return false;
  }
}

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

  it("sends only header names that fetch and Node accept", () => {
    const names = codeHeaderNames();
    // The scan must see the released names, or a broken pattern would pass with no names.
    expect(names.map((entry) => entry.slice(entry.indexOf(": ") + 2))).toContain("OpenBot-Protocol-Version");
    expect(names.filter((entry) => !sendableHeaderName(entry.slice(entry.indexOf(": ") + 2)))).toEqual([]);
  });

  it("keeps the sign-in code out of the answer of each deployed account service", () => {
    // The top level of `wrangler.jsonc` is the production Worker, and `env` holds the test and preview
    // Workers. With "true", a Worker sends no email and returns the sign-in code in its answer, so a
    // person can sign in with the email of another account. Local development turns it on in
    // `scripts/development-secrets.ts`, not here. The deploy script sends no secret with this name.
    const config = readFileSync(resolve(REPOSITORY_ROOT, "apps/auth-api/wrangler.jsonc"), "utf8");
    const environments = config.indexOf('\n  "env": {');
    const settings = [...config.matchAll(/"AUTH_EXPOSE_DEVELOPMENT_CODE":\s*"([^"]*)"/gu)].map((match) => ({
      production: environments < 0 || match.index < environments,
      value: match[1],
    }));
    expect(settings.filter((setting) => setting.production).map((setting) => setting.value)).toEqual(["false"]);
    expect(settings.map((setting) => setting.value)).toEqual(settings.map(() => "false"));
  });
});
