// Checks the select lists of Settings in the stories, with the real components and CSS, in a headless
// browser. The model list of the Guard page has keys with quotes (`["cultura-builder","…"]`). Kobalte
// found the active row with an unescaped `[data-key="…"]` selector, so opening that list threw, the
// error halted the reactive system of the window, and the list stayed at the top corner of the page and
// could not close (patches/@kobalte%2Fcore@2.0.0-alpha.0.patch now escapes the key). For the Guard's
// model list and level list, and for the Dictation language and Update track lists of two other tabs, in
// wide, narrow and phone windows, it checks that:
// - the list opens next to its trigger, inside the window, no higher than the space, with its own scroll;
// - Escape, a click outside and a choice each close it, and the focus goes back to the trigger;
// - the keyboard opens it, moves in it and chooses;
// - no error halts the page.
// Pass the URL that `bun run storybook` reports:
//
//   bun scripts/settings-select-e2e.ts --storybook=http://localhost:6006 [--browser-executable=<path>]
//
// Writes .openbot-build/settings-select-e2e/report.json and a screenshot of each open list.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/settings-select-e2e");
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const storybook = argument("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const browserExecutable = argument("browser-executable");

type Locale = "en" | "pt";
type Scheme = "dark" | "light";

interface Window {
  name: string;
  width: number;
  height: number;
  locale: Locale;
  scheme: Scheme;
}

const WINDOWS: Window[] = [
  { name: "wide", width: 1200, height: 820, locale: "pt", scheme: "dark" },
  { name: "narrow", width: 640, height: 720, locale: "en", scheme: "light" },
  { name: "phone", width: 420, height: 760, locale: "pt", scheme: "dark" },
];

/** The trigger names, as `aria-label` reads in each language. */
const NAMES = {
  guardModel: { en: "Review model", pt: "Modelo de revisão" },
  guardLevel: { en: "Level", pt: "Nível" },
  dictationLanguage: { en: "Dictation language", pt: "Idioma do ditado" },
  updateTrack: { en: "Update track", pt: "Canal de atualização" },
} as const;

/** The most pixels between a trigger and its list: the gutter of `Select` is 4. */
const MAX_GAP = 12;

interface ListCheck {
  window: string;
  list: string;
  trigger: { x: number; y: number; width: number; height: number };
  content: { x: number; y: number; width: number; height: number };
  scrolls: boolean;
  closedBy: string[];
  chose: string;
  screenshot: string;
}

const report: {
  storybook: string;
  checks: ListCheck[];
  errors: string[];
  failures: string[];
  passed: boolean;
} = { storybook, checks: [], errors: [], failures: [], passed: false };

function storyUrl(story: string, window: Window): string {
  return `${storybook}/iframe.html?id=settings-settingsmodal--${story}&viewMode=story&globals=locale:${window.locale};colorScheme:${window.scheme}`;
}

const trigger = (page: Page, name: string) => page.locator(`.ui-select-trigger[aria-label="${name}"]`);
const openList = (page: Page) => page.locator("[data-popper-positioner] .ui-select-content");

async function isFocused(page: Page, name: string): Promise<boolean> {
  return page.evaluate((label) => document.activeElement?.getAttribute("aria-label") === label, name);
}

async function waitClosed(page: Page, name: string, how: string): Promise<void> {
  await openList(page).waitFor({ state: "detached", timeout: 5_000 });
  await page.waitForFunction(
    (label) =>
      document.querySelector(`.ui-select-trigger[aria-label="${label}"]`)?.getAttribute("aria-expanded") === "false",
    name,
    { timeout: 5_000 },
  );
  await page.waitForFunction((label) => document.activeElement?.getAttribute("aria-label") === label, name, {
    timeout: 5_000,
  });
  assert.ok(await isFocused(page, name), `${how} did not give the focus back to ${name}.`);
}

/** The list is open next to its trigger, inside the window, and no higher than the space it has. */
async function assertPlaced(page: Page, name: string, window: Window) {
  const content = openList(page);
  await content.waitFor({ state: "visible", timeout: 5_000 });
  // Kobalte places the list after the next frames; the list then stays where it is.
  await page
    .waitForFunction(
      (label) => {
        const list = document.querySelector("[data-popper-positioner] .ui-select-content")?.getBoundingClientRect();
        const anchor = document.querySelector(`.ui-select-trigger[aria-label="${label}"]`)?.getBoundingClientRect();
        if (!list || !anchor) return false;
        const below = list.top - anchor.bottom;
        const above = anchor.top - list.bottom;
        return (below >= 0 && below <= 12) || (above >= 0 && above <= 12);
      },
      name,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  const geometry = await page.evaluate((label) => {
    const box = (element: Element | null | undefined) => {
      const rect = element?.getBoundingClientRect();
      return rect
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        : null;
    };
    const list = document.querySelector<HTMLElement>("[data-popper-positioner] .ui-select-content");
    return {
      trigger: box(document.querySelector(`.ui-select-trigger[aria-label="${label}"]`)),
      content: box(list),
      scrolls: list ? list.scrollHeight > list.clientHeight + 1 : false,
      overflowY: list ? getComputedStyle(list).overflowY : "",
      options: list?.querySelectorAll("[role=option]").length ?? 0,
    };
  }, name);
  assert.ok(geometry.trigger && geometry.content, `${name}: no trigger or no list.`);
  const { trigger: anchor, content: list } = geometry;
  const below = list.y - (anchor.y + anchor.height);
  const above = anchor.y - (list.y + list.height);
  assert.ok(
    (below >= 0 && below <= MAX_GAP) || (above >= 0 && above <= MAX_GAP),
    `${window.name}: the ${name} list is not next to its trigger: ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    list.x < anchor.x + anchor.width && list.x + list.width > anchor.x,
    `${window.name}: the ${name} list is not under or over its trigger: ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    list.y >= 0 && list.y + list.height <= window.height && list.x >= 0 && list.x + list.width <= window.width,
    `${window.name}: the ${name} list goes out of the window: ${JSON.stringify(geometry)}`,
  );
  if (geometry.scrolls) {
    assert.match(geometry.overflowY, /auto|scroll/u, `${window.name}: the ${name} list is cut but does not scroll.`);
  }
  return { trigger: anchor, content: list, scrolls: geometry.scrolls };
}

async function checkList(
  page: Page,
  window: Window,
  options: { name: string; label: string; choose: string | RegExp | "current" },
): Promise<void> {
  const { name } = options;
  const button = trigger(page, name);
  await button.scrollIntoViewIfNeeded();
  const closedBy: string[] = [];

  // A pointer opens it; Escape closes it.
  await button.click();
  const geometry = await assertPlaced(page, name, window);
  const screenshot = resolve(OUT, `${options.label}-${window.name}-${window.locale}-${window.scheme}.png`);
  await page.screenshot({ path: screenshot });
  await page.keyboard.press("Escape");
  await waitClosed(page, name, "Escape");
  closedBy.push("Escape");

  // A click outside closes it.
  await button.click();
  await assertPlaced(page, name, window);
  await page.mouse.click(4, window.height - 4);
  await waitClosed(page, name, "A click outside").catch(async () => {
    // A click outside keeps the focus where it lands, which is not the trigger: only the close counts.
    await openList(page).waitFor({ state: "detached", timeout: 5_000 });
  });
  closedBy.push("click outside");

  // A choice closes it, and the trigger shows the choice.
  await button.click();
  await assertPlaced(page, name, window);
  const option =
    options.choose === "current"
      ? openList(page).locator("[role=option][aria-selected=true]").first()
      : openList(page).getByRole("option", { name: options.choose }).first();
  const chosen = (await option.textContent())?.trim() ?? "";
  await option.click();
  await waitClosed(page, name, "A choice");
  await page.waitForFunction(
    ({ label, text }) =>
      document.querySelector(`.ui-select-trigger[aria-label="${label}"]`)?.textContent?.includes(text) ?? false,
    { label: name, text: chosen.slice(0, 12) },
    { timeout: 5_000 },
  );
  closedBy.push("choice");

  // The keyboard opens it, moves and chooses. A list that changes the page itself keeps its value.
  await button.focus();
  await page.keyboard.press("ArrowDown");
  await assertPlaced(page, name, window);
  if (options.choose !== "current") await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await waitClosed(page, name, "Enter");
  closedBy.push("keyboard");

  report.checks.push({
    window: window.name,
    list: options.label,
    trigger: geometry.trigger,
    content: geometry.content,
    scrolls: geometry.scrolls,
    closedBy,
    chose: chosen,
    screenshot,
  });
}

async function run(browser: Browser): Promise<void> {
  for (const window of WINDOWS) {
    const context = await browser.newContext({
      viewport: { width: window.width, height: window.height },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(`${window.name}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") report.errors.push(`${window.name}: ${message.text().slice(0, 400)}`);
    });
    try {
      await page.goto(storyUrl("guard", window), { waitUntil: "domcontentloaded", timeout: 300_000 });
      const model = NAMES.guardModel[window.locale];
      const level = NAMES.guardLevel[window.locale];
      await trigger(page, model).waitFor({ timeout: 240_000 });
      // The settings pane scrolls; the row is then lower in the pane than at first.
      await page.evaluate(() => document.querySelector(".settings-modal-content")?.scrollBy(0, 40));
      await checkList(page, window, { name: model, label: "guard-model", choose: /GPT-6-Sol/u });
      await checkList(page, window, {
        name: level,
        label: "guard-level",
        choose: window.locale === "pt" ? "Leve" : "Light",
      });
      if (window.name !== "phone") {
        // Two lists of other tabs, which never had the bug, so a change of the shared layer shows there too.
        await page.goto(storyUrl("voice-whisper-hungarian", window), {
          waitUntil: "domcontentloaded",
          timeout: 300_000,
        });
        const language = NAMES.dictationLanguage[window.locale];
        await trigger(page, language).waitFor({ timeout: 240_000 });
        await checkList(page, window, { name: language, label: "voice-language", choose: "current" });
        await page.goto(storyUrl("scheduled-remote-update", window), {
          waitUntil: "domcontentloaded",
          timeout: 300_000,
        });
        const track = NAMES.updateTrack[window.locale];
        await trigger(page, track).waitFor({ timeout: 240_000 });
        await checkList(page, window, { name: track, label: "updates-track", choose: "current" });
      }
    } catch (error) {
      report.failures.push(error instanceof Error ? error.message : String(error));
      await page.screenshot({ path: resolve(OUT, `failure-${window.name}.png`) }).catch(() => undefined);
    } finally {
      await context.close();
    }
  }
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), headless: true } : { headless: true },
);
try {
  await run(browser);
} finally {
  await browser.close();
}
const halted = report.errors.filter((error) => /REACTIVITY_HALTED|not a valid selector/u.test(error));
if (halted.length > 0) report.failures.push(`An error halted the page: ${halted[0]}`);
report.passed = report.failures.length === 0;
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.deepEqual(report.failures, [], "The settings select check found failures.");
