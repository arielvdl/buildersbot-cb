// Checks dictation in the composer of a channel, in the stories, with the real components, the real
// voice store and the mocked voice bridge, in a headless Chromium with a fake microphone. The channel
// composer had no microphone: only the composer of one agent had it. With two tabs of one channel, it
// checks that:
// - the microphone shows beside Send in the channel composer;
// - a click starts the recording (the recording controls and the time show), and Stop ends it: the
//   transcript goes into the draft of the open tab;
// - the other tab does not show that text, and the first tab still has it after a switch back;
// - Cancel discards a recording and keeps the draft as it was;
// - a recording started in one tab writes its live text and its transcript only to that tab, also when
//   the reader opens another tab while it records;
// - Send while recording sends the draft and the transcript through the channel send, to the tab of
//   the recording, and clears that tab's draft only;
// - a typed message goes to the open tab and clears that tab's draft;
// - the composer of one agent still has the microphone, and its transcript goes into its draft.
// Pass the URL that `bun run storybook` reports:
//
//   bun scripts/channel-voice-input-e2e.ts --storybook=http://localhost:6006 [--browser-executable=<path>]
//
// Writes .openbot-build/channel-voice-input-e2e/report.json and screenshots.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { chromium, type Page } from "playwright-core";

const OUT = resolve(import.meta.dirname, "../.openbot-build/channel-voice-input-e2e");
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const storybook = argument("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const browserExecutable = argument("browser-executable");
const english = translateFor("en");
const UI_WAIT_MS = 15_000;
/** What the mocked voice bridge answers for every recording (src/renderer/src/preview/mock-voice.ts). */
const TRANSCRIPT = "Mock voice transcript";
/** The tabs of the `TabsWithDictation` story (ChannelConversation.stories.tsx). */
const PLAN = "Plan";
const NUMBERS = "Numbers";

interface Step {
  name: string;
  detail: string;
}

const report: {
  storybook: string;
  steps: Step[];
  screenshots: string[];
  errors: string[];
  failures: string[];
  passed: boolean;
} = { storybook, steps: [], screenshots: [], errors: [], failures: [], passed: false };

const storyUrl = (id: string) => `${storybook}/iframe.html?id=${id}&viewMode=story&globals=locale:en`;
const composer = (page: Page) => page.locator(".composer").first();
const editor = (page: Page) => composer(page).getByRole("textbox").first();
const microphone = (page: Page) =>
  composer(page).getByRole("button", { name: english("composer.voice.start"), exact: true });
const recording = (page: Page) => composer(page).getByRole("group", { name: english("composer.voice.recording") });
const sentList = (page: Page) => page.getByRole("list", { name: "Sent channel messages" });

async function shot(page: Page, label: string): Promise<void> {
  const path = resolve(OUT, `${label}.png`);
  await page.screenshot({ path });
  report.screenshots.push(path);
}

/** The text of the draft in the open composer. */
const draftText = async (page: Page) => ((await editor(page).textContent()) ?? "").replace(/\s+/gu, " ").trim();
/** The live text of a recording, which shows over the open composer while it records. */
const liveText = async (page: Page) =>
  (await composer(page).locator(".composer-dictation-word").allTextContents()).join(" ").replace(/\s+/gu, " ").trim();

async function waitDraft(page: Page, expected: string, why: string): Promise<void> {
  await page
    .waitForFunction(
      ({ text }) =>
        (document.querySelector(".composer [role=textbox]")?.textContent ?? "").replace(/\s+/gu, " ").trim() === text,
      { text: expected },
      { timeout: UI_WAIT_MS },
    )
    .catch(async () => assert.fail(`${why}: the draft is "${await draftText(page)}", not "${expected}".`));
}

async function openTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole("tab", { name, exact: true });
  await tab.click();
  await page
    .waitForFunction((label) => {
      const selected = document.querySelector("[role=tab][aria-selected=true]");
      return selected?.textContent?.trim() === label;
    }, name)
    .catch(() => assert.fail(`The ${name} tab did not open.`));
}

/** Starts a recording with the microphone and waits for the recording controls. */
async function startRecording(page: Page, where: string): Promise<void> {
  await microphone(page)
    .waitFor({ state: "visible", timeout: UI_WAIT_MS })
    .catch(() => assert.fail(`${where}: the composer has no microphone beside Send.`));
  assert.ok(await microphone(page).isEnabled(), `${where}: the microphone is disabled.`);
  await microphone(page).click();
  await recording(page)
    .waitFor({ state: "visible", timeout: UI_WAIT_MS })
    .catch(() => assert.fail(`${where}: a click on the microphone did not start a recording.`));
  const time = await recording(page).locator("time").getAttribute("datetime");
  assert.match(time ?? "", /^PT\d+S$/u, `${where}: the recording shows no time.`);
}

/** Waits until the live text of the recording shows over the open composer. */
async function waitLiveText(page: Page, where: string): Promise<void> {
  await composer(page)
    .locator(".composer-dictation-word")
    .first()
    .waitFor({ state: "visible", timeout: UI_WAIT_MS })
    .catch(() => assert.fail(`${where}: no live text while recording.`));
  assert.equal(await liveText(page), TRANSCRIPT, `${where}: the live text is wrong.`);
}

/** Ends a recording with a control of the recording, and waits until the composer is idle again. */
async function endRecording(page: Page, control: "stop" | "cancel", where: string): Promise<void> {
  const label = english(control === "stop" ? "composer.voice.stop" : "composer.voice.cancel");
  await recording(page).getByRole("button", { name: label, exact: true }).click();
  await microphone(page)
    .waitFor({ state: "visible", timeout: UI_WAIT_MS })
    .catch(() => assert.fail(`${where}: the composer did not come back from the recording.`));
}

async function sentEntries(page: Page): Promise<string[]> {
  if ((await sentList(page).count()) === 0) return [];
  return (await sentList(page).getByRole("listitem").allTextContents()).map((entry) => entry.trim());
}

async function waitSent(page: Page, expected: string[], why: string): Promise<void> {
  await page
    .waitForFunction(
      (count) => document.querySelectorAll('[aria-label="Sent channel messages"] li').length >= count,
      expected.length,
      { timeout: UI_WAIT_MS },
    )
    .catch(() => undefined);
  assert.deepEqual(await sentEntries(page), expected, `${why}: the channel sent other messages.`);
}

async function checkChannel(page: Page): Promise<void> {
  await page.goto(storyUrl("conversation-channel--tabs-with-dictation"), {
    waitUntil: "domcontentloaded",
    timeout: 300_000,
  });
  await editor(page).waitFor({ timeout: 240_000 });
  assert.equal(
    await editor(page).getAttribute("aria-label"),
    english("channel.composer.label"),
    "The story does not show a channel composer.",
  );
  await openTab(page, PLAN);
  await shot(page, "channel-idle");

  // 1. The microphone is beside Send. A click records; Stop puts the transcript in the Plan draft.
  await startRecording(page, "Channel, Plan tab");
  await waitLiveText(page, "Channel, Plan tab");
  await shot(page, "channel-recording");
  await endRecording(page, "stop", "Channel, Plan tab");
  await waitDraft(page, TRANSCRIPT, "Stop in the Plan tab");
  report.steps.push({ name: "record and stop", detail: `Plan draft: "${await draftText(page)}"` });

  // 2. The other tab has its own draft; the first tab keeps the text.
  await openTab(page, NUMBERS);
  await waitDraft(page, "", "The Numbers tab");
  await openTab(page, PLAN);
  await waitDraft(page, TRANSCRIPT, "Back in the Plan tab");
  report.steps.push({ name: "switch tabs", detail: "Numbers draft empty, Plan draft kept" });

  // 3. Cancel discards the recording and keeps the draft.
  await openTab(page, NUMBERS);
  await startRecording(page, "Channel, Numbers tab");
  await endRecording(page, "cancel", "Channel, Numbers tab");
  await waitDraft(page, "", "Cancel in the Numbers tab");
  report.steps.push({ name: "cancel", detail: "Numbers draft still empty" });

  // 4. A recording of the Numbers tab: its live text and transcript stay in that tab while Plan is open.
  await startRecording(page, "Channel, Numbers tab again");
  await waitLiveText(page, "Channel, Numbers tab again");
  await openTab(page, PLAN);
  assert.equal(await liveText(page), "", "The live text of the Numbers recording shows in the Plan tab.");
  await shot(page, "channel-recording-other-tab");
  await endRecording(page, "stop", "Channel, recording of Numbers seen from Plan");
  await waitDraft(page, TRANSCRIPT, "The Plan tab after the Numbers recording");
  await openTab(page, NUMBERS);
  await waitDraft(page, TRANSCRIPT, "The Numbers tab after its recording");
  report.steps.push({ name: "recording in another tab", detail: "live text and transcript stayed in Numbers" });

  // 5. Send while recording: the draft and the transcript go to the tab of the recording.
  await openTab(page, PLAN);
  await startRecording(page, "Channel, send while recording");
  await composer(page)
    .getByRole("button", { name: english("composer.send.voice"), exact: true })
    .click();
  await waitSent(page, [`${PLAN}: ${TRANSCRIPT} ${TRANSCRIPT}`], "Send while recording in Plan");
  await waitDraft(page, "", "The Plan tab after its dictated message");
  await openTab(page, NUMBERS);
  await waitDraft(page, TRANSCRIPT, "The Numbers tab after the Plan send");
  report.steps.push({ name: "send while recording", detail: (await sentEntries(page)).join(" | ") });

  // 6. A typed send goes to the open tab and clears its draft.
  await composer(page)
    .getByRole("button", { name: english("composer.send.message"), exact: true })
    .click();
  await waitSent(
    page,
    [`${PLAN}: ${TRANSCRIPT} ${TRANSCRIPT}`, `${NUMBERS}: ${TRANSCRIPT}`],
    "Send of the Numbers draft",
  );
  await waitDraft(page, "", "The Numbers tab after its send");
  await openTab(page, PLAN);
  await waitDraft(page, "", "The Plan tab after the Numbers send");
  await shot(page, "channel-sent");
  report.steps.push({ name: "typed send", detail: (await sentEntries(page)).join(" | ") });
}

async function checkAgent(page: Page): Promise<void> {
  await page.goto(storyUrl("conversation-conversation--composer-dictation"), {
    waitUntil: "domcontentloaded",
    timeout: 300_000,
  });
  await editor(page).waitFor({ timeout: 240_000 });
  assert.notEqual(
    await editor(page).getAttribute("aria-label"),
    english("channel.composer.label"),
    "The agent story shows a channel composer.",
  );
  const before = await draftText(page);
  await startRecording(page, "Agent");
  await waitLiveText(page, "Agent");
  await endRecording(page, "stop", "Agent");
  await waitDraft(page, before ? `${before} ${TRANSCRIPT}` : TRANSCRIPT, "Stop in the agent chat");
  await shot(page, "agent-dictated");
  report.steps.push({ name: "agent composer", detail: `draft: "${await draftText(page)}"` });
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  // A fake microphone that Chromium grants without a prompt.
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
  ...(browserExecutable ? { executablePath: resolve(browserExecutable) } : {}),
});
try {
  for (const [name, check] of [
    ["channel", checkChannel],
    ["agent", checkAgent],
  ] as const) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, reducedMotion: "reduce" });
    await context.grantPermissions(["microphone"]);
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(`${name}: ${error.stack ?? error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") report.errors.push(`${name}: ${message.text().slice(0, 400)}`);
    });
    try {
      await check(page);
    } catch (error) {
      report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      await page.screenshot({ path: resolve(OUT, `failure-${name}.png`) }).catch(() => undefined);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const halted = report.errors.filter((error) => /REACTIVITY_HALTED|PRIMITIVE_IN_EFFECT_CALLBACK/u.test(error));
if (halted.length > 0) report.failures.push(`An error halted the page: ${halted[0]}`);
report.passed = report.failures.length === 0;
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.deepEqual(report.failures, [], "The channel voice input check found failures.");
