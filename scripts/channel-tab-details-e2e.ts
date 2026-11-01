// Checks the tabs of a channel through the UI of this worktree's running dev app, with real provider
// turns. Start the app with `bun run dev` (never `--shared`), then run
// `bun scripts/channel-tab-details-e2e.ts --allow-mutations [--agent=<agent id>]`. It needs one visible
// agent whose provider is signed in.
//
// The tabs of a channel had no details button and no hover preview, which the thread tabs of an
// agent's own chat have. It makes a channel, writes a first message in its first tab and in a second
// tab, renames the second tab, and checks through the UI that:
// - only the open tab has the "Thread details" button, before its name;
// - the button opens a dialog with the first message of the person, also after the rename;
// - the pointer on a tab that is not open shows a preview card with that tab's first message.
// It makes its own channel and deletes it at the end.
// Writes .openbot-build/channel-tab-details-e2e/report.json and screenshots.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { argument, ChannelClient, connectChannelE2e, waitFor, writeReport } from "./channel-e2e-support";

const OUT = resolve(import.meta.dirname, "../.openbot-build/channel-tab-details-e2e");
const UI_WAIT_MS = 15_000;
const english = translateFor("en");

interface Report {
  channelId?: string;
  details?: { buttons: number; beforeName: boolean; dialogFirst: boolean; afterRename: boolean };
  preview?: { shown: boolean; text: string };
  pageErrors: string[];
  screenshots: string[];
  passed: boolean;
}

const report: Report = { pageErrors: [], screenshots: [], passed: false };
const session = await connectChannelE2e("channel-tab-details-e2e");
const { page } = session;
page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
const client = new ChannelClient(page);
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stamp = Date.now().toString(36);
const name = `Tab details ${stamp}`;
const firstText = `Reply with the single word ready. Do not use tools. First tab ${stamp}.`;
const secondText = `Reply with the single word done. Do not use tools. Second tab ${stamp}.`;
const renamed = `Renamed ${stamp}`;

async function shot(label: string): Promise<void> {
  const path = resolve(OUT, `${label}.png`);
  await page.screenshot({ path });
  report.screenshots.push(path);
}

try {
  const agents = await client.agents();
  const agentId = argument("agent") ?? agents[0]?.id;
  assert.ok(agentId, "The app has no visible agent.");
  const channel = await client.create(name, [agentId], agentId);
  report.channelId = channel.id;
  await client.send(channel.id, firstText, agentId);
  const secondId = crypto.randomUUID();
  await client.command({
    type: "topic-create",
    operationId: crypto.randomUUID(),
    channelId: channel.id,
    topicId: secondId,
  });
  await client.command({
    type: "send",
    operationId: crypto.randomUUID(),
    channelId: channel.id,
    topicId: secondId,
    text: secondText,
    recipientAgentId: agentId,
    replyToMessageId: null,
    attachmentDraftIds: [],
  });
  await client.command({
    type: "topic-rename",
    operationId: crypto.randomUUID(),
    channelId: channel.id,
    topicId: secondId,
    name: renamed,
  });
  // The tab can take a name from its first message after the rename is written; the rename wins.
  const summary = await waitFor(
    page,
    "the renamed tab",
    () => client.summary(channel.id),
    (current) => current.topics?.find((topic) => topic.id === secondId)?.name === renamed,
  );
  const firstName = summary.topics?.find((topic) => topic.id !== secondId)?.name;
  assert.ok(firstName, "The channel has its first tab.");

  await page
    .getByRole("navigation", { name: english("sidebar.nav.label") })
    .getByRole("button", { name: new RegExp(`^${literal(name)}[,.]`) })
    .click();
  const tabs = page.getByRole("group", { name: english("channel.topic.name") });
  const tab = (label: string) => tabs.getByRole("button", { name: label, exact: true });
  await tab(renamed).click();
  await tab(renamed).and(page.locator('[aria-current="true"]')).waitFor({ timeout: UI_WAIT_MS });

  const details = tabs.getByRole("button", { name: english("conversation.threads.details.open"), exact: true });
  await details.waitFor({ timeout: UI_WAIT_MS });
  const buttons = await details.count();
  const beforeName = await details.evaluate(
    (button, label) => button.nextElementSibling?.textContent?.trim() === label,
    renamed,
  );
  await shot("open-tab-details-button");
  await details.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText(secondText, { exact: false }).first().waitFor({ timeout: UI_WAIT_MS });
  const afterRename = await dialog.getByRole("heading", { name: renamed }).isVisible();
  await shot("details-dialog");
  report.details = { buttons, beforeName, dialogFirst: true, afterRename };
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: UI_WAIT_MS });

  // The first tab is not open: the pointer on it shows its preview, and it has no details button.
  await tab(firstName).hover();
  const card = page.getByRole("tooltip");
  await card.waitFor({ timeout: UI_WAIT_MS });
  const text = (await card.textContent()) ?? "";
  report.preview = { shown: text.includes(firstText), text };
  await shot("hover-preview");

  assert.equal(buttons, 1, "Only the open tab has the details button.");
  assert.ok(beforeName, "The details button is before the name of the open tab.");
  assert.ok(afterRename, "The dialog names the tab by its new name.");
  assert.ok(report.preview.shown, `The preview shows the first message of the tab. It showed: ${text}`);
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} finally {
  await client.cleanup();
  writeReport("channel-tab-details-e2e", report);
  await session.close();
}
