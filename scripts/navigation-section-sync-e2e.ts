// Checks that a chat that opens from outside the sidebar brings the whole navigation with it, in the
// real app on the preview mock (story "App / Section Rail View"), in a headless browser with a new
// profile, in the language that the app shows. Pass the URL that `bun run storybook` reports:
//
//   bun scripts/navigation-section-sync-e2e.ts --storybook=http://localhost:6006
//
// The fixture has the sections "naia" (Chief) and "Red Team" (Research, Sales Outbound), and two
// channels with the same name "Ops", one in each section. The script checks that:
// 1. a global search agent result selects the agent's section in the rail and marks its row in view;
// 2. a channel result opens the channel of the right section, also when another channel has its name;
// 3. a message result of an agent's own chat opens that tab, also when a side thread was open, and the
//    composer then sends to the agent's own chat;
// 4. a result in a collapsed section opens that section, and a result that the activity filter hides
//    turns the filter off;
// 5. Back selects the section of the chat it opens;
// 6. each tab of a channel keeps its own draft, and a channel that opens from search opens on the tab
//    that the reader last had open;
// 7. after a reload of the renderer, the channel opens on that tab again with each tab's draft.
// `--keep-going` records a failed step and goes on. `--browser-executable=<path>` names a Chromium build
// when Playwright has not downloaded its own.
//
// Writes .openbot-build/navigation-section-sync-e2e/report.json and one screenshot per step.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";
import { TRANSLATED_LOCALES, translateFor } from "@openbot/i18n";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";

declare global {
  interface Window {
    openbot: BuildersBotDesktopApi;
  }
}

const OUT = resolve(import.meta.dirname, "../.openbot-build/navigation-section-sync-e2e");
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const storybook = argument("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const keepGoing = process.argv.includes("--keep-going");
/** A Chromium build to use when Playwright has not downloaded its own. */
const browserExecutable = argument("browser-executable");
/** The interface text, in the language that the app shows. The preview follows its own setting. */
let text = translateFor("en");
const UI_WAIT_MS = 15_000;

const NAIA = "61111111-1111-4111-8111-111111111111";
const RED_TEAM = "62222222-2222-4222-8222-222222222222";
const OPS_RED = "7a111111-1111-4111-8111-111111111111";
const OPS_NAIA = "7b222222-2222-4222-8222-222222222222";
const SECOND_TAB = "openbot-topic-e2e-second";
/** A sentence of Research's own chat in the preview fixtures. */
const RESEARCH_MESSAGE = "benchmark table";

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}
const results: StepResult[] = [];
const screenshots: string[] = [];
const pageErrors: string[] = [];
mkdirSync(OUT, { recursive: true });

async function step(page: Page, name: string, run: () => Promise<string | undefined>): Promise<void> {
  process.stdout.write(`- ${name}\n`);
  try {
    const detail = (await run()) ?? "";
    results.push({ name, ok: true, detail });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    process.stdout.write(`  FAILED: ${detail}\n`);
    // A dialog that stays open hides the rest of the window from the next step.
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
    if (!keepGoing) throw error;
  } finally {
    const path = resolve(OUT, `${String(results.length).padStart(2, "0")}-${name.replace(/\W+/g, "-")}.png`);
    await page.screenshot({ path }).catch(() => undefined);
    screenshots.push(path);
  }
}

/** Reads `read` again until `ready` accepts it. */
async function waitFor<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + UI_WAIT_MS;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}. Last value: ${JSON.stringify(value)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rail = (page: Page) => page.getByRole("navigation", { name: text("sidebar.sectionRail.label") });
const railItem = (page: Page, name: string) =>
  rail(page).getByRole("button", { name: new RegExp(`^${literal(name)}(,|$)`) });
const nav = (page: Page) => page.getByRole("navigation", { name: text("sidebar.nav.label") });
const row = (page: Page, name: string) =>
  nav(page)
    .getByRole("button", { name: new RegExp(`^${literal(name)}\\b`) })
    .first();

/** The rail item that is selected, by name. */
async function selectedRailSection(page: Page): Promise<string | null> {
  const selected = rail(page).locator('button[aria-pressed="true"]');
  return (await selected.count()) === 0 ? null : await selected.first().getAttribute("aria-label");
}

/** Whether a row of that name is the open chat, and the list shows it in its visible area. */
async function rowShown(page: Page, name: string): Promise<{ pressed: boolean; inView: boolean }> {
  const target = nav(page).getByRole("button", { name: new RegExp(`^${literal(name)}\\b`), pressed: true });
  if ((await target.count()) === 0) return { pressed: false, inView: false };
  const inView = await target.first().evaluate((element) => {
    const list = element.closest("nav");
    if (!list) return false;
    const box = element.getBoundingClientRect();
    const area = list.getBoundingClientRect();
    return box.height > 0 && box.top >= area.top - 1 && box.bottom <= area.bottom + 1;
  });
  return { pressed: true, inView };
}

async function openSearch(page: Page, query: string, tab: "agents" | "channels" | "messages"): Promise<Locator> {
  await page
    .getByRole("button", { name: text("conversation.globalSearch.title") })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByRole("combobox", { name: text("conversation.globalSearch.title") });
  // The search loads on first use, which can take a while on a busy computer.
  await input.waitFor({ timeout: 120_000 });
  // With a section selected in the rail, the search keeps only that section until "All sections".
  const all = dialog.getByRole("tab", { name: text("conversation.globalSearch.scope.all") });
  if ((await all.count()) > 0) {
    await all.click();
    await waitFor(
      "all sections",
      () => all.getAttribute("aria-selected"),
      (value) => value === "true",
    );
  }
  await dialog.getByRole("tab", { name: text(`conversation.globalSearch.tab.${tab}`), exact: true }).click();
  await input.fill(query);
  return dialog;
}

async function chooseResult(dialog: Locator, text: string): Promise<void> {
  const option = dialog.getByRole("option").filter({ hasText: text }).first();
  await option.waitFor({ timeout: UI_WAIT_MS });
  await option.click();
  await dialog.waitFor({ state: "hidden", timeout: UI_WAIT_MS });
}

async function selectRail(page: Page, name: string | null): Promise<void> {
  const item = railItem(page, name ?? text("sidebar.sectionRail.all"));
  if ((await item.getAttribute("aria-pressed")) !== "true") await item.click();
}

/** The visible composer: the agent's own chat, a side thread or a channel. */
const composer = (page: Page) => page.locator('[role="textbox"][contenteditable="true"]:visible');

async function typeDraft(page: Page, text: string): Promise<void> {
  await composer(page).click();
  await page.keyboard.type(text);
}

const composerText = (page: Page) => composer(page).evaluate((element) => element.textContent?.trim() ?? "");

/** The tab in the channel header. The tab strip of the sidebar row, when open, comes first. */
const channelTab = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).last();

/** The channels, their sections and the second tab, made through the preview bridge. */
async function seed(page: Page): Promise<void> {
  await page.evaluate(
    async (input) => {
      const save = (channelId: string, name: string, members: string[]) =>
        window.openbot.agent.channelCommand({
          type: "save",
          operationId: crypto.randomUUID(),
          channelId,
          draft: {
            name,
            title: "",
            instructions: "",
            members: members.map((agentId) => ({ agentId })),
            leadAgentId: members[0] ?? null,
          },
        });
      await save(input.opsRed, "Ops", ["sales"]);
      await save(input.opsNaia, "Ops", ["chief"]);
      await window.openbot.agent.channelCommand({
        type: "send",
        operationId: crypto.randomUUID(),
        channelId: input.opsRed,
        text: "red room note",
        recipientAgentId: null,
        replyToMessageId: null,
        attachmentDraftIds: [],
      });
      await window.openbot.agent.channelCommand({
        type: "topic-create",
        operationId: crypto.randomUUID(),
        channelId: input.opsRed,
        topicId: input.secondTab,
        name: "Second",
      });
      for (const [agentId, sectionId] of [
        ["research", input.redTeam],
        [input.opsRed, input.redTeam],
        [input.opsNaia, input.naia],
      ] as const)
        await window.openbot.agent.mutateSidebarLayout({ type: "assign", agentId, sectionId });
    },
    { opsRed: OPS_RED, opsNaia: OPS_NAIA, secondTab: SECOND_TAB, redTeam: RED_TEAM, naia: NAIA },
  );
  await row(page, "Ops").waitFor({ timeout: UI_WAIT_MS });
}

/** Waits for the app, and reads the language that it shows. */
async function openApp(page: Page): Promise<void> {
  await composer(page).first().waitFor({ timeout: 900_000 });
  const lang = await page.evaluate(() => document.documentElement.lang.split("-")[0] ?? "en");
  text = translateFor(TRANSLATED_LOCALES.find((locale) => locale === lang) ?? "en");
  await nav(page).waitFor({ timeout: UI_WAIT_MS });
}

const browser: Browser = await chromium.launch({
  headless: true,
  ...(browserExecutable ? { executablePath: browserExecutable } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 640 }, colorScheme: "dark" });
const page = await context.newPage();
page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
const url = `${storybook}/iframe.html?id=app--section-rail-view&viewMode=story&globals=locale:en;colorScheme:dark`;

try {
  await page.goto(url);
  await openApp(page);
  await seed(page);

  await step(page, "agent result selects its section", async () => {
    await selectRail(page, "naia");
    await row(page, "Chief").click();
    await chooseResult(await openSearch(page, "Sales Outbound", "agents"), "Sales Outbound");
    const section = await waitFor(
      "rail on Red Team",
      () => selectedRailSection(page),
      (name) => Boolean(name?.startsWith("Red Team")),
    );
    const shown = await waitFor(
      "Sales row marked in view",
      () => rowShown(page, "Sales Outbound"),
      (value) => Boolean(value.pressed && value.inView),
    );
    return `${section}; ${JSON.stringify(shown)}`;
  });

  await step(page, "channel result with a repeated name opens the right section", async () => {
    await selectRail(page, "naia");
    await row(page, "Chief").click();
    await chooseResult(await openSearch(page, "Ops", "channels"), "red room note");
    const section = await waitFor(
      "rail on Red Team",
      () => selectedRailSection(page),
      (name) => Boolean(name?.startsWith("Red Team")),
    );
    await waitFor(
      "Ops row marked in view",
      () => rowShown(page, "Ops"),
      (value) => value.pressed && value.inView,
    );
    return `${section}`;
  });

  await step(page, "message result opens the agent's own chat tab and the composer sends there", async () => {
    await selectRail(page, "Red Team");
    await row(page, "Research").click();
    await page
      .getByRole("button", { name: text("conversation.threads.new") })
      .first()
      .click();
    const threadBox = page.getByRole("textbox", {
      name: text("conversation.threads.view.newPlaceholder", { name: "Research" }),
    });
    await threadBox.click();
    await page.keyboard.type("side thread for the navigation check");
    await page.keyboard.press("Enter");
    const sideTab = page.locator('.agent-threads-tab[aria-selected="true"]');
    await waitFor(
      "a side thread tab is open",
      async () => sideTab.getAttribute("data-thread-id").catch(() => null),
      (id) => id !== null && id !== "main",
    );
    await selectRail(page, "naia");
    await row(page, "Chief").click();
    await chooseResult(await openSearch(page, RESEARCH_MESSAGE, "messages"), RESEARCH_MESSAGE);
    await waitFor(
      "rail on Red Team",
      () => selectedRailSection(page),
      (name) => Boolean(name?.startsWith("Red Team")),
    );
    await waitFor(
      "Research row marked",
      () => rowShown(page, "Research"),
      (value) => value.pressed && value.inView,
    );
    // The agent's own chat has a hidden key in the tab list, and no side thread tab is selected.
    const mainSelected = await waitFor(
      "the agent's own chat tab is selected",
      async () =>
        (await page.locator('.agent-threads-tab[aria-selected="true"]').count()) === 0 &&
        (await page
          .locator(".agent-threads-main-key")
          .getAttribute("aria-selected", { timeout: 500 })
          .catch(() => null)) === "true",
      Boolean,
    );
    const marker = `own chat check ${crypto.randomUUID().slice(0, 8)}`;
    await typeDraft(page, marker);
    await page.keyboard.press("Enter");
    const landed = await waitFor(
      "the message is in Research's own chat",
      () =>
        page.evaluate(
          async (text) =>
            (
              await window.openbot.agent.readConversationPage({
                agentId: "research",
                anchor: { type: "latest" },
                limit: 10,
              })
            ).messages.some((message) => message.text.includes(text)),
          marker,
        ),
      Boolean,
    );
    return `main tab aria-selected=${mainSelected}; sent to own chat=${landed}`;
  });

  await step(page, "result in a collapsed section opens the section", async () => {
    await selectRail(page, null);
    await row(page, "Chief").click();
    const header = nav(page).getByRole("button", { name: "Red Team", exact: true });
    if ((await header.getAttribute("aria-expanded")) === "true") await header.click();
    await waitFor(
      "Red Team collapsed",
      () => header.getAttribute("aria-expanded"),
      (value) => value === "false",
    );
    await chooseResult(await openSearch(page, "Sales Outbound", "agents"), "Sales Outbound");
    await waitFor(
      "Red Team open",
      () => header.getAttribute("aria-expanded"),
      (value) => value === "true",
    );
    await waitFor(
      "Sales row marked",
      () => rowShown(page, "Sales Outbound"),
      (value) => value.pressed && value.inView,
    );
    return undefined;
  });

  await step(page, "result that the activity filter hides turns the filter off", async () => {
    const filter = page.getByRole("button", { name: text("sidebar.activity.label") });
    await filter.click();
    await page.getByRole("menuitemcheckbox", { name: text("sidebar.activity.agents") }).click();
    await page.keyboard.press("Escape");
    const on = page.getByRole("button", { name: text("sidebar.activity.agents") });
    await waitFor(
      "filter on",
      () => on.getAttribute("aria-pressed"),
      (value) => value === "true",
    );
    await chooseResult(await openSearch(page, "Ops", "channels"), "red room note");
    await waitFor(
      "filter off",
      () => filter.getAttribute("aria-pressed", { timeout: 500 }).catch(() => null),
      (value) => value === "false",
    );
    await waitFor(
      "Ops row marked",
      () => rowShown(page, "Ops"),
      (value) => value.pressed && value.inView,
    );
    return undefined;
  });

  await step(page, "Back selects the section of the chat it opens", async () => {
    await selectRail(page, "naia");
    await row(page, "Chief").click();
    await chooseResult(await openSearch(page, "Sales Outbound", "agents"), "Sales Outbound");
    await waitFor(
      "rail on Red Team",
      () => selectedRailSection(page),
      (name) => Boolean(name?.startsWith("Red Team")),
    );
    // The shortcut is the window's, not the composer's.
    await page.evaluate(() =>
      document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined,
    );
    await page.keyboard.press("Meta+BracketLeft");
    const section = await waitFor(
      "rail on naia",
      () => selectedRailSection(page),
      (name) => Boolean(name?.startsWith("naia")),
    );
    await waitFor(
      "Chief row marked",
      () => rowShown(page, "Chief"),
      (value) => value.pressed && value.inView,
    );
    return `${section}`;
  });

  await step(page, "each channel tab keeps its own draft", async () => {
    await selectRail(page, "Red Team");
    await row(page, "Ops").click();
    await channelTab(page, "General").click();
    await waitFor(
      "General open",
      () => channelTab(page, "General").getAttribute("aria-current"),
      (v) => v === "true",
    );
    await typeDraft(page, "alpha draft");
    await channelTab(page, "Second").click();
    await waitFor(
      "Second open",
      () => channelTab(page, "Second").getAttribute("aria-current"),
      (v) => v === "true",
    );
    const emptyOnSecond = await waitFor(
      "Second has no draft",
      () => composerText(page),
      (text) => text === "",
    );
    await typeDraft(page, "beta draft");
    await channelTab(page, "General").click();
    const onGeneral = await waitFor(
      "General has its draft",
      () => composerText(page),
      (text) => text === "alpha draft",
    );
    await channelTab(page, "Second").click();
    const onSecond = await waitFor(
      "Second has its draft",
      () => composerText(page),
      (text) => text === "beta draft",
    );
    return JSON.stringify({ emptyOnSecond, onGeneral, onSecond });
  });

  await step(page, "a channel from search opens on the last tab", async () => {
    await row(page, "Sales Outbound").click();
    await chooseResult(await openSearch(page, "Ops", "channels"), "red room note");
    await waitFor(
      "Second open",
      () => channelTab(page, "Second").getAttribute("aria-current"),
      (v) => v === "true",
    );
    const text = await waitFor(
      "Second has its draft",
      () => composerText(page),
      (value) => value === "beta draft",
    );
    return text;
  });

  await step(page, "after a reload the channel opens on its last tab with each draft", async () => {
    // The drafts are written a moment after each change.
    await page.waitForTimeout(600);
    await page.reload();
    await openApp(page);
    await seed(page);
    await selectRail(page, "Red Team");
    await row(page, "Sales Outbound").click();
    await row(page, "Ops").click();
    await waitFor(
      "Second open",
      () => channelTab(page, "Second").getAttribute("aria-current"),
      (v) => v === "true",
    );
    const onSecond = await waitFor(
      "Second has its draft",
      () => composerText(page),
      (text) => text === "beta draft",
    );
    await channelTab(page, "General").click();
    const onGeneral = await waitFor(
      "General has its draft",
      () => composerText(page),
      (text) => text === "alpha draft",
    );
    return JSON.stringify({ onSecond, onGeneral });
  });
} finally {
  await page.screenshot({ path: resolve(OUT, "final.png") }).catch(() => undefined);
  const passed = results.length > 0 && results.every((result) => result.ok) && pageErrors.length === 0;
  writeFileSync(
    resolve(OUT, "report.json"),
    `${JSON.stringify({ passed, url, results, pageErrors, screenshots }, null, 2)}\n`,
  );
  await browser.close();
  process.stdout.write(`${passed ? "PASSED" : "FAILED"}: ${resolve(OUT, "report.json")}\n`);
  if (!passed) process.exitCode = 1;
}
