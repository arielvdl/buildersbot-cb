// Checks the curated Apps list of the Marketplace and the app profile decoder that guards the Hub's
// answer. The list part drives the curated stories in Storybook, with the real catalog, the real
// curation store (receiveAppProfile and local storage) and the real CSS, in a headless browser with
// a new profile. Pass the URL that `bun run storybook` reports:
//
//   bun scripts/marketplace-apps-curation-e2e.ts --storybook=http://localhost:6006
//
// Writes .openbot-build/marketplace-apps-curation-e2e/report.json and one screenshot per state:
// en and pt, dark and light, 1280 x 880, 720 x 780 and 390 x 844, "Show all apps" off and on, and
// the Agents tab at each size.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_PROFILE_LIMITS, decodeAppProfile, decodeAppProfileText } from "@openbot/contracts/app-profile";
import { createBuildersBotLogger } from "@openbot/logging";
import { type Browser, chromium, type Page } from "playwright-core";
import { MARKETPLACE_PLUGINS } from "../src/renderer/src/features/settings/marketplace-plugin-catalog";

const OUT = resolve(import.meta.dirname, "../.openbot-build/marketplace-apps-curation-e2e");
const storybook = process.argv
  .find((argument) => argument.startsWith("--storybook="))
  ?.slice("--storybook=".length)
  .replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

/* Part 1: the decoder of the Hub's `appProfile` value. */

const VALID = {
  version: 1,
  tag: "Agência de design",
  apps: { show: ["figma", "canva", "slack"], hide: ["stripe"] },
  categories: ["design"],
  updatedAt: "2026-10-31T12:00:00.000Z",
};

/** `count` well-formed ids of 62 characters that the catalog does not have, as in the stories. */
const futureIds = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}-`.padEnd(62, "x"));

/** Slack, Notion and `count` future ids: 123 give 8,134 code units as JSON, 124 give 8,199. */
const sized = (count: number) => ({
  version: 1,
  tag: "Agência de design",
  apps: { show: ["slack", "notion", ...futureIds(count, "future-app")] },
  updatedAt: "2026-10-31T12:00:00.000Z",
});

interface DecoderCase {
  name: string;
  value: unknown;
  accepted: boolean;
  check?: (profile: NonNullable<ReturnType<typeof decodeAppProfile>>) => void;
}

const DECODER_CASES: DecoderCase[] = [
  { name: "valid profile", value: VALID, accepted: true },
  {
    name: "an unknown well-formed id stays, for a newer catalog",
    value: { ...VALID, apps: { show: ["figma", "some-future-app"] } },
    accepted: true,
    check: (profile) => assert.deepEqual(profile.apps.show, ["figma", "some-future-app"]),
  },
  {
    name: "duplicate ids are kept once",
    value: { ...VALID, apps: { show: ["figma", "figma", "slack"] } },
    accepted: true,
    check: (profile) => assert.deepEqual(profile.apps.show, ["figma", "slack"]),
  },
  {
    name: "an unknown category is dropped",
    value: { ...VALID, categories: ["design", "astrology"] },
    accepted: true,
    check: (profile) => assert.deepEqual(profile.categories, ["design"]),
  },
  {
    name: "hide and categories are optional",
    value: { version: 1, tag: "Loja", apps: { show: ["slack"] }, updatedAt: "2026-10-31T12:00:00Z" },
    accepted: true,
    check: (profile) => {
      assert.deepEqual(profile.apps.hide, []);
      assert.deepEqual(profile.categories, []);
    },
  },
  {
    name: "an unknown top-level field is ignored",
    value: { ...VALID, colour: "green" },
    accepted: true,
  },
  {
    name: "the tag is trimmed and its spaces joined",
    value: { ...VALID, tag: "  Agência   de design " },
    accepted: true,
    check: (profile) => assert.equal(profile.tag, "Agência de design"),
  },
  { name: "not an object", value: "figma,canva", accepted: false },
  { name: "an array", value: [VALID], accepted: false },
  { name: "null", value: null, accepted: false },
  { name: "a profile without version is version 1", value: { ...VALID, version: undefined }, accepted: true },
  {
    name: "null in version, hide and categories reads as an absent field",
    value: { ...VALID, version: null, apps: { show: ["figma"], hide: null }, categories: null },
    accepted: true,
    check: (profile) => {
      assert.equal(profile.version, 1);
      assert.deepEqual(profile.apps.hide, []);
      assert.deepEqual(profile.categories, []);
    },
  },
  { name: "show is null", value: { ...VALID, apps: { show: null } }, accepted: false },
  { name: "a newer version", value: { ...VALID, version: 2 }, accepted: false },
  { name: "the version as text", value: { ...VALID, version: "1" }, accepted: false },
  { name: "markup in the tag", value: { ...VALID, tag: "<img src=x onerror=alert(1)>" }, accepted: false },
  { name: "a control character in the tag", value: { ...VALID, tag: "Design\u0007" }, accepted: false },
  { name: "a bidi override in the tag", value: { ...VALID, tag: "Design‮gnp" }, accepted: false },
  { name: "an empty tag", value: { ...VALID, tag: "   " }, accepted: false },
  { name: "a tag over the limit", value: { ...VALID, tag: "a".repeat(APP_PROFILE_LIMITS.tag + 1) }, accepted: false },
  { name: "a very long tag", value: { ...VALID, tag: "a".repeat(100_000) }, accepted: false },
  { name: "an id that is not a slug", value: { ...VALID, apps: { show: ["Figma"] } }, accepted: false },
  { name: "an id with a path", value: { ...VALID, apps: { show: ["../figma"] } }, accepted: false },
  { name: "an id that is not text", value: { ...VALID, apps: { show: [42] } }, accepted: false },
  {
    name: "too many ids",
    value: { ...VALID, apps: { show: Array.from({ length: APP_PROFILE_LIMITS.apps + 1 }, (_, i) => `app-${i}`) } },
    accepted: false,
  },
  { name: "show is not a list", value: { ...VALID, apps: { show: "figma" } }, accepted: false },
  { name: "no apps object", value: { ...VALID, apps: undefined }, accepted: false },
  { name: "hide is not a list", value: { ...VALID, apps: { show: ["figma"], hide: "stripe" } }, accepted: false },
  {
    name: "a profile that shows nothing",
    value: { ...VALID, apps: { show: [] }, categories: [] },
    accepted: false,
  },
  { name: "a category that is not text", value: { ...VALID, categories: [1] }, accepted: false },
  {
    name: "too many categories",
    value: { ...VALID, categories: Array.from({ length: APP_PROFILE_LIMITS.categories + 1 }, () => "design") },
    accepted: false,
  },
  { name: "a date that is not ISO 8601", value: { ...VALID, updatedAt: "31/10/2026" }, accepted: false },
  { name: "an impossible date", value: { ...VALID, updatedAt: "2026-13-45T99:99:00Z" }, accepted: false },
  {
    name: "a profile of 8,134 code units as JSON, under the size limit",
    value: sized(123),
    accepted: true,
    check: (profile) => assert.equal(JSON.stringify(profile).length, 8_134),
  },
  { name: "a profile of 8,199 code units as JSON, over the size limit", value: sized(124), accepted: false },
  {
    name: "128 ids in show and 128 in hide, 16,712 code units as JSON",
    value: {
      ...VALID,
      apps: { show: ["slack", ...futureIds(127, "future-app")], hide: futureIds(128, "retired-app") },
    },
    accepted: false,
  },
];

const decoder = DECODER_CASES.map((entry) => {
  const profile = decodeAppProfile(entry.value);
  assert.equal(profile !== null, entry.accepted, `Decoder case "${entry.name}"`);
  if (profile && entry.check) entry.check(profile);
  return { name: entry.name, accepted: profile !== null };
});

const oversizeText = JSON.stringify({ ...VALID, padding: "x".repeat(APP_PROFILE_LIMITS.text) });
assert.equal(decodeAppProfileText(oversizeText), null, "A text over the limit was accepted.");
assert.equal(decodeAppProfileText("{not json"), null, "A text that is not JSON was accepted.");
assert.notEqual(decodeAppProfileText(JSON.stringify(VALID)), null, "A valid text was refused.");
decoder.push(
  { name: "a text over the size limit", accepted: false },
  { name: "a text that is not JSON", accepted: false },
  { name: "a valid text", accepted: true },
);

/* Part 2: the Apps list in Storybook. */

/** The apps that the owner chose for the default list on 2026-10-31. */
const DEFAULT_SHOWN_APP_IDS = [
  "github",
  "slack",
  "telegram",
  "whatsapp",
  "trello",
  "obsidian",
  "notion",
  "atlassian",
  "apple-apps",
  "discord",
  "onepassword",
  "context7",
  "playwright",
];

const CONNECTOR_NAMES: Readonly<Record<string, string>> = {
  github: "GitHub",
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  onepassword: "1Password",
  bitwarden: "Bitwarden",
};
/** A subtitle of a connector and of a catalog app, in each language of the screenshots. */
const TAGLINES = {
  en: ["Mentions and direct messages in Slack", "Docs and knowledge base"],
  pt: ["Menções e mensagens diretas no Slack", "Docs e base de conhecimento"],
} as const;

/** The server that the stories hold and no catalog app claims. The list always shows it. */
const CUSTOM_SERVER = "Local SQLite";

function appName(id: string): string {
  const name = CONNECTOR_NAMES[id] ?? MARKETPLACE_PLUGINS.find((plugin) => plugin.slug === id)?.name;
  assert.ok(name, `No app has the id ${id}.`);
  return name;
}

const ALL_IDS = [...Object.keys(CONNECTOR_NAMES), ...MARKETPLACE_PLUGINS.map((plugin) => plugin.slug)];
const sorted = (names: Iterable<string>) => [...names].sort((left, right) => left.localeCompare(right));
const DEFAULT_NAMES = sorted([...DEFAULT_SHOWN_APP_IDS.map(appName), CUSTOM_SERVER]);
const ALL_NAMES = sorted([...ALL_IDS.map(appName), CUSTOM_SERVER]);

type Locale = "en" | "pt";
type Scheme = "dark" | "light";

function storyUrl(story: string, locale: Locale = "en", scheme: Scheme = "dark"): string {
  return `${storybook}/iframe.html?id=settings-marketplace--${story}&viewMode=story&globals=locale:${locale};colorScheme:${scheme}`;
}

/** The names of the app rows, from the label of each row: "Open Slack" or "Abrir Slack". */
async function rowNames(page: Page): Promise<string[]> {
  const labels = await page
    .locator(".marketplace-app-row-hit")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label") ?? ""));
  return sorted(labels.map((label) => label.replace(/^(Open|Abrir) /u, "")));
}

async function groupTitles(page: Page): Promise<string[]> {
  return page
    .locator(".marketplace-app-group-title")
    .evaluateAll((titles) => titles.map((title) => title.firstChild?.textContent?.trim() ?? ""));
}

const showAllSwitch = (page: Page) => page.locator(".marketplace-show-all input");

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.locator(".marketplace-app-row").first().waitFor({ timeout: 240_000 });
}

/** Waits until the list holds `count` rows. */
async function waitForRows(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll(".marketplace-app-row-hit").length === expected,
    count,
    { timeout: 15_000 },
  );
}

const steps: string[] = [];
const screenshots: string[] = [];
mkdirSync(OUT, { recursive: true });

/** Waits until each app icon loaded or failed, so a screenshot shows the icons. Vendor icons can be slow. */
async function settleImages(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLImageElement>(".skills-marketplace img")].every((image) => image.complete),
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
}

/** The page, the scrolling body and the toolbar fit the width: nothing scrolls sideways. */
async function assertFits(page: Page, name: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const body = document.querySelector(".skills-marketplace-body");
    const head = document.querySelector(".marketplace-browse-head")?.getBoundingClientRect();
    const controls = [...(document.querySelector(".marketplace-toolbar")?.children ?? [])];
    const right = Math.max(0, ...controls.map((control) => control.getBoundingClientRect().right));
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      body: body ? body.scrollWidth - body.clientWidth : 0,
      toolbar: head ? Math.round(right - head.right) : 0,
    };
  });
  assert.ok(
    overflow.page <= 0 && overflow.body <= 0 && overflow.toolbar <= 0,
    `${name} scrolls sideways: ${JSON.stringify(overflow)}`,
  );
}

async function shot(page: Page, name: string): Promise<void> {
  await settleImages(page);
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  screenshots.push(path);
}

const browser: Browser = await chromium.launch({ headless: true });
try {
  // A new context for each check: its local storage starts empty, as on a new computer.
  const context = await browser.newContext({ viewport: { width: 1280, height: 880 }, reducedMotion: "reduce" });
  const page = await context.newPage();

  // The default list, with no organization profile.
  await open(page, storyUrl("apps-curated"));
  assert.equal(await showAllSwitch(page).isChecked(), false, "Show all apps is on at first.");
  assert.deepEqual(await rowNames(page), DEFAULT_NAMES, "The default list is not the chosen apps.");
  assert.deepEqual(
    await groupTitles(page),
    ["Coding", "Productivity", "Research", "Automation", "Other"],
    "The default list shows a category that has no default app.",
  );
  steps.push("the default list shows the chosen apps, and the categories with no app are gone");

  // The WhatsApp row draws the WhatsApp mark, not the puzzle piece of a failed icon.
  const whatsappMark = page
    .locator(".marketplace-app-row", { has: page.locator('[aria-label="Open WhatsApp"]') })
    .locator('svg path[d^="M17.472 14.382"]');
  assert.equal(await whatsappMark.count(), 1, "The WhatsApp row has no WhatsApp mark.");
  await page.getByRole("button", { name: "Open WhatsApp", exact: true }).click();
  await page.getByRole("heading", { name: "WhatsApp", level: 3 }).waitFor();
  // The page header, the row of the listing's app and the chip of each example request.
  assert.ok(
    (await page.locator('.marketplace-frame svg path[d^="M17.472 14.382"]').count()) >= 2,
    "The WhatsApp page does not draw the WhatsApp mark in its header and its app row.",
  );
  assert.equal(
    await page.locator(".marketplace-frame .skills-marketplace-icon img").count(),
    0,
    "The WhatsApp page loads the vendor icon.",
  );
  await shot(page, "whatsapp-page-en-dark-1280");
  await page.keyboard.press("Escape");
  await waitForRows(page, DEFAULT_NAMES.length);
  steps.push("the WhatsApp row and page draw the WhatsApp mark");

  // A search reaches an app that the list does not show.
  const search = page.getByRole("searchbox", { name: "Search the marketplace" });
  await search.fill("stripe");
  await waitForRows(page, 1);
  assert.deepEqual(await rowNames(page), ["Stripe"], "The search does not find a hidden app.");
  await search.fill("");
  await waitForRows(page, DEFAULT_NAMES.length);
  steps.push("the search finds a hidden app");

  // Show all apps: every app. A new page load that does not set the choice reads the saved one, as
  // the app does at its next start.
  await page.getByText("Show all apps", { exact: true }).click();
  await waitForRows(page, ALL_NAMES.length);
  assert.deepEqual(await rowNames(page), ALL_NAMES, "Show all apps does not show every app.");
  await open(page, storyUrl("apps-saved-choice"));
  await waitForRows(page, ALL_NAMES.length);
  assert.equal(await showAllSwitch(page).isChecked(), true, "A new page load did not read the saved choice.");
  await page.getByText("Show all apps", { exact: true }).click();
  await waitForRows(page, DEFAULT_NAMES.length);
  await open(page, storyUrl("apps-saved-choice"));
  await waitForRows(page, DEFAULT_NAMES.length);
  assert.equal(await showAllSwitch(page).isChecked(), false, "A new page load did not read the choice off.");
  steps.push("Show all apps shows every app, and a new page load reads the saved choice, on and off");
  await context.close();

  // A profile from the Hub replaces the default list, and its tag shows.
  const profileContext = await browser.newContext({ viewport: { width: 1280, height: 880 }, reducedMotion: "reduce" });
  const profilePage = await profileContext.newPage();
  await open(profilePage, storyUrl("apps-organization-profile"));
  const profileNames = sorted([
    // GitHub is connected in the stories, so the list keeps it.
    "GitHub",
    ...["slack", "notion", "whatsapp", "trello", "canva", "figma"].map(appName),
    CUSTOM_SERVER,
  ]);
  assert.deepEqual(await rowNames(profilePage), profileNames, "The profile does not choose the list.");
  assert.equal(
    await profilePage.getByText("Selected for Agência de design", { exact: true }).count(),
    1,
    "The tag of the profile does not show.",
  );
  await shot(profilePage, "profile-en-dark-1280");
  steps.push("a profile replaces the default list and shows its tag; hide wins over its category");

  // A malformed profile gives the default list and no tag.
  await open(profilePage, storyUrl("apps-malformed-profile"));
  assert.deepEqual(await rowNames(profilePage), DEFAULT_NAMES, "A malformed profile changed the list.");
  assert.equal(await profilePage.getByText(/^Selected for/u).count(), 0, "A malformed profile shows a tag.");
  steps.push("a malformed profile gives the default list");

  // An installed app that the default list does not name stays in the list.
  await open(profilePage, storyUrl("apps-installed-hidden"));
  assert.deepEqual(
    await rowNames(profilePage),
    sorted([...DEFAULT_NAMES, "Stripe"]),
    "An installed app left the list.",
  );
  await shot(profilePage, "installed-hidden-en-dark-1280");
  steps.push("an installed app stays in the list");

  // A link to a hidden app opens its page.
  await profilePage.goto(storyUrl("apps-hidden-link"), { waitUntil: "domcontentloaded", timeout: 300_000 });
  await profilePage.getByRole("heading", { name: "Stripe", level: 3 }).waitFor({ timeout: 60_000 });
  steps.push("a link to a hidden app opens its page");
  await profileContext.close();

  // The size limit and the kept profile, through receiveAppProfile and the local storage of the page.
  const keptContext = await browser.newContext({ viewport: { width: 1280, height: 880 }, reducedMotion: "reduce" });
  const keptPage = await keptContext.newPage();
  const largeNames = sorted(["GitHub", "Slack", "Notion", CUSTOM_SERVER]);
  const expectRows = async (story: string, names: string[], message: string) => {
    await open(keptPage, storyUrl(story));
    await waitForRows(keptPage, names.length);
    assert.deepEqual(await rowNames(keptPage), names, message);
  };
  await expectRows("apps-large-profile", largeNames, "A profile under the size limit was refused.");
  const kept = await keptPage.evaluate(() => window.localStorage.getItem("openbot:marketplace-app-profile") ?? "");
  assert.ok(kept.length > 8_134, `The profile under the size limit was not kept (${kept.length} code units).`);
  assert.ok(!kept.includes("story-account"), "The cache holds the account key, not its hash.");
  await expectRows("apps-before-answer", DEFAULT_NAMES, "A kept profile applied before an answer named its account.");
  await expectRows("apps-kept-profile", largeNames, "The kept profile did not apply after a new page load.");
  assert.equal(
    await keptPage.getByText("Selected for Agência de design", { exact: true }).count(),
    1,
    "The tag of the kept profile does not show.",
  );
  await expectRows("apps-oversize-profile", DEFAULT_NAMES, "A profile over the size limit changed the list.");
  await expectRows("apps-kept-profile", DEFAULT_NAMES, "A refused profile did not replace the kept profile.");
  steps.push(
    "a profile under the size limit applies and is kept; it waits for an answer that names its account, and applies after a new page load; a profile over the limit gives the default list and replaces the kept one",
  );
  await keptContext.close();

  // The screenshots: each language, scheme and size, with Show all apps off and on.
  const sizes = [
    { name: "1280", width: 1280, height: 880 },
    { name: "720", width: 720, height: 780 },
    // The web app on a phone.
    { name: "390", width: 390, height: 844 },
  ];
  for (const locale of ["en", "pt"] as const) {
    for (const scheme of ["dark", "light"] as const) {
      for (const size of sizes) {
        const shotContext = await browser.newContext({
          viewport: { width: size.width, height: size.height },
          reducedMotion: "reduce",
        });
        const shotPage = await shotContext.newPage();
        await open(shotPage, storyUrl("apps-curated", locale, scheme));
        const label = locale === "pt" ? "Mostrar todos os apps" : "Show all apps";
        assert.equal(await shotPage.getByText(label, { exact: true }).count(), 1, `No "${label}" switch.`);
        await waitForRows(shotPage, DEFAULT_NAMES.length);
        // The subtitles of a connector and of a catalog app are in the language of the story.
        for (const tagline of TAGLINES[locale]) {
          assert.ok(
            (await shotPage.getByText(tagline, { exact: true }).count()) >= 1,
            `The ${locale} list has no "${tagline}".`,
          );
        }
        await assertFits(shotPage, `off-${locale}-${scheme}-${size.name}`);
        await shot(shotPage, `off-${locale}-${scheme}-${size.name}`);
        await shotPage.getByText(label, { exact: true }).click();
        await waitForRows(shotPage, ALL_NAMES.length);
        assert.equal(await showAllSwitch(shotPage).isChecked(), true, "The switch did not turn on.");
        await assertFits(shotPage, `on-${locale}-${scheme}-${size.name}`);
        await shot(shotPage, `on-${locale}-${scheme}-${size.name}`);
        await shotContext.close();
      }
    }
  }
  steps.push(
    "screenshots in en and pt, dark and light, 1280, 720 and 390 wide, off and on; the subtitles are in the language of the story; nothing scrolls sideways",
  );

  // The Agents tab has the same head and no switch: its toolbar stays on one line, and nothing
  // scrolls sideways.
  for (const size of sizes) {
    const agentsContext = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      reducedMotion: "reduce",
    });
    const agentsPage = await agentsContext.newPage();
    await agentsPage.goto(storyUrl("agents"), { waitUntil: "domcontentloaded", timeout: 300_000 });
    await agentsPage.locator(".marketplace-toolbar").waitFor({ timeout: 240_000 });
    const wrap = await agentsPage.evaluate(() => {
      const toolbar = document.querySelector(".marketplace-toolbar");
      return toolbar ? getComputedStyle(toolbar).flexWrap : "";
    });
    assert.equal(wrap, "nowrap", `The Agents toolbar wraps at ${size.name} pixels.`);
    await assertFits(agentsPage, `agents-en-dark-${size.name}`);
    await shot(agentsPage, `agents-en-dark-${size.name}`);
    await agentsContext.close();
  }
  steps.push("the Agents toolbar stays on one line at 1280, 720 and 390 pixels, and nothing scrolls sideways");
} finally {
  await browser.close();
}

const report = {
  storybook,
  defaultShown: DEFAULT_SHOWN_APP_IDS,
  hiddenByDefault: ALL_IDS.filter((id) => !DEFAULT_SHOWN_APP_IDS.includes(id)),
  decoder,
  steps,
  screenshots,
};
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
createBuildersBotLogger("marketplace-apps-curation-e2e").info(
  `${steps.length} checks and ${decoder.length} decoder cases passed. Report: ${resolve(OUT, "report.json")}`,
);
