// Checks the load page of Settings ("Carga" in Portuguese) on a running dev app of this worktree, in the
// language that the app shows. The fixture is a channel of its own with no lead, where each request that
// names no member stops at once and starts no agent: 52 requests and 3 routine runs, so the page has
// more rows than the 50 of the old panel. The check:
// - a deleted routine takes its stopped row with it (the cause of the rows that never left);
// - a click on the ring opens Settings on the load page, and the ring still counts the stopped work;
// - the channel filter selects the 54 rows of the fixture; Space marks a row and Shift with Space marks
//   a range;
// - the origin filter selects the 2 routine rows: Reassign lists the members of the channel, Change
//   model says that no selected row has an agent, and Remove asks with the count, removes them and
//   undoes the removal;
// - a removal of every row of the fixture reports the one row that another client removed first.
// Reassign and Change model that apply to rows are checked without a window in
// `scripts/stopped-work-bulk-e2e.ts`, so this check starts no agent. It deletes its channel and its
// routine at the end. Writes .openbot-build/load-settings/report.json and screenshots. Needs
// `--allow-mutations`.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type BuildersBotDesktopApi, LOCAL_SERVER_ID, type StoppedWorkEntry } from "@openbot/contracts/ipc";
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

const OUT = resolve(import.meta.dirname, "../.openbot-build/load-settings");
const REQUESTS = 52;

const instances = readDevInstanceRecords().filter(
  (record) => record.service === "app" && resolve(record.projectRoot) === resolve(process.cwd()),
);
assert.equal(instances.length, 1, "Start one dev app for this worktree first.");
const instance = instances[0];
assert.ok(instance);
assertMutationAllowed({
  command: "load-settings-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const logger = createBuildersBotLogger("load-settings-e2e");
const session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

/** The stopped rows of the fixture channel, from main. */
function fixtureRows(page: Page, channelId: string): Promise<StoppedWorkEntry[]> {
  return page.evaluate(
    async (id) => (await window.openbot.listStoppedWork()).items.filter((item) => item.channelId === id),
    channelId,
  );
}

async function waitForRows(page: Page, channelId: string, count: number): Promise<void> {
  await page.waitForFunction(
    async ([id, wanted]) =>
      (await window.openbot.listStoppedWork()).items.filter((item) => item.channelId === id).length === wanted,
    [channelId, count] as const,
    { timeout: 30_000, polling: 250 },
  );
}

/** The trigger of a select of the page, by its label. */
function selectTrigger(page: Page, label: string) {
  return page.locator(`.ui-select-trigger[aria-label="${label}"]`);
}

/** The open list of a select. */
function openList(page: Page) {
  return page.locator("[data-popper-positioner] .ui-select-content");
}

/** Chooses an option of one select of the filter row of the page. */
async function chooseFilter(page: Page, label: string, option: string) {
  await selectTrigger(page, label).click();
  await openList(page).getByRole("option", { name: option, exact: true }).click();
}

mkdirSync(OUT, { recursive: true });
const page = session.page;
const stamp = Date.now().toString(36);
const channelId = `load-e2e-${stamp}`;
const channelName = `Carga E2E ${stamp}`;
const routineIds: string[] = [];
const steps: Array<{ step: string; ok: true }> = [];
const pass = (step: string) => {
  steps.push({ step, ok: true });
  logger.info(step);
};
let locale: TranslatedLocale = "en";
try {
  locale = await shownLocale(page);
  const t = translateFor(locale);
  if (await settingsTitle(page, t).isVisible()) await closeSettings(page, t);

  // The fixture: up to two agents as members, and no lead, so a request that names no member stops.
  await page.evaluate(
    async ({ id, name, server, requests }) => {
      const members = (await window.openbot.agent.listAgents(server))
        .slice(0, 2)
        .map((agent) => ({ agentId: agent.id }));
      await window.openbot.agent.channelCommand(
        {
          type: "save",
          operationId: `${id}:save`,
          channelId: id,
          draft: { name, title: "", instructions: "", members, leadAgentId: null },
        },
        server,
      );
      for (let index = 0; index < requests; index += 1) {
        await window.openbot.agent.channelCommand(
          {
            type: "send",
            operationId: `${id}:send:${index}`,
            channelId: id,
            text: `Load page check ${index + 1}. Nothing to do.`,
            recipientAgentId: null,
            replyToMessageId: null,
            attachmentDraftIds: [],
          },
          server,
        );
      }
    },
    { id: channelId, name: channelName, server: LOCAL_SERVER_ID, requests: REQUESTS },
  );
  const routines = await page.evaluate(
    async ({ id, server }) => {
      const create = (name: string) =>
        window.openbot.agent.createChannelRoutine(
          {
            channelId: id,
            name,
            instruction: `${name}: nothing to do.`,
            active: false,
            timezone: "UTC",
            schedule: { kind: "daily", time: "09:00" },
          },
          server,
        );
      const kept = await create("Load check routine");
      const deleted = await create("Load check deleted routine");
      await window.openbot.agent.testChannelRoutine({ channelId: id, routineId: kept.id }, server);
      await window.openbot.agent.testChannelRoutine({ channelId: id, routineId: kept.id }, server);
      await window.openbot.agent.testChannelRoutine({ channelId: id, routineId: deleted.id }, server);
      return { kept: kept.id, deleted: deleted.id };
    },
    { id: channelId, server: LOCAL_SERVER_ID },
  );
  routineIds.push(routines.kept);
  await waitForRows(page, channelId, REQUESTS + 3);
  pass(`The fixture has ${REQUESTS + 3} stopped rows: ${REQUESTS} requests and 3 routine runs.`);

  await page.evaluate(
    async ({ id, routineId, server }) =>
      window.openbot.agent.deleteChannelRoutine({ channelId: id, routineId }, server),
    { id: channelId, routineId: routines.deleted, server: LOCAL_SERVER_ID },
  );
  await waitForRows(page, channelId, REQUESTS + 2);
  const afterDelete = await fixtureRows(page, channelId);
  assert.equal(
    afterDelete.some((row) => row.routineName === "Load check deleted routine"),
    false,
    "The row of the deleted routine stayed.",
  );
  pass("A deleted routine takes its stopped row with it.");

  // The ring opens the load page.
  await ringButton(page, t).click();
  await page.getByRole("tab", { name: t("settings.tab.load.title"), exact: true, selected: true }).waitFor();
  const loadPage = page.getByRole("tabpanel", { name: t("settings.tab.load.title"), exact: true });
  await loadPage.getByText(t("settings.load.stopped.title"), { exact: true }).waitFor();
  await page.screenshot({ path: resolve(OUT, `load-page-${locale}.png`) });
  pass("A click on the ring opens Settings on the load page.");

  // The channel filter selects the rows of the fixture.
  await chooseFilter(page, t("settings.load.filter.place"), channelName);
  const total = REQUESTS + 2;
  const selectAll = loadPage.getByLabel(t("settings.load.selectAll", { count: total }), { exact: true });
  await selectAll.waitFor();
  pass(`The channel filter shows the ${total} rows of the fixture.`);

  // Space marks a row; Shift with Space marks the range from it.
  const boxes = loadPage.getByRole("checkbox", {
    name: new RegExp(`^${escaped(t("settings.load.select.row", { title: "" }))}`),
  });
  await boxes.nth(0).focus();
  await page.keyboard.press("Space");
  await loadPage.getByText(t("settings.load.selected", { count: 1 }), { exact: true }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+Space");
  await loadPage.getByText(t("settings.load.selected", { count: 3 }), { exact: true }).waitFor();
  await loadPage.getByRole("button", { name: t("settings.load.clearSelection"), exact: true }).click();
  pass("Space marks a row, and Shift with Space marks a range of 3 rows.");

  // The origin filter selects the routine rows.
  await chooseFilter(page, t("settings.load.filter.origin"), t("settings.load.filter.origin.routine"));
  await loadPage.getByLabel(t("settings.load.selectAll", { count: 2 }), { exact: true }).check();
  const toolbar = loadPage.getByRole("toolbar", { name: t("settings.load.actions.label"), exact: true });
  await toolbar.getByText(t("settings.load.selected", { count: 2 }), { exact: true }).waitFor();
  await page.screenshot({ path: resolve(OUT, `load-page-selected-${locale}.png`) });
  pass("The origin filter and 'Select all shown' mark the 2 routine rows.");

  // Reassign lists the members of the channel; nothing is chosen, so no agent starts.
  const members = await page.evaluate(
    async (server) => (await window.openbot.agent.listAgents(server)).slice(0, 2).map((agent) => agent.name),
    LOCAL_SERVER_ID,
  );
  const reassign = toolbar.getByRole("button", { name: t("settings.load.action.reassign") });
  if (members.length > 0) {
    await reassign.click();
    for (const name of members)
      await page
        .getByRole("option", { name: new RegExp(escaped(name)) })
        .first()
        .waitFor();
    await page.keyboard.press("Escape");
    pass("Reassign lists the members of the channel of the marked rows.");
  } else {
    assert.equal(await reassign.isDisabled(), true, "Reassign is on with no member to choose.");
    pass("Reassign is off when no agent is a member of the channel of the marked rows.");
  }

  // Change model lists the models that the Guard lists. A choice asks first: the rows have no agent,
  // so the dialog says that no model can change, and Cancel changes nothing.
  await selectTrigger(page, t("settings.load.action.model")).click();
  const models = openList(page).getByRole("option");
  await models.first().waitFor({ timeout: 15_000 });
  await models.first().click();
  const modelDialog = page.getByRole("alertdialog", { name: t("settings.load.model.title", { count: 0 }) });
  await modelDialog.getByText(t("settings.load.model.none"), { exact: true }).waitFor();
  await modelDialog.getByText(t("settings.load.model.noAgent", { count: 2 }), { exact: true }).waitFor();
  await modelDialog.getByRole("button", { name: t("common.cancel"), exact: true }).click();
  pass("Change model lists the models, says whose model changes, and that rows with no agent do not change.");

  // Remove asks with the count, removes, and the removal can be undone.
  await toolbar.getByRole("button", { name: t("settings.load.action.remove"), exact: true }).click();
  const removeDialog = page.getByRole("alertdialog", { name: t("settings.load.remove.title", { count: 2 }) });
  await removeDialog.waitFor();
  await removeDialog.getByRole("button", { name: t("settings.load.remove.confirm"), exact: true }).click();
  await loadPage.getByText(t("settings.load.report.remove", { count: 2 }), { exact: true }).waitFor();
  await waitForRows(page, channelId, REQUESTS);
  await page.screenshot({ path: resolve(OUT, `load-page-removed-${locale}.png`) });
  await loadPage.getByRole("button", { name: t("settings.load.report.undoAction"), exact: true }).click();
  await loadPage.getByText(t("settings.load.report.undo", { count: 2 }), { exact: true }).waitFor();
  await waitForRows(page, channelId, REQUESTS + 2);
  pass("Remove asks with the count, removes the 2 rows, and Undo puts them back.");

  // A removal of every row of the fixture, with one row removed by another client first.
  await chooseFilter(page, t("settings.load.filter.origin"), t("settings.load.filter.origin.all"));
  await loadPage.getByLabel(t("settings.load.selectAll", { count: total }), { exact: true }).check();
  await toolbar.getByText(t("settings.load.selected", { count: total }), { exact: true }).waitFor();
  const [first] = await fixtureRows(page, channelId);
  assert.ok(first, "The fixture has no row.");
  await toolbar.getByRole("button", { name: t("settings.load.action.remove"), exact: true }).click();
  await page.getByRole("alertdialog", { name: t("settings.load.remove.title", { count: total }) }).waitFor();
  // Another client removes one row while the dialog is open, and the person confirms at once: the
  // page has not read the list again, so it sends the row that is gone.
  await page.evaluate(
    async ({ item, confirm }) => {
      await window.openbot.bulkStoppedWork({ action: "remove", items: [item] });
      const button = [...document.querySelectorAll<HTMLButtonElement>("[role='alertdialog'] button")].find(
        (element) => element.textContent?.trim() === confirm,
      );
      if (!button) throw new Error("The dialog has no confirm button.");
      button.click();
    },
    { item: { channelId: first.channelId, taskId: first.taskId }, confirm: t("settings.load.remove.confirm") },
  );
  await loadPage.getByText(t("settings.load.report.remove", { count: total - 1 }), { exact: true }).waitFor();
  await loadPage.getByText(t("settings.load.report.failed", { count: 1 }), { exact: true }).waitFor();
  await loadPage
    .getByText(t("settings.load.report.reason", { reason: t("settings.load.report.reason.gone"), count: 1 }), {
      exact: true,
    })
    .waitFor();
  await waitForRows(page, channelId, 0);
  await page.screenshot({ path: resolve(OUT, `load-page-partial-${locale}.png`) });
  pass(`A removal of ${total} rows reports the 1 row that was removed first, and removes the others.`);

  await closeSettings(page, t);
} finally {
  await page
    .evaluate(
      async ({ id, routines, server }) => {
        for (const routineId of routines)
          await window.openbot.agent.deleteChannelRoutine({ channelId: id, routineId }, server).catch(() => undefined);
        await window.openbot.agent.deleteChannel(id, server).catch(() => undefined);
      },
      { id: channelId, routines: routineIds, server: LOCAL_SERVER_ID },
    )
    .catch(() => undefined);
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ locale, channelName, steps }, null, 2)}\n`);
  await session.close();
}
logger.info(`Passed ${steps.length} steps. Wrote ${resolve(OUT, "report.json")}.`);
