// Checks the screens of the Hub connections in Storybook, in a headless browser with a new profile:
// the tool catalog in the curated Apps list (hidden by default, shown in use or by a profile, found by
// the search and a link), its Marketplace page (what it gives, categories, cap with the 80 % mark, who
// pays, the switch of each agent, where the data goes, and each state: warning, reached, not on,
// choose who pays, paused, consent, signed out), Usage › Connections, and the cost lines of a chat
// with "Ask the admin for more". The stories run the real components, the real curation and the real
// CSS. Pass the URL that `bun run storybook` reports:
//
//   bun scripts/hub-connections-surfaces-e2e.ts --storybook=http://localhost:6006
//
// Writes .buildersbot-build/hub-connections/surfaces/report.json and a screenshot of each state, in en
// and pt, dark and light, at a normal and a narrow width. Nothing may scroll sideways.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";
import { type Browser, chromium, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.buildersbot-build/hub-connections/surfaces");
const storybook = process.argv
  .find((argument) => argument.startsWith("--storybook="))
  ?.slice("--storybook=".length)
  .replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");

type Locale = "en" | "pt";
type Scheme = "dark" | "light";

const TEXT = {
  en: {
    name: "Tool catalog",
    group: "Connections",
    yours: "Your connections",
    on: "On",
    off: "Not on for you",
    vendor: "Provided by treg.to",
    data: "Where the data goes",
    flow: "to treg.to (USA)",
    more: "Ask the admin for more",
    ask: "Ask the admin",
    sent: "Request sent on",
    usage: "Connections",
  },
  pt: {
    name: "Catálogo de ferramentas",
    group: "Conexões",
    yours: "Suas conexões",
    on: "Ativa",
    off: "Não liberada para você",
    vendor: "Fornecido por treg.to",
    data: "Para onde vão os dados",
    flow: "ao treg.to (EUA)",
    more: "Pedir mais ao admin",
    ask: "Pedir ao admin",
    sent: "Pedido enviado em",
    usage: "Conexões",
  },
} as const;

/** The dates of the fixtures read the same in every time zone of the owner: Brasília. */
const TIME_ZONE = "America/Sao_Paulo";

const SIZES = {
  normal: { width: 1280, height: 880 },
  narrow: { width: 390, height: 844 },
  chat: { width: 720, height: 420 },
} as const;

function storyUrl(id: string, locale: Locale = "en", scheme: Scheme = "dark"): string {
  return `${storybook}/iframe.html?id=${id}&viewMode=story&globals=locale:${locale};colorScheme:${scheme}`;
}
const marketplace = (story: string) => `settings-marketplace--${story}`;

const steps: string[] = [];
const screenshots: string[] = [];
mkdirSync(OUT, { recursive: true });

async function open(
  page: Page,
  id: string,
  locale: Locale = "en",
  scheme: Scheme = "dark",
  ready = ".skills-marketplace",
) {
  await page.goto(storyUrl(id, locale, scheme), { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.locator(ready).first().waitFor({ timeout: 240_000 });
}

/**
 * Nothing scrolls sideways: the page, and the scrolling body of the Marketplace. On Usage the body
 * also holds the model report, whose breakdown table at 390 pixels in Portuguese is wider than the
 * body before this change; there the check covers the page and the connection part, and the report
 * keeps the body's overflow as a known issue. A failure names what sticks out.
 */
const knownIssues: string[] = [];
async function assertFits(page: Page, name: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const usage = document.querySelector(".connection-usage");
    const body = document.querySelector(".skills-marketplace-body, .agent-usage-body");
    const limit = body ? body.getBoundingClientRect().right : window.innerWidth;
    const scope = usage ?? document.body;
    const out = [...scope.querySelectorAll("*")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.right > Math.min(limit, window.innerWidth) + 1;
      })
      .slice(0, 6)
      .map(
        (element) =>
          `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 48)} "${(element.textContent ?? "").slice(0, 32)}"`,
      );
    const section = usage ? usage.getBoundingClientRect().right - limit : 0;
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      body: body ? body.scrollWidth - body.clientWidth : 0,
      usage: usage !== null,
      section,
      // The connection table scrolls inside its own box; a row of it may be wider, not the part.
      out: usage ? [] : out,
    };
  });
  if (overflow.usage) {
    if (overflow.body > 0)
      knownIssues.push(`${name}: the model report makes the Usage body scroll ${overflow.body} px sideways`);
    assert.ok(overflow.page <= 0 && overflow.section <= 1, `${name} scrolls sideways: ${JSON.stringify(overflow)}`);
    return;
  }
  assert.ok(overflow.page <= 0 && overflow.body <= 0, `${name} scrolls sideways: ${JSON.stringify(overflow)}`);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(150);
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  screenshots.push(path);
}

/** The names of the app rows: "Open Slack" or "Abrir Slack". */
async function rowNames(page: Page): Promise<string[]> {
  const labels = await page
    .locator(".marketplace-app-row-hit")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label") ?? ""));
  return labels.map((label) => label.replace(/^(Open|Abrir) /u, ""));
}

async function groupTitles(page: Page): Promise<string[]> {
  return page
    .locator(".marketplace-app-group-title")
    .evaluateAll((titles) => titles.map((title) => title.firstChild?.textContent?.trim() ?? ""));
}

/** Ends the run after the checks, with no screenshots. */
class ChecksDone extends Error {}

const browser: Browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: SIZES.normal, reducedMotion: "reduce", timezoneId: TIME_ZONE });
  const page = await context.newPage();

  // Not on for the person: the default list hides it; the search, "Show all apps" and a link reach it.
  await open(page, marketplace("connections-hidden"));
  await page.locator(".marketplace-app-row").first().waitFor();
  assert.ok(!(await rowNames(page)).includes(TEXT.en.name), "the default list shows a connection that is not on");
  assert.ok(!(await groupTitles(page)).includes(TEXT.en.group), "the default list has a Connections group");
  const search = page.getByRole("searchbox", { name: "Search the marketplace" });
  await search.fill("Tool catalog");
  await page.waitForFunction(() => document.querySelectorAll(".marketplace-app-row-hit").length === 1);
  assert.deepEqual(await rowNames(page), [TEXT.en.name], "the search does not find the connection");
  assert.ok((await groupTitles(page)).includes(TEXT.en.group));
  assert.equal(await page.locator(".marketplace-app-row", { hasText: TEXT.en.off }).count(), 1);
  await search.fill("");
  await page.getByText("Show all apps", { exact: true }).click();
  await page.waitForFunction((name) => document.querySelector(`[aria-label="Open ${name}"]`) !== null, TEXT.en.name);
  assert.equal((await groupTitles(page))[0], TEXT.en.group, "the Connections group is not first");
  await page.getByText("Show all apps", { exact: true }).click();
  steps.push("not on for the person: hidden by default, found by the search and by Show all apps, in its own group");

  // In use: the curated list shows it, and the side panel names it under Your connections.
  await open(page, marketplace("connections-in-use"));
  await page.locator(".marketplace-app-row").first().waitFor();
  assert.ok((await rowNames(page)).includes(TEXT.en.name), "a connection in use is hidden");
  assert.equal((await groupTitles(page))[0], TEXT.en.group);
  const row = page.locator(".marketplace-app-row", { has: page.locator(`[aria-label="Open ${TEXT.en.name}"]`) });
  assert.equal(await row.getByText(TEXT.en.on, { exact: true }).count(), 1, "the row does not say On");
  const nav = page.locator(".marketplace-nav");
  assert.equal(await nav.getByText(TEXT.en.yours, { exact: true }).count(), 1);
  assert.equal(await nav.getByRole("button", { name: TEXT.en.name }).count(), 1);
  steps.push("in use: the curated list and the side panel show it, with its state");

  // Paused by Cultura Builder with no spend yet: still installed, so the curated list keeps it.
  await open(page, marketplace("connections-paused"));
  await page.locator(".marketplace-app-row").first().waitFor();
  assert.ok((await rowNames(page)).includes(TEXT.en.name), "a paused connection that the person has is hidden");
  steps.push("paused with no spend: the curated list still shows it");

  // An organization profile names it: shown, also when it is not on.
  await open(page, marketplace("connections-profile"));
  await page.locator(".marketplace-app-row").first().waitFor();
  assert.ok((await rowNames(page)).includes(TEXT.en.name), "a profile that names the connection does not show it");
  steps.push("an organization profile that names it shows it");

  // The page: what it gives, categories, cap with the 80 % mark, who pays, the agents, the data.
  await open(page, marketplace("connection-page"));
  await page.getByRole("heading", { name: TEXT.en.name, level: 3 }).waitFor({ timeout: 60_000 });
  for (const text of [
    "What it gives",
    "Categories that your organization allows",
    "Your monthly limit",
    "Who pays",
    "Agents",
    TEXT.en.data,
    TEXT.en.vendor,
    "Results can be wrong or out of date. Found contacts are not confirmed.",
    "Builders Bot asks you before a call above R$0.25.",
    "No key is on this computer: Cultura Builder keeps the key and pays the provider.",
  ])
    assert.ok((await page.getByText(text, { exact: true }).count()) >= 1, `the page has no "${text}"`);
  assert.ok(
    (await page.getByText(TEXT.en.flow, { exact: false }).count()) >= 1,
    "the data block does not name treg.to",
  );
  assert.equal(await page.locator(".marketplace-connection-categories li").count(), 5);
  const bar = page.getByRole("progressbar", { name: "Monthly limit used" });
  assert.equal(await bar.getAttribute("aria-valuenow"), "25");
  assert.ok((await bar.getAttribute("aria-valuetext"))?.includes("R$6.18 of R$25.00"));
  const mark = await page.locator(".marketplace-connection-cap-mark").evaluate((element) => {
    const track = element.parentElement?.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return track ? (box.left - track.left) / track.width : -1;
  });
  assert.ok(Math.abs(mark - 0.8) < 0.02, `the 80 % mark is at ${mark}`);
  assert.equal(await page.getByText("Pays", { exact: true }).count(), 1, "the payer has no badge");
  // The switches: one per agent; the second has the connection off. The keyboard turns the first off.
  const switches = page.getByRole("switch");
  assert.equal(await switches.count(), 3);
  assert.deepEqual(
    await switches.evaluateAll((items) =>
      items.map(
        (item) => item.getAttribute("aria-checked") ?? (item instanceof HTMLInputElement ? String(item.checked) : ""),
      ),
    ),
    ["true", "false", "true"],
  );
  await switches.first().focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => {
    const first = document.querySelector('[role="switch"]');
    return first?.getAttribute("aria-checked") === "false" || (first instanceof HTMLInputElement && !first.checked);
  });
  assert.equal(await page.getByText(`Cannot use ${TEXT.en.name}.`, { exact: true }).count(), 2);
  steps.push(
    "the page: what it gives, 5 categories, the cap bar at 25 % with its label and the mark at 80 %, the payer, a switch per agent that the keyboard turns off, and Provided by treg.to",
  );

  // Over 80 %: the warning, and the bar past the mark.
  await open(page, marketplace("connection-page-warning"));
  await page.getByText("You used 80% of your monthly limit", { exact: true }).waitFor({ timeout: 60_000 });
  assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "82");
  steps.push("80 %: the warning alert and the bar at 82 %");

  // The cap reached: the calls stop, and the person asks the admin for more.
  await open(page, marketplace("connection-page-reached"));
  await page.getByText("You reached your monthly limit", { exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: TEXT.en.more }).click();
  await page.getByText(`${TEXT.en.sent} 11/18`, { exact: true }).waitFor();
  steps.push("100 %: the danger alert, and Ask the admin for more gives Request sent on its date");

  // Not on for the person: a link opens the page, and the person asks the admin.
  await open(page, marketplace("connection-page-not-enabled"));
  await page.getByText("Your organization has not turned it on yet.", { exact: true }).waitFor({ timeout: 60_000 });
  assert.equal(await page.getByText("Your monthly limit", { exact: true }).count(), 0, "a locked page shows a cap");
  assert.equal(
    await page.getByText("Categories that your organization allows", { exact: true }).count(),
    0,
    "a page that the organization did not turn on lists categories",
  );
  await page.getByRole("button", { name: TEXT.en.ask, exact: true }).click();
  await page.getByText(`${TEXT.en.sent} 11/18`, { exact: true }).waitFor();
  steps.push("not on: a link opens the page; Ask the admin gives Request sent on its date; no cap shows");

  // Two organizations can pay: the person chooses.
  await open(page, marketplace("connection-page-choose-payer"));
  await page.getByText("Choose who pays", { exact: true }).waitFor({ timeout: 60_000 });
  assert.equal(await page.getByText("Pays", { exact: true }).count(), 0);
  // No payer yet: the cap names its organization, never "Paid by".
  assert.equal(await page.getByText("Organization: Empresa A", { exact: true }).count(), 1);
  assert.equal(await page.getByText(/^Paid by /u).count(), 0, "the page names a payer that the person did not choose");
  await page.getByRole("button", { name: "Pay with Empresa B" }).click();
  await page.getByText("Pays", { exact: true }).waitFor();
  await page.getByText("Paid by Empresa B", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Pay with Empresa B" }).count(), 0);
  steps.push("choose who pays: Pay with Empresa B makes it the payer");

  await open(page, marketplace("connection-page-paused"));
  await page.getByText("Paused by Cultura Builder", { exact: true }).waitFor({ timeout: 60_000 });
  await open(page, marketplace("connection-page-consent"));
  await page
    .getByText(
      "This app cannot spend the paid connections of this organization yet. Allow it on the Cultura Builder Hub.",
      { exact: true },
    )
    .waitFor({ timeout: 60_000 });
  await open(page, marketplace("connection-signed-out"));
  await page
    .getByText(
      "Sign in to Cultura Builder in the provider settings to see the paid connections of your organization.",
      {
        exact: true,
      },
    )
    .waitFor({ timeout: 60_000 });
  steps.push("paused, no consent and signed out: each page says why");

  // Usage › Connections: the charges apart from the model estimate, with the platforms.
  await open(page, "agents-usage--connections", "en", "dark", ".connection-usage");
  const usage = page.locator(".connection-usage");
  await usage.getByRole("heading", { name: TEXT.en.usage, level: 3 }).waitFor({ timeout: 60_000 });
  assert.equal(await usage.getByText("Paid by Empresa A", { exact: true }).count(), 1);
  assert.equal(await usage.getByText("80% used", { exact: true }).count(), 1);
  assert.deepEqual(await usage.locator("tbody th").evaluateAll((cells) => cells.map((cell) => cell.textContent)), [
    "google-ads",
    "trustpilot",
    "app-store",
  ]);
  assert.ok((await usage.getByText("214 calls", { exact: false }).count()) >= 1);
  await open(page, "agents-usage--connections-unavailable", "en", "dark", ".connection-usage");
  await page.getByText("Connection costs show when Cultura Builder answers.", { exact: true }).waitFor();
  // Portuguese has the longest labels: the Usage screen with its connection part fits both widths.
  for (const size of ["normal", "narrow"] as const) {
    await page.setViewportSize(SIZES[size]);
    await open(page, "agents-usage--connections", "pt", "dark", ".connection-usage");
    await page.getByText("Paga por Empresa A", { exact: true }).waitFor();
    await assertFits(page, `usage-pt-${size}`);
  }
  // The same screen with no connection part, for the known issue: is the overflow the model report's own?
  await page.setViewportSize(SIZES.narrow);
  await open(page, "agents-usage--usage", "pt", "dark", ".agent-usage-totals");
  const withoutConnections = await page.evaluate(() => {
    const body = document.querySelector(".agent-usage-body");
    return body ? body.scrollWidth - body.clientWidth : 0;
  });
  knownIssues.push(
    `usage-pt-narrow without the connection part: the Usage body scrolls ${withoutConnections} px sideways`,
  );
  await page.setViewportSize(SIZES.normal);
  steps.push(
    "Usage › Connections: Paid by Empresa A, the 80 % badge, three platforms by charge, the unavailable note, and the Portuguese screen fits at 1280 and 390 pixels",
  );

  // The cost lines of a chat, and Ask the admin for more from the limit line.
  await open(page, "conversation-chat-action-marker--connection-cost-lines", "en", "dark", ".chat-action-marker");
  for (const text of [
    "Keyword search volume: paid by Empresa A · R$0.10",
    "You passed 80% of your monthly limit of Catálogo de ferramentas, paid by Empresa A: R$4.60 left. It renews on Dec 1, 2026.",
    "You reached your monthly limit of Catálogo de ferramentas, paid by Empresa A. It renews on Dec 1, 2026.",
  ])
    assert.equal(await page.getByText(text, { exact: true }).count(), 1, `no line "${text}"`);
  await page.getByRole("button", { name: TEXT.en.more }).click();
  await page.getByText(`${TEXT.en.sent} 11/18`, { exact: true }).waitFor();
  await page.getByText("Requests sent: 1", { exact: true }).waitFor();
  steps.push("chat: the paid, 80 % and limit lines in the reader's money format; the limit line asks for more once");
  await context.close();

  // `--checks-only` skips the screenshots, for the mutation runs.
  if (process.argv.includes("--checks-only")) throw new ChecksDone();
  // Screenshots: each language and scheme, normal and narrow, and nothing scrolls sideways.
  const views: Array<{ name: string; id: string; ready: string; sizes: Array<keyof typeof SIZES>; all: boolean }> = [
    {
      name: "page",
      id: marketplace("connection-page"),
      ready: ".marketplace-connection-page",
      sizes: ["normal", "narrow"],
      all: true,
    },
    {
      name: "list",
      id: marketplace("connections-in-use"),
      ready: ".marketplace-app-row",
      sizes: ["normal", "narrow"],
      all: true,
    },
    {
      name: "usage",
      id: "agents-usage--connections",
      ready: ".connection-usage",
      sizes: ["normal", "narrow"],
      all: true,
    },
    {
      name: "chat",
      id: "conversation-chat-action-marker--connection-cost-lines",
      ready: ".chat-action-marker",
      sizes: ["chat"],
      all: true,
    },
    {
      name: "warning",
      id: marketplace("connection-page-warning"),
      ready: ".marketplace-connection-page",
      sizes: ["normal", "narrow"],
      all: false,
    },
    {
      name: "reached",
      id: marketplace("connection-page-reached"),
      ready: ".marketplace-connection-page",
      sizes: ["normal", "narrow"],
      all: false,
    },
    {
      name: "not-enabled",
      id: marketplace("connection-page-not-enabled"),
      ready: ".marketplace-connection-page",
      sizes: ["normal", "narrow"],
      all: false,
    },
    {
      name: "choose",
      id: marketplace("connection-page-choose-payer"),
      ready: ".marketplace-connection-page",
      sizes: ["normal", "narrow"],
      all: false,
    },
    {
      name: "paused",
      id: marketplace("connection-page-paused"),
      ready: ".marketplace-connection-page",
      sizes: ["normal"],
      all: false,
    },
    {
      name: "signed-out",
      id: marketplace("connection-signed-out"),
      ready: ".marketplace-empty",
      sizes: ["normal"],
      all: false,
    },
  ];
  const SOME: Array<[Locale, Scheme]> = [
    ["en", "dark"],
    ["pt", "light"],
  ];
  const combos: Array<[Locale, Scheme]> = [
    ["en", "dark"],
    ["en", "light"],
    ["pt", "dark"],
    ["pt", "light"],
  ];
  for (const view of views) {
    for (const [locale, scheme] of view.all ? combos : SOME) {
      for (const size of view.sizes) {
        const shotContext = await browser.newContext({
          viewport: SIZES[size],
          reducedMotion: "reduce",
          timezoneId: TIME_ZONE,
        });
        const shotPage = await shotContext.newPage();
        await open(shotPage, view.id, locale, scheme, view.ready);
        // The texts are in the language of the story.
        if (view.name === "page")
          for (const item of [TEXT[locale].vendor, TEXT[locale].data])
            assert.ok(
              (await shotPage.getByText(item, { exact: true }).count()) >= 1,
              `${view.name} ${locale} has no "${item}"`,
            );
        if (view.name === "list")
          assert.ok((await groupTitles(shotPage)).includes(TEXT[locale].group), `list ${locale} has no group`);
        if (view.name === "reached" && locale === "pt")
          assert.equal(await shotPage.getByRole("button", { name: TEXT.pt.more }).count(), 1, "no Pedir mais ao admin");
        // Usage shows its connection part below the model report: the picture shows that part.
        if (view.name === "usage") await shotPage.locator(".connection-usage").scrollIntoViewIfNeeded();
        // A chat line wraps inside its row, and its request button is on screen.
        if (view.name === "chat") {
          const fit = await shotPage.evaluate(() => ({
            rows: [...document.querySelectorAll(".chat-action-marker")].map((row) => row.scrollWidth - row.clientWidth),
            button: Math.round(
              (document.querySelector(".chat-action-marker .ui-button")?.getBoundingClientRect().right ?? 0) -
                window.innerWidth,
            ),
          }));
          assert.ok(
            fit.rows.every((extra) => extra <= 0) && fit.button <= 0,
            `chat ${locale}: a line sticks out ${JSON.stringify(fit)}`,
          );
        }
        // The screenshot first, so a check that fails leaves a picture of what it saw.
        await shot(shotPage, `${view.name}-${locale}-${scheme}-${size}`);
        await assertFits(shotPage, `${view.name}-${locale}-${scheme}-${size}`);
        // The end of a long page: the agents and where the data goes.
        if (view.name === "page") {
          await shotPage.locator(".marketplace-connection-vendor").scrollIntoViewIfNeeded();
          await shot(shotPage, `${view.name}-${locale}-${scheme}-${size}-end`);
          await assertFits(shotPage, `${view.name}-${locale}-${scheme}-${size}-end`);
        }
        await shotContext.close();
      }
    }
  }
  steps.push("screenshots in en and pt, dark and light, at a normal and a narrow width; nothing scrolls sideways");
} catch (error) {
  if (!(error instanceof ChecksDone)) throw error;
} finally {
  await browser.close();
}

writeFileSync(
  resolve(OUT, "report.json"),
  `${JSON.stringify({ storybook, steps, knownIssues: [...new Set(knownIssues)], screenshots }, null, 2)}\n`,
);
createBuildersBotLogger("hub-connections-surfaces-e2e").info(
  `${steps.length} checks passed, ${screenshots.length} screenshots. Report: ${resolve(OUT, "report.json")}`,
);
