// Checks the Task reviewer page of Settings ("Fiscal" in Portuguese) and its links with the load page
// that the ring of the rail opens, on a running dev app of this worktree, in the language that the app shows:
// - the settings search finds the page by "fiscal";
// - the switch of the page turns the task reviewer on while "Resume by itself" is off, and the page says
//   that it waits;
// - the load page then shows the switch of the task reviewer, on, also while "Resume by itself" is off;
// - "Task reviewer settings" on the load page opens the page;
// - the ring opens the load page, and after "Task reviewer settings" from there, closing Settings puts
//   the focus back on the ring.
// Restores "Resume by itself" and the task reviewer at the end. Writes
// .openbot-build/task-reviewer-settings/report.json and screenshots. Needs `--allow-mutations`, because
// it changes the two switches.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AutoRecoveryPreference, BuildersBotDesktopApi, TaskWatchPreference } from "@openbot/contracts/ipc";
import { type AppTranslate, TRANSLATED_LOCALES, type TranslatedLocale, translateFor } from "@openbot/i18n";
import { createBuildersBotLogger } from "@openbot/logging";
import type { Page } from "playwright-core";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

// The page functions below run in the app window, where the preload bridge sets this.
declare global {
  interface Window {
    openbot: BuildersBotDesktopApi;
  }
}

const OUT = resolve(import.meta.dirname, "../.openbot-build/task-reviewer-settings");

const instances = readDevInstanceRecords().filter(
  (record) => record.service === "app" && resolve(record.projectRoot) === resolve(process.cwd()),
);
assert.equal(instances.length, 1, "Start one dev app for this worktree first.");
const instance = instances[0];
assert.ok(instance);
assertMutationAllowed({
  command: "task-reviewer-settings-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const logger = createBuildersBotLogger("task-reviewer-settings-e2e");
const session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The language that the window shows, so the names below match the screen. */
async function shownLocale(page: Page): Promise<TranslatedLocale> {
  const lang = await page.evaluate(() => document.documentElement.lang);
  return TRANSLATED_LOCALES.find((locale) => locale === lang) ?? "en";
}

/** The button of the load ring. Its name starts with the count of agents and the memory. */
function ringButton(page: Page, t: AppTranslate) {
  const mark = "\u0000";
  const pattern = [
    t("app.rail.load.ring", { agents: mark, used: mark, total: mark }),
    t("app.rail.load.ringUnmeasured", { agents: mark }),
  ]
    .map((text) => `^${escaped(text).split(mark).join(".*")}`)
    .join("|");
  return page.getByRole("button", { name: new RegExp(pattern) });
}

function settingsTitle(page: Page, t: AppTranslate) {
  return page.getByRole("heading", { level: 1, name: t("app.settingsPage.title"), exact: true });
}

async function closeSettings(page: Page, t: AppTranslate) {
  // A focused settings tab keeps Escape for itself, so Escape goes from the title.
  await settingsTitle(page, t).focus();
  await page.keyboard.press("Escape");
  await settingsTitle(page, t).waitFor({ state: "hidden" });
}

function selectedTab(page: Page, name: string) {
  return page.getByRole("tab", { name, exact: true, selected: true });
}

function loadPage(page: Page, t: AppTranslate) {
  return page.getByRole("tabpanel", { name: t("settings.tab.load.title"), exact: true });
}

async function preferences(page: Page) {
  const snapshot = await page.evaluate(() => window.openbot.getLoad());
  const recovery: AutoRecoveryPreference = {
    enabled: snapshot.recovery.enabled,
    intervalMinutes: snapshot.recovery.intervalMinutes,
    reassign: snapshot.recovery.reassign,
  };
  const taskWatch: TaskWatchPreference = {
    enabled: snapshot.taskWatch.enabled,
    quietMinutes: snapshot.taskWatch.quietMinutes,
  };
  return { recovery, taskWatch };
}

async function setPreferences(page: Page, value: { recovery: AutoRecoveryPreference; taskWatch: TaskWatchPreference }) {
  await page.evaluate(async ({ recovery, taskWatch }) => {
    await window.openbot.setAutoRecovery(recovery);
    await window.openbot.setTaskWatch(taskWatch);
  }, value);
}

mkdirSync(OUT, { recursive: true });
const page = session.page;
const original = await preferences(page);
const steps: Array<{ step: string; ok: true }> = [];
const pass = (step: string) => {
  steps.push({ step, ok: true });
  logger.info(step);
};
let locale: TranslatedLocale = "en";
try {
  locale = await shownLocale(page);
  const t = translateFor(locale);
  const reviewerTab = t("settings.tab.taskReviewer.title");
  const guardTab = t("guard.tab.title");
  const loadTab = t("settings.tab.load.title");
  await setPreferences(page, {
    recovery: { ...original.recovery, enabled: false },
    taskWatch: { ...original.taskWatch, enabled: false },
  });
  if (await settingsTitle(page, t).isVisible()) await closeSettings(page, t);

  // The search finds the page by its Portuguese name, in every language.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
  await settingsTitle(page, t).waitFor();
  const search = page.getByRole("searchbox", { name: t("app.settingsPage.search"), exact: true });
  await search.fill("fiscal");
  await search.press("Enter");
  await selectedTab(page, reviewerTab).waitFor();
  pass("The settings search opens the Task reviewer page for 'fiscal'.");

  const reviewerPage = page.getByRole("tabpanel", { name: reviewerTab, exact: true });
  // The page reads the load when it opens; the switch is ready when the state says off.
  await reviewerPage.getByText(t("settings.taskReviewer.state.off"), { exact: true }).waitFor();
  await reviewerPage.getByText(t("settings.taskReviewer.enabled.title"), { exact: true }).click();
  await page.waitForFunction(async () => (await window.openbot.getLoad()).taskWatch.enabled);
  await reviewerPage.getByText(t("settings.taskReviewer.state.waiting"), { exact: true }).waitFor();
  pass("The page switch turns the task reviewer on, and the page says that it waits for Resume by itself.");

  // Another page, chosen in the page, then the load page from the Related section of the Guard.
  await reviewerPage.getByRole("button", { name: t("settings.taskReviewer.model.openGuard"), exact: true }).click();
  await selectedTab(page, guardTab).waitFor();
  const guardPage = page.getByRole("tabpanel", { name: guardTab, exact: true });
  await guardPage
    .getByRole("button", { name: t("settings.related.open", { name: t("settings.loadPanel.title") }), exact: true })
    .click();
  await selectedTab(page, loadTab).waitFor();
  const load = loadPage(page, t);
  const pageSwitch = load.getByRole("switch", { name: t("app.rail.load.watchTitle"), exact: true });
  await pageSwitch.waitFor();
  assert.equal(await pageSwitch.isChecked(), true, "The load page shows the task reviewer off.");
  const recoverySwitch = load.getByRole("switch", { name: t("app.rail.load.recoveryTitle"), exact: true });
  assert.equal(await recoverySwitch.isChecked(), false, "Resume by itself is on in the load page.");
  await page.screenshot({ path: resolve(OUT, `load-page-recovery-off-${locale}.png`) });
  pass("With Resume by itself off, the load page shows the task reviewer switch, on.");

  await load.getByRole("button", { name: t("app.rail.load.watchSettings"), exact: true }).click();
  await selectedTab(page, reviewerTab).waitFor();
  await page.screenshot({ path: resolve(OUT, `settings-task-reviewer-${locale}.png`) });
  pass("'Task reviewer settings' on the load page opens the page.");

  await closeSettings(page, t);
  const ring = ringButton(page, t);
  await ring.click();
  await selectedTab(page, loadTab).waitFor();
  await load.getByRole("button", { name: t("app.rail.load.watchSettings"), exact: true }).click();
  await selectedTab(page, reviewerTab).waitFor();
  const ringElement = await ring.elementHandle();
  assert.ok(ringElement, "The rail shows no load ring.");
  await closeSettings(page, t);
  // The shell gives the focus back two frames after Settings closes.
  await page.waitForFunction((element) => document.activeElement === element, ringElement, { timeout: 5000 });
  pass("The ring opens the load page, and closing Settings after the task reviewer page puts the focus on the ring.");
} finally {
  await setPreferences(page, original);
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ locale, original, steps }, null, 2)}\n`);
  await session.close();
}
logger.info(`Passed ${steps.length} steps. Wrote ${resolve(OUT, "report.json")}.`);
