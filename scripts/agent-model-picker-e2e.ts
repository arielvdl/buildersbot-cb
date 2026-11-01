// Checks the model section of the agent dialog of a channel ("New agent"), in the real app on the
// preview mock, with the real CSS, in a headless browser with a new profile. Pass the URL that
// `bun run storybook` reports:
//
//   bun scripts/agent-model-picker-e2e.ts --storybook=http://localhost:6006
//
// The window sizes and interface sizes are the ones of a person who reported the section cut to a
// strip: the interface size is Chromium page zoom, so a window of W x H at 110% is a viewport of
// W/1.1 x H/1.1 CSS pixels at a device scale of 1.1. For each one, the script opens the section and
// checks that every control in it can be seen and hit (no ancestor clips it and nothing covers it),
// also when the provider check answers after the section opened. Then it chooses a provider, a
// model and an effort, and checks the closed row shows them. `--keep-going` records a failed case
// and goes on, to take the screenshots of every case before it fails.
//
// Writes .openbot-build/agent-model-picker-e2e/report.json and one screenshot per state.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";

const logger = createBuildersBotLogger("agent-model-picker-e2e");
const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-model-picker-e2e");
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const storybook = argument("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const keepGoing = process.argv.includes("--keep-going");
/** Runs only the cases whose name holds one of these comma-separated parts. */
const only = argument("only")?.split(",") ?? null;

type Locale = "en" | "pt";
type Scheme = "dark" | "light";

interface WindowCase {
  name: string;
  width: number;
  height: number;
  zoom: number;
}

/** The window of the report at 110%, the same at 100% and 130%, a short window and a narrow one. */
const WINDOWS: WindowCase[] = [
  { name: "1280x800-100", width: 1280, height: 800, zoom: 1 },
  { name: "1280x800-110", width: 1280, height: 800, zoom: 1.1 },
  { name: "1280x800-130", width: 1280, height: 800, zoom: 1.3 },
  { name: "short-1280x600-110", width: 1280, height: 600, zoom: 1.1 },
  { name: "short-1280x600-130", width: 1280, height: 600, zoom: 1.3 },
  { name: "narrow-640x760-110", width: 640, height: 760, zoom: 1.1 },
];

const TEXT = {
  en: {
    model: /^Agent model: /u,
    providers: "Model providers",
    efforts: "Agent reasoning effort",
    others: /^Other providers/u,
    claude: /^Claude\b/u,
    opus: "Claude Opus 5.5",
    effort: "Low",
    download: "Download",
    connect: "Connect",
  },
  pt: {
    model: /^Modelo do agente: /u,
    providers: "Provedores de modelos",
    efforts: "Esforço de raciocínio do agente",
    others: /^Outros provedores/u,
    claude: /^Claude\b/u,
    opus: "Claude Opus 5.5",
    effort: "Baixo",
    download: "Baixar",
    connect: "Conectar",
  },
} as const;

function storyUrl(story: string, locale: Locale, scheme: Scheme): string {
  return `${storybook}/iframe.html?id=${story}&viewMode=story&globals=locale:${locale};colorScheme:${scheme}`;
}

const screenshots: string[] = [];
const results: { name: string; ok: boolean; detail: string }[] = [];
mkdirSync(OUT, { recursive: true });

async function shot(page: Page, name: string): Promise<void> {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  screenshots.push(path);
}

/**
 * Each element can be seen and hit: after it scrolls into the middle of its scroll box, its center
 * and a point near the middle of each edge hit the element itself. A point that an ancestor clips,
 * or that another element covers (the next field, the sticky footer), hits something else. A radio
 * input is drawn by its item, so the item is the one that is hit.
 */
async function hiddenParts(elements: Locator, scroll = true): Promise<string[]> {
  return elements.evaluateAll((nodes, scrollFirst) => {
    const problems: string[] = [];
    for (const node of nodes) {
      const target =
        node instanceof HTMLInputElement && node.type === "radio"
          ? (node.closest("[role=radio], label, div") ?? node)
          : node;
      // Only the boxes that the user scrolls move, from the inner one out: scrollIntoView would also
      // scroll the frame of the dialog, which clips its overflow, and hide a part that the user
      // cannot reach.
      for (let scroller = scrollFirst ? target.parentElement : null; scroller; scroller = scroller.parentElement) {
        if (!/^(auto|scroll)$/u.test(getComputedStyle(scroller).overflowY)) continue;
        const port = scroller.getBoundingClientRect();
        const own = target.getBoundingClientRect();
        scroller.scrollTop += own.top + own.height / 2 - (port.top + port.height / 2);
      }
      const box = target.getBoundingClientRect();
      const name = (target.getAttribute("aria-label") ?? target.textContent ?? "").trim().slice(0, 40);
      if (box.width < 4 || box.height < 4) {
        problems.push(`${name}: ${Math.round(box.width)}x${Math.round(box.height)}`);
        continue;
      }
      const inset = Math.min(3, box.width / 4, box.height / 4);
      const middleX = box.left + box.width / 2;
      const middleY = box.top + box.height / 2;
      const points = [
        [middleX, middleY],
        [middleX, box.top + inset],
        [middleX, box.bottom - inset],
        [box.left + inset, middleY],
        [box.right - inset, middleY],
      ] as const;
      for (const [x, y] of points) {
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === target || target.contains(hit))) continue;
        const what = hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join(".")}` : "nothing";
        problems.push(`${name}: (${Math.round(x)}, ${Math.round(y)}) hits ${what}`);
        break;
      }
    }
    return problems;
  }, scroll);
}

/**
 * How much of the picker the form shows right after it opens, between its top and the footer. A
 * picker taller than the form starts one scroll margin under the top of the form, so the field
 * above it stays in sight.
 */
async function shownAfterOpen(trigger: Locator): Promise<{ shown: number; needed: number }> {
  return trigger.evaluate((button) => {
    const picker = button.parentElement ?? button;
    const form = button.closest("form");
    const footer = form?.querySelector("footer");
    if (!form) return { shown: 0, needed: 1 };
    const port = form.getBoundingClientRect();
    const bottom = footer ? footer.getBoundingClientRect().top : port.bottom;
    const margin = Number.parseFloat(getComputedStyle(picker).scrollMarginTop) || 0;
    const box = picker.getBoundingClientRect();
    const shown = Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, port.top));
    const room = bottom - port.top - margin;
    return { shown: Math.round(shown), needed: Math.round(Math.min(box.height, room) - 2) };
  });
}

async function openDialog(page: Page, url: string, locale: Locale) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300_000 });
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 240_000 });
  const trigger = dialog.getByRole("button", { name: TEXT[locale].model });
  await trigger.waitFor({ timeout: 60_000 });
  return { dialog, trigger };
}

/** The controls of the open section: the providers, the models, the efforts. */
function sectionControls(page: Page, locale: Locale) {
  const providers = page.getByRole("tablist", { name: TEXT[locale].providers }).getByRole("tab");
  const models = page.getByRole("listbox").getByRole("option");
  const efforts = page.getByRole("radiogroup", { name: TEXT[locale].efforts }).getByRole("radio");
  return { providers, models, efforts };
}

async function checkSection(page: Page, trigger: Locator, locale: Locale, label: string): Promise<void> {
  const { providers, models, efforts } = sectionControls(page, locale);
  await models.first().waitFor({ timeout: 30_000 });
  // The dialog that holds the row: a popover of the picker is a dialog too.
  const frame = await trigger.evaluate((button) => button.closest("[role=dialog]")?.scrollTop ?? 0);
  assert.equal(frame, 0, `${label}: the frame of the dialog scrolled, so its header or footer moved.`);
  const shown = await shownAfterOpen(trigger);
  assert.ok(
    shown.shown >= shown.needed,
    `${label}: the form shows ${shown.shown}px of the open section, not ${shown.needed}px.`,
  );
  const problems = [...(await hiddenParts(providers)), ...(await hiddenParts(models)), ...(await hiddenParts(efforts))];
  assert.deepEqual(problems, [], `${label}: a part of the model section cannot be seen or hit.`);
  assert.ok((await providers.count()) >= 4, `${label}: the section lists fewer than four ready providers.`);
  assert.ok((await efforts.count()) >= 2, `${label}: the section shows no effort choice.`);
}

async function runCase(browser: Browser, window: WindowCase, locale: Locale, scheme: Scheme, full: boolean) {
  const label = `${window.name}-${locale}-${scheme}`;
  const context = await browser.newContext({
    viewport: { width: Math.round(window.width / window.zoom), height: Math.round(window.height / window.zoom) },
    deviceScaleFactor: window.zoom,
    locale: locale === "pt" ? "pt-BR" : "en-US",
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    const { dialog, trigger } = await openDialog(
      page,
      storyUrl("channels-member-dialog--new-agent", locale, scheme),
      locale,
    );
    await shot(page, `${label}-closed`);
    await trigger.click();
    await page.waitForFunction(
      (button) => button?.getAttribute("aria-expanded") === "true",
      await trigger.elementHandle(),
    );
    await sectionControls(page, locale).models.first().waitFor({ timeout: 30_000 });
    await shot(page, `${label}-open`);
    await checkSection(page, trigger, locale, label);
    if (!full) return;

    // The other providers are listed apart, each with the action it needs.
    const others = dialog.getByRole("button", { name: TEXT[locale].others });
    await others.click();
    const download = dialog.getByRole("button", { name: TEXT[locale].download });
    const connect = dialog.getByRole("button", { name: TEXT[locale].connect });
    await download.first().waitFor();
    await connect.first().waitFor();
    assert.deepEqual(
      [...(await hiddenParts(download)), ...(await hiddenParts(connect))],
      [],
      `${label}: an action of the other providers cannot be seen or hit.`,
    );
    await shot(page, `${label}-others`);

    // A provider, a model and an effort, chosen with the pointer; the closed row shows them.
    const { providers, models } = sectionControls(page, locale);
    await providers.filter({ hasText: TEXT[locale].claude }).click();
    await models.filter({ hasText: TEXT[locale].opus }).click();
    // The segment is what the pointer presses; its radio input is drawn by it.
    const efforts = page.getByRole("radiogroup", { name: TEXT[locale].efforts });
    await efforts.getByText(TEXT[locale].effort, { exact: true }).click();
    await page.waitForFunction(
      (input) => input instanceof HTMLInputElement && input.checked,
      await efforts.getByRole("radio", { name: TEXT[locale].effort, exact: true }).elementHandle(),
    );
    await shot(page, `${label}-chosen`);
    await trigger.click();
    await page.waitForFunction(
      (button) => button?.getAttribute("aria-expanded") === "false",
      await trigger.elementHandle(),
    );
    const row = await trigger.innerText();
    assert.match(
      row,
      new RegExp(TEXT[locale].opus.replace(".", "\\.")),
      `${label}: the closed row does not show the model.`,
    );
    assert.match(row, new RegExp(TEXT[locale].effort), `${label}: the closed row does not show the effort.`);
    assert.ok(
      (await trigger.getAttribute("aria-label"))?.endsWith(`: ${TEXT[locale].opus} · ${TEXT[locale].effort}`),
      `${label}: the name of the row is not the model and the effort.`,
    );
    await shot(page, `${label}-closed-after-choice`);

    // The keyboard: the row opens with Enter, Tab goes into the section, Escape closes only the
    // section, and the focus goes back to the row. The dialog stays open.
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (button) => button?.getAttribute("aria-expanded") === "true",
      await trigger.elementHandle(),
    );
    await page.keyboard.press("Tab");
    const focusedTab = () =>
      page.evaluate(() => ({
        role: document.activeElement?.getAttribute("role"),
        name: document.activeElement?.textContent?.trim(),
        selected: document.activeElement?.getAttribute("aria-selected"),
      }));
    const first = await focusedTab();
    assert.equal(first.role, "tab", `${label}: Tab after the row does not go to the providers.`);
    await page.keyboard.press("ArrowRight");
    const next = await focusedTab();
    assert.ok(
      next.role === "tab" && next.name !== first.name && next.selected === "true",
      `${label}: ArrowRight does not choose the next provider: ${JSON.stringify({ first, next })}.`,
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      (button) => button?.getAttribute("aria-expanded") === "false",
      await trigger.elementHandle(),
    );
    assert.equal(await dialog.isVisible(), true, `${label}: Escape in the section closed the dialog.`);
    assert.equal(
      await trigger.evaluate((button) => document.activeElement === button),
      true,
      `${label}: Escape did not give the focus back to the row.`,
    );
  } finally {
    await context.close();
  }
}

/** The provider check answers after the section opened: the cards arrive in an open section. */
async function runLateAnswer(browser: Browser, window: WindowCase, locale: Locale, scheme: Scheme) {
  const label = `late-${window.name}-${locale}-${scheme}`;
  const context = await browser.newContext({
    viewport: { width: Math.round(window.width / window.zoom), height: Math.round(window.height / window.zoom) },
    deviceScaleFactor: window.zoom,
    locale: locale === "pt" ? "pt-BR" : "en-US",
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    const { trigger } = await openDialog(
      page,
      storyUrl("channels-member-dialog--providers-answer-after-open", locale, scheme),
      locale,
    );
    await trigger.click();
    await shot(page, `${label}-checking`);
    await checkSection(page, trigger, locale, label);
    await shot(page, `${label}-answered`);
  } finally {
    await context.close();
  }
}

/** The section alone, in each of its stories: what it shows, and that each part can be seen and hit. */
const PICKER_STORIES = [
  { id: "inline-closed", open: false },
  { id: "inline-open", open: true },
  { id: "inline-checking", open: true },
  { id: "inline-provider-not-downloaded", open: true },
  { id: "inline-many-models", open: true },
  { id: "inline-narrow", open: true },
] as const;

async function runPickerStory(
  browser: Browser,
  story: (typeof PICKER_STORIES)[number],
  locale: Locale,
  scheme: Scheme,
): Promise<void> {
  const label = `story-${story.id}-${locale}-${scheme}`;
  const context = await browser.newContext({
    viewport: { width: 640, height: 900 },
    locale: locale === "pt" ? "pt-BR" : "en-US",
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await page.goto(storyUrl(`conversation-providermodelpicker--${story.id}`, locale, scheme), {
      waitUntil: "domcontentloaded",
      timeout: 300_000,
    });
    const trigger = page.getByRole("button", { name: /^Agent model: / });
    await trigger.waitFor({ timeout: 120_000 });
    assert.equal(await trigger.getAttribute("aria-expanded"), story.open ? "true" : "false", `${label}: open state.`);
    const box = page.locator(".channel-member-runtime");
    if (story.open) {
      const { providers, models } = sectionControls(page, locale);
      await providers.first().waitFor();
      const others = page.getByRole("button", { name: TEXT[locale].others });
      if (await others.count()) await others.click();
      assert.deepEqual(
        [
          ...(await hiddenParts(providers)),
          ...(await hiddenParts(models)),
          ...(await hiddenParts(page.getByRole("radiogroup").getByRole("radio"))),
          ...(await hiddenParts(others)),
          ...(await hiddenParts(page.getByRole("searchbox").or(page.getByRole("textbox")))),
        ],
        [],
        `${label}: a part of the section cannot be seen or hit.`,
      );
      if (story.id === "inline-many-models") {
        assert.equal(await page.getByRole("textbox").count(), 1, `${label}: a long list has no search.`);
      } else {
        assert.equal(await page.getByRole("textbox").count(), 0, `${label}: a short list shows a search.`);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    const path = resolve(OUT, `${label}.png`);
    await box.screenshot({ path, animations: "disabled" });
    screenshots.push(path);
  } finally {
    await context.close();
  }
}

/**
 * The other places that use the picker, which keep its popover: the composer, the agent settings,
 * the first agent of the setup. Its panel opens in full there too.
 */
const CONSUMERS = [
  // The real app: the model pill of the composer header, in a window as wide as the app needs.
  { name: "composer-pill", story: "app--playground", width: 1440, height: 900, zoom: 1 },
  { name: "first-agent-setup", story: "setup-firstagentsetup--model-picker", width: 1280, height: 800, zoom: 1.1 },
  // The field popover in a settings card, as the agent settings show it.
  {
    name: "settings-field-popover",
    story: "conversation-providermodelpicker--field-popover",
    width: 1280,
    height: 800,
    zoom: 1.1,
  },
] as const;

async function runConsumer(browser: Browser, consumer: (typeof CONSUMERS)[number]): Promise<void> {
  const label = `consumer-${consumer.name}`;
  const context = await browser.newContext({
    viewport: {
      width: Math.round(consumer.width / consumer.zoom),
      height: Math.round(consumer.height / consumer.zoom),
    },
    deviceScaleFactor: consumer.zoom,
    locale: "en-US",
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await page.goto(storyUrl(consumer.story, "en", "dark"), { waitUntil: "domcontentloaded", timeout: 300_000 });
    const trigger = page.locator(".provider-model-trigger").first();
    await trigger.waitFor({ timeout: 240_000 });
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    const panel = page.locator(".provider-model-popover");
    await panel.getByRole("tab").first().waitFor({ timeout: 30_000 });
    await shot(page, label);
    // The popover is placed against its row: scrolling the page under it would test a stale place.
    // A provider with no story models shows its empty state, so the options are checked when there are some.
    assert.deepEqual(
      [...(await hiddenParts(panel.getByRole("tab"), false)), ...(await hiddenParts(panel.getByRole("option"), false))],
      [],
      `${label}: a part of the picker cannot be seen or hit.`,
    );
  } finally {
    await context.close();
  }
}

async function record(name: string, run: () => Promise<void>): Promise<void> {
  if (only && !only.some((part) => name.includes(part))) return;
  try {
    await run();
    results.push({ name, ok: true, detail: "" });
    logger.info("Case passed.", { name });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    logger.warn("Case failed.", { name, detail });
    if (!keepGoing) throw error;
  }
}

const browser: Browser = await chromium.launch({ headless: true });
try {
  for (const window of WINDOWS) {
    await record(`${window.name}-en-dark`, () => runCase(browser, window, "en", "dark", true));
  }
  const report = WINDOWS[1];
  assert.ok(report);
  await record("pt-light", () => runCase(browser, report, "pt", "light", true));
  await record("pt-dark", () => runCase(browser, report, "pt", "dark", false));
  await record("en-light", () => runCase(browser, report, "en", "light", false));
  for (const window of [report, WINDOWS[4]]) {
    if (window) await record(`late-${window.name}`, () => runLateAnswer(browser, window, "en", "dark"));
  }
  for (const story of PICKER_STORIES) {
    for (const [locale, scheme] of [
      ["en", "dark"],
      ["pt", "light"],
      ["en", "light"],
      ["pt", "dark"],
    ] as const) {
      await record(`story-${story.id}-${locale}-${scheme}`, () => runPickerStory(browser, story, locale, scheme));
    }
  }
  for (const consumer of CONSUMERS) await record(`consumer-${consumer.name}`, () => runConsumer(browser, consumer));
} finally {
  await browser.close();
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ storybook, results, screenshots }, null, 2)}\n`);
}

const failed = results.filter((result) => !result.ok);
assert.deepEqual(failed, [], `${failed.length} of ${results.length} cases failed.`);
logger.info("Agent model picker E2E passed.", { cases: results.length, report: resolve(OUT, "report.json") });
