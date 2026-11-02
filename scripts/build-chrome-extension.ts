// Builds the Builders Bot Chrome extension for one channel.
//
//   bun scripts/build-chrome-extension.ts [--channel store|local|dev|e2e] [--out <dir>]
//
// Output: .buildersbot-build/chrome-extension/<channel>/ (an unpacked extension). The code is bundled
// with Bun and not minified, so a store reviewer can read it, and it has no runtime dependency. The
// `_locales` folders are written from the `chromeExtension.*` keys of @openbot/i18n (en, and pt as
// Chrome's pt_BR). The local, development and E2E builds carry the public `key` that gives them their
// fixed ID (contracts `extension-ids.ts`); the store build has no `key`. The local build is the one that
// the owner of a locally signed app loads unpacked, and it keeps the product name.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CHROME_BRIDGE_CHANNELS,
  type ChromeBridgeChannel,
  EXTENSION_PUBLIC_KEYS,
} from "@openbot/contracts/chrome-bridge/extension-ids";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { messages as english } from "../packages/i18n/src/messages/en/chromeExtension";
import { messages as portuguese } from "../packages/i18n/src/messages/pt/chromeExtension";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = join(ROOT, "apps/chrome-extension");

/** The keys that only the manifest names (`__MSG_…__`), listed so the i18n check sees them used. */
const MANIFEST_KEYS = [
  "chromeExtension.extName",
  "chromeExtension.extDescription",
  "chromeExtension.actionTitle",
  "chromeExtension.command.stopAll",
] as const;

/** A name instead of the localized product name, so a test build is not taken for the real one. */
const CHANNEL_NAMES: Readonly<{ [channel in ChromeBridgeChannel]: string | null }> = {
  store: null,
  local: null,
  dev: "Builders Bot (Dev)",
  e2e: "Builders Bot (E2E)",
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function readChannel(value: string | undefined): ChromeBridgeChannel {
  const channel = CHROME_BRIDGE_CHANNELS.find((candidate) => candidate === (value ?? "dev"));
  if (!channel) throw new Error(`--channel must be one of ${CHROME_BRIDGE_CHANNELS.join(", ")}`);
  return channel;
}

/**
 * One catalog in Chrome's message format. `{name}` becomes `$name$`, with the placeholder's index in
 * the English text, so a translation may move a placeholder but keeps its argument. A `$` of the text
 * itself is written `$$`. A key with no translation is left out: Chrome then shows the English one.
 */
function chromeMessages(translation: { readonly [key: string]: string | undefined }): string {
  const out: { [name: string]: { message: string; placeholders?: { [name: string]: { content: string } } } } = {};
  for (const [key, source] of Object.entries(english)) {
    const text = translation[key];
    if (text === undefined) continue;
    const names = [...new Set([...source.matchAll(/\{(\w+)\}/gu)].map((match) => match[1] ?? ""))];
    const message = text.replaceAll("$", "$$$$").replace(/\{(\w+)\}/gu, (_, name: string) => `$${name}$`);
    const placeholders = Object.fromEntries(names.map((name, index) => [name, { content: `$${index + 1}` }]));
    out[key.replaceAll(".", "_")] = names.length > 0 ? { message, placeholders } : { message };
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

export async function buildChromeExtension(channel: ChromeBridgeChannel, outDir?: string): Promise<string> {
  const out = resolve(outDir ?? join(ROOT, ".buildersbot-build/chrome-extension", channel));
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const result = await Bun.build({
    entrypoints: [
      join(SOURCE, "src/background/service-worker.ts"),
      join(SOURCE, "src/pages/popup.ts"),
      join(SOURCE, "src/pages/welcome.ts"),
    ],
    outdir: out,
    target: "browser",
    format: "esm",
    minify: false,
    splitting: false,
    sourcemap: "none",
    naming: "[name].[ext]",
    define: { __BB_CHANNEL__: JSON.stringify(channel) },
  });
  if (!result.success) throw new AggregateError(result.logs, "The extension did not build.");

  for (const page of ["popup.html", "welcome.html", "pages.css"])
    await cp(join(SOURCE, "src/pages", page), join(out, page));
  await cp(join(SOURCE, "icons"), join(out, "icons"), { recursive: true });

  const packageJson = JSON.parse(await readFile(join(SOURCE, "package.json"), "utf8"));
  const version = isDynamicRecord(packageJson) && isString(packageJson.version) ? packageJson.version : "0.0.0";
  const manifest = JSON.parse(await readFile(join(SOURCE, "manifest.base.json"), "utf8"));
  if (!isDynamicRecord(manifest)) throw new Error("manifest.base.json is not an object");
  const name = CHANNEL_NAMES[channel];
  const finalManifest = {
    ...manifest,
    version,
    ...(name === null ? {} : { name }),
    ...(channel === "store" ? {} : { key: EXTENSION_PUBLIC_KEYS[channel] }),
  };
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(finalManifest, null, 2)}\n`);

  for (const key of MANIFEST_KEYS) if (!(key in english)) throw new Error(`${key} is not in the catalog`);
  await mkdir(join(out, "_locales/en"), { recursive: true });
  await mkdir(join(out, "_locales/pt_BR"), { recursive: true });
  await writeFile(join(out, "_locales/en/messages.json"), chromeMessages(english));
  await writeFile(join(out, "_locales/pt_BR/messages.json"), chromeMessages(portuguese));
  return out;
}

if (import.meta.main) {
  const channel = readChannel(option("--channel"));
  const out = await buildChromeExtension(channel, option("--out"));
  process.stdout.write(`Built the ${channel} extension in ${out}\n`);
}
