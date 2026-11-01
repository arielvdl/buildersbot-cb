// Checks the "Choose for one agent" menu of Settings › Notifications on a server with 45 agents, in the
// stories, with the real components and CSS, in a headless browser. A person with many agents could not
// reach the last agents of that menu: it grew past the bottom of the window, and the shared menu panel
// clipped its overflow (`overflow: hidden`, no maximum height), so neither the wheel nor the trackpad
// scrolled it. In a short window and a narrow one, in both languages, it checks that:
// - the menu opens inside the window, and the wheel scrolls its list to the last agent, which a click
//   then chooses;
// - the search field has the focus, and a search without case or accents finds an agent ("pest codigo"
//   finds "Pest Código"), which Enter chooses; a search with no match says "No agents";
// - the provider chips and the model chips keep only the agents of that provider and model;
// - ArrowDown goes from the search to the first agent, ArrowUp goes around to the last agent and
//   scrolls it into view, and Enter chooses it;
// - Escape closes the menu only, not Settings, and no error halts the page.
// Pass the URL that `bun run storybook` reports:
//
//   bun scripts/agent-picker-e2e.ts --storybook=http://localhost:6006 [--browser-executable=<path>]
//
// Writes .openbot-build/agent-picker-e2e/report.json and a screenshot of each open menu.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { providerDisplayName } from "@openbot/contracts/agent-providers";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-picker-e2e");
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const storybook = argument("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const browserExecutable = argument("browser-executable");

type Locale = "en" | "pt";
type Scheme = "dark" | "light";

interface WindowCase {
  name: string;
  width: number;
  height: number;
  locale: Locale;
  scheme: Scheme;
}

/** A short laptop window and a narrow one: 45 rows are three times their height. */
const WINDOWS: WindowCase[] = [
  { name: "short-1100x560", width: 1100, height: 560, locale: "pt", scheme: "dark" },
  { name: "narrow-720x620", width: 720, height: 620, locale: "en", scheme: "light" },
];

const TEXT = {
  en: { search: "Search agents", empty: "No agents", providers: "Filter agents by provider" },
  pt: { search: "Buscar agentes", empty: "Nenhum agente", providers: "Filtrar agentes por provedor" },
} as const;

/** The agents of the `NotificationsManyAgents` story (SettingsModal.stories.tsx), in its order. */
const NAMES = [
  "Gran Mestre",
  "ferreiro",
  "oraculo",
  "GPT 6.1 Terra",
  "Pest Código",
  ...Array.from({ length: 39 }, (_, index) => `Agente ${String(index + 1).padStart(2, "0")}`),
  "Zé Último",
];
const MODELS = [
  { provider: "claude", model: "claude-opus-5-5" },
  { provider: "codex", model: "gpt-6.1-terra" },
  { provider: "codex", model: "gpt-6.1-sol" },
  { provider: "opencode", model: "glm-5" },
  { provider: "claude", model: "claude-sonnet-5" },
] as const;
const AGENTS = NAMES.map((name, index) => ({ name, ...(MODELS[index % MODELS.length] ?? MODELS[0]) }));

interface MenuCheck {
  window: string;
  trigger: Box;
  menu: Box;
  rows: number;
  steps: string[];
  screenshot: string;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const report: { storybook: string; checks: MenuCheck[]; errors: string[]; failures: string[]; passed: boolean } = {
  storybook,
  checks: [],
  errors: [],
  failures: [],
  passed: false,
};

function storyUrl(window: WindowCase): string {
  return `${storybook}/iframe.html?id=settings-settingsmodal--notifications-many-agents&viewMode=story&globals=locale:${window.locale};colorScheme:${window.scheme}`;
}

/** The trigger in the card of this computer, the first card. */
const trigger = (page: Page) => page.locator(".notification-matrix-add").first();
/** The open menu: the content of the last popper. */
const menu = (page: Page) => page.locator("[data-popper-positioner]").last().locator(":scope > *").first();
/** The rows of the open menu, as options of the new menu or items of a plain menu. */
const rows = (page: Page) => menu(page).locator(":is([role=option], [role=menuitem])");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name }).first();

async function box(locator: Locator): Promise<Box> {
  const rect = await locator.boundingBox();
  assert.ok(rect, "The element has no box.");
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

async function openMenu(page: Page): Promise<void> {
  await trigger(page).scrollIntoViewIfNeeded();
  await trigger(page).click();
  await rows(page).first().waitFor({ state: "visible", timeout: 5_000 });
  // Kobalte places the menu after the next frames.
  await page.waitForTimeout(250);
}

async function waitClosed(page: Page, how: string): Promise<void> {
  await page
    .locator("[data-popper-positioner]")
    .waitFor({ state: "detached", timeout: 5_000 })
    .catch(() => assert.fail(`${how} did not close the menu.`));
}

/** The agent has a level of its own: its row shows in the card, under the server. */
async function waitChosen(page: Page, name: string): Promise<void> {
  await page
    .locator(".notification-matrix-agent .ui-item-title", { hasText: name })
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => assert.fail(`${name} did not get a level of its own.`));
}

/** The menu is in the window, and no higher than the window. */
async function assertInWindow(page: Page, window: WindowCase): Promise<Box> {
  const menuBox = await box(menu(page));
  assert.ok(
    menuBox.y >= 0 && menuBox.y + menuBox.height <= window.height + 1,
    `${window.name}: the menu goes out of the window: ${JSON.stringify(menuBox)}, window height ${window.height}.`,
  );
  assert.ok(
    menuBox.x >= 0 && menuBox.x + menuBox.width <= window.width + 1,
    `${window.name}: the menu goes out of the side of the window: ${JSON.stringify(menuBox)}.`,
  );
  return menuBox;
}

/** The row is inside the menu and the window, and a click at its center lands on it. */
async function assertHittable(page: Page, name: string, window: WindowCase): Promise<void> {
  const result = await row(page, name).evaluate((element, height) => {
    const rect = element.getBoundingClientRect();
    const panel = element.closest("[data-popper-positioner] > *")?.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y)?.closest("[role=option], [role=menuitem]");
    return {
      rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
      panel: panel ? { top: Math.round(panel.top), bottom: Math.round(panel.bottom) } : null,
      inWindow: rect.top >= 0 && rect.bottom <= height,
      inPanel: panel ? rect.top >= panel.top - 1 && rect.bottom <= panel.bottom + 1 : false,
      hit: hit === element,
    };
  }, window.height);
  assert.ok(
    result.inWindow && result.inPanel && result.hit,
    `${window.name}: ${name} cannot be seen or clicked: ${JSON.stringify(result)}.`,
  );
}

/** The names of the rows of the open menu. */
async function rowNames(page: Page): Promise<string[]> {
  return rows(page).evaluateAll((elements) =>
    elements.map(
      (element) =>
        element.querySelector(".agent-picker-name")?.textContent?.trim() ?? element.textContent?.trim() ?? "",
    ),
  );
}

async function check(page: Page, window: WindowCase): Promise<void> {
  const text = TEXT[window.locale];
  const steps: string[] = [];
  await trigger(page).waitFor({ timeout: 240_000 });

  // 1. The menu stays in the window, and the wheel scrolls its list to the last agent.
  await openMenu(page);
  const menuBox = await assertInWindow(page, window);
  const count = await rows(page).count();
  assert.equal(count, AGENTS.length, `${window.name}: the menu has ${count} agents, not ${AGENTS.length}.`);
  const screenshot = resolve(OUT, `open-${window.name}-${window.locale}-${window.scheme}.png`);
  await page.screenshot({ path: screenshot });
  const last = AGENTS.at(-1)?.name ?? "";
  await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height - 24);
  for (let turn = 0; turn < 30; turn += 1) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(200);
  await page.screenshot({ path: resolve(OUT, `scrolled-${window.name}.png`) });
  await assertHittable(page, last, window);
  await row(page, last).click();
  await waitClosed(page, "A click on an agent");
  await waitChosen(page, last);
  steps.push("wheel to the last agent and click");

  // 2. The search field has the focus; case and accents do not count; Enter chooses.
  await openMenu(page);
  await assertInWindow(page, window);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
  assert.equal(focused, text.search, `${window.name}: the search field does not have the focus.`);
  await page.keyboard.type("PEST CODIGO");
  await page.waitForTimeout(100);
  assert.deepEqual(await rowNames(page), ["Pest Código"], `${window.name}: the search did not find Pest Código.`);
  await page.keyboard.press("Enter");
  await waitClosed(page, "Enter in the search");
  await waitChosen(page, "Pest Código");
  steps.push("search without case or accents, Enter");

  // 3. A search with no match says so; Escape closes the menu and keeps Settings open.
  await openMenu(page);
  await page.keyboard.type("zzzz");
  await menu(page)
    .getByText(text.empty, { exact: true })
    .waitFor({ state: "visible", timeout: 2_000 })
    .catch(() => assert.fail(`${window.name}: no "${text.empty}" for a search with no match.`));
  await page.keyboard.press("Escape");
  await waitClosed(page, "Escape");
  assert.ok(await trigger(page).isVisible(), `${window.name}: Escape closed Settings too.`);
  steps.push("empty search, Escape");

  // 4. The provider chips and then the model chips keep only those agents.
  const left = AGENTS.filter((agent) => agent.name !== last && agent.name !== "Pest Código");
  await openMenu(page);
  const providers = menu(page).getByRole("group", { name: text.providers });
  await providers
    .waitFor({ state: "visible", timeout: 2_000 })
    .catch(() => assert.fail(`${window.name}: the menu has no provider filter.`));
  await providers.getByRole("button", { name: new RegExp(`^${providerDisplayName("codex")}\\b`, "u") }).click();
  const codex = left.filter((agent) => agent.provider === "codex").map((agent) => agent.name);
  assert.deepEqual(await rowNames(page), codex, `${window.name}: the Codex chip did not keep the Codex agents.`);
  await menu(page)
    .getByRole("button", { name: /^gpt-6\.1-sol\b/u })
    .click();
  const sol = left.filter((agent) => agent.model === "gpt-6.1-sol").map((agent) => agent.name);
  assert.deepEqual(await rowNames(page), sol, `${window.name}: the model chip did not keep its agents.`);
  const models = await rows(page).evaluateAll((elements) =>
    elements.map((element) => element.querySelector(".agent-picker-model-name")?.textContent?.trim()),
  );
  assert.ok(
    models.every((model) => model === "gpt-6.1-sol"),
    `${window.name}: a row does not show its model: ${JSON.stringify(models)}.`,
  );
  await page.screenshot({ path: resolve(OUT, `filtered-${window.name}.png`) });
  await page.keyboard.press("Escape");
  await waitClosed(page, "Escape after a filter");
  steps.push("provider chip, model chip");

  // 5. ArrowDown goes from the search to the first row; ArrowUp there goes around to the last row,
  //    which scrolls into view; Enter chooses it.
  await openMenu(page);
  await page.keyboard.press("ArrowDown");
  const focusedName = () =>
    page.evaluate(
      () =>
        document.activeElement?.closest("[role=option]")?.querySelector(".agent-picker-name")?.textContent?.trim() ??
        null,
    );
  assert.equal(await focusedName(), left[0]?.name, `${window.name}: ArrowDown did not go to the first row.`);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(250);
  const lastLeft = left.at(-1)?.name ?? "";
  assert.equal(await focusedName(), lastLeft, `${window.name}: ArrowUp from the first row did not go to the last row.`);
  await assertHittable(page, lastLeft, window);
  await page.keyboard.press("Enter");
  await waitClosed(page, "Enter on the last row");
  await waitChosen(page, lastLeft);
  steps.push("arrow keys around to the last agent, Enter");

  report.checks.push({
    window: window.name,
    trigger: await box(trigger(page)),
    menu: menuBox,
    rows: count,
    steps,
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
      await page.goto(storyUrl(window), { waitUntil: "domcontentloaded", timeout: 300_000 });
      await check(page, window);
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
assert.deepEqual(report.failures, [], "The agent picker check found failures.");
