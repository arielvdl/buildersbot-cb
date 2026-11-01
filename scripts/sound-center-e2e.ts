// Checks the sound center (`docs/architecture/sounds.md`) end to end.
//
// 1. Main, with the real `SoundPreferenceStore` on a temporary app folder and the real `sound-port.ts`,
//    with an Electron `Notification` that records its options and a `shell.beep` that counts:
//    - nothing saved reads as not saved; a saved preference reads back from the file after a restart,
//      and an event or a choice that this version does not know is dropped;
//    - a macOS notification of an event plays the macOS default, a named macOS sound, or is silent
//      when the event is off or everything is muted, and each one goes to Recent sounds;
//    - Recent sounds keeps the newest 20;
//    - a custom sound file is copied into the app folder and read back by its id; a file of the wrong
//      type, an empty or too large file, an unknown id and a path as an id are refused.
// 2. The Sounds section in Storybook (`Settings/Sounds`), with the real sound center and the in-memory
//    main of the preview, in a headless browser. The browser counts each audio node that starts:
//    - the page plays nothing when it opens;
//    - the choices of an older version (task sound "Bubbly", action sounds "Mechanical") move in;
//    - every event of the registry shows its name;
//    - an event that is off plays nothing and Recent sounds says so; "Mute all" keeps everything
//      quiet; a sound about the recording plays while the person dictates, the others do not;
//    - a new sound choice is saved, and the key of the older version follows it (downgrade);
//    - the play button plays the sound without an entry in Recent sounds;
//    - Recent sounds lists a Guard question and work that the task reviewer resumed, with who caused it.
// 3. `scripts/sound-port-guard.ts` fails on a file with a stray `new Audio(...)`, and passes on the repository.
//
//   bun scripts/sound-center-e2e.ts --storybook=http://localhost:6006 [--browser-executable=<path>]
//
// Without `--storybook`, part 2 is skipped and the report says so.
// Writes .openbot-build/sound-center-e2e/report.json and a screenshot in the same folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CUSTOM_SOUND_MAX_BYTES,
  decodeSoundCenterState,
  decodeSoundPreference,
  SOUND_EVENTS,
  type SoundCenterState,
} from "@openbot/contracts/ipc";
import { translateFor } from "@openbot/i18n";
import { plugin } from "bun";
import { Effect } from "effect";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import { messages as englishSettings } from "../packages/i18n/src/messages/en/settings";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/sound-center-e2e");
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const storybook = argument("storybook")?.replace(/\/$/u, "");
const browserExecutable = argument("browser-executable");
const english = translateFor("en");

interface NotificationOptions {
  title: string;
  body: string;
  silent?: boolean;
  sound?: string;
}
interface RecordedNotification {
  options: NotificationOptions;
}
const notifications: RecordedNotification[] = [];
let beeps = 0;

plugin({
  name: "sound-center-electron-boundary",
  setup(build) {
    class RecordingNotification {
      constructor(options: NotificationOptions) {
        notifications.push({ options });
      }
      static isSupported() {
        return true;
      }
    }
    build.module("electron", () => ({
      loader: "object",
      exports: {
        Notification: RecordingNotification,
        shell: {
          beep: () => {
            beeps += 1;
          },
        },
      },
    }));
  },
});

/** One check: its name, and "passed", "FAILED: <reason>" or the data that it read, as JSON. */
interface StepEntry {
  name: string;
  result: string;
}
interface Report {
  main: StepEntry[];
  ui: StepEntry[] | "skipped: no --storybook";
  guard: StepEntry[];
  pageErrors: string[];
  failures: string[];
  passed: boolean;
}
const report: Report = {
  main: [],
  ui: "skipped: no --storybook",
  guard: [],
  pageErrors: [],
  failures: [],
  passed: false,
};

async function step(name: string, run: () => Promise<unknown> | unknown, into: StepEntry[]) {
  try {
    const data = await run();
    into.push({ name, result: typeof data === "object" && data !== null ? JSON.stringify(data) : "passed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    into.push({ name, result: `FAILED: ${message}` });
    report.failures.push(`${name}: ${message}`);
  }
}

/** A short valid WAV file: 0.1 s of a quiet tone, 8 kHz, 8 bit. */
function wavBytes(): Uint8Array {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  for (let index = 0; index < samples; index += 1) bytes[44 + index] = 128 + Math.round(20 * Math.sin(index / 4));
  return bytes;
}

async function checkMain(): Promise<void> {
  const { SoundPreferenceStore, SOUND_PREFERENCE_FILE, CUSTOM_SOUND_FOLDER } = await import(
    "../src/main/sound-preference-store"
  );
  const { appNotification, setNativeSoundSource, playSystemAlertSound } = await import("../src/main/sound-port");
  const userData = await mkdtemp(join(tmpdir(), "sound-center-e2e-"));
  const into = report.main;
  try {
    const store = new SoundPreferenceStore({ userData });
    await step(
      "nothing saved reads as not saved",
      async () => {
        await Effect.runPromise(store.load());
        assert.equal(store.state().saved, false);
        assert.deepEqual(store.state().preference, { muteAll: false, events: {} });
      },
      into,
    );
    await step(
      "a saved preference reads back after a restart",
      async () => {
        await Effect.runPromise(
          store.set({
            muteAll: false,
            events: {
              "notification.machine-alert": { enabled: true, sound: "Glass", volume: 100, customSoundId: null },
              "notification.agent": { enabled: false, sound: "default", volume: 100, customSoundId: null },
            },
          }),
        );
        const again = new SoundPreferenceStore({ userData });
        await Effect.runPromise(again.load());
        assert.equal(again.state().saved, true);
        assert.equal(again.state().preference.events["notification.machine-alert"]?.sound, "Glass");
        const file = JSON.parse(readFileSync(join(userData, SOUND_PREFERENCE_FILE), "utf8"));
        assert.equal(file.version, 1);
        return { file };
      },
      into,
    );
    await step(
      "an unknown event or choice of a newer version is dropped",
      () => {
        const decoded = decodeSoundPreference({
          muteAll: false,
          events: {
            "agent.reply-finished": {
              enabled: true,
              sound: "a-sound-of-a-newer-version",
              volume: 50,
              customSoundId: null,
            },
            "an.event.of.a.newer.version": { enabled: true, sound: "classic", volume: 50, customSoundId: null },
            "agent.work-finished": { enabled: false, sound: "classic", volume: 400, customSoundId: null },
          },
        });
        assert.deepEqual(Object.keys(decoded.events), ["agent.work-finished"]);
        assert.equal(decoded.events["agent.work-finished"]?.volume, 100);
      },
      into,
    );
    await step(
      "a macOS notification takes the sound of its event, and goes to Recent sounds",
      () => {
        setNativeSoundSource(store);
        notifications.length = 0;
        appNotification("notification.machine-alert", { title: "Disk", body: "98%" }, "This Mac");
        appNotification("notification.agent", { title: "Ana", body: "Done" }, "Ana");
        appNotification("notification.channel-reply", { title: "Team", body: "Reply" }, null);
        assert.deepEqual(notifications[0]?.options, { title: "Disk", body: "98%", sound: "Glass" });
        assert.deepEqual(notifications[1]?.options, { title: "Ana", body: "Done", silent: true });
        assert.deepEqual(notifications[2]?.options, { title: "Team", body: "Reply" });
        const recent = store.state().recent;
        assert.deepEqual(
          recent.slice(0, 3).map((entry) => [entry.eventId, entry.outcome, entry.who]),
          [
            ["notification.channel-reply", "played", null],
            ["notification.agent", "event-off", "Ana"],
            ["notification.machine-alert", "played", "This Mac"],
          ],
        );
        return notifications.map((notification) => notification.options);
      },
      into,
    );
    await step(
      "Mute all makes every macOS notification silent",
      async () => {
        await Effect.runPromise(store.set({ ...store.preference(), muteAll: true }));
        notifications.length = 0;
        appNotification("notification.channel-reply", { title: "Team", body: "Reply" }, null);
        assert.equal(notifications[0]?.options.silent, true);
        assert.equal(store.state().recent[0]?.outcome, "mute-all");
        await Effect.runPromise(store.set({ ...store.preference(), muteAll: false }));
      },
      into,
    );
    await step(
      "the system sound plays through the port",
      () => {
        playSystemAlertSound();
        assert.equal(beeps, 1);
      },
      into,
    );
    await step(
      "Recent sounds keeps the newest 20",
      () => {
        for (let index = 0; index < 25; index += 1)
          store.report({ eventId: "agent.work-finished", outcome: "played", who: `agent ${index}`, sound: "classic" });
        const recent = store.state().recent;
        assert.equal(recent.length, 20);
        assert.equal(recent[0]?.who, "agent 24");
      },
      into,
    );
    const sources = await mkdtemp(join(tmpdir(), "sound-center-e2e-files-"));
    await step(
      "a custom sound is copied into the app folder and read back by its id",
      async () => {
        const path = join(sources, "Chime.wav");
        writeFileSync(path, wavBytes());
        const added = await Effect.runPromise(store.addCustomSound(path));
        assert.match(added.id, /^[0-9a-f-]{36}\.wav$/u);
        assert.equal(added.name, "Chime.wav");
        assert.deepEqual(readdirSync(join(userData, CUSTOM_SOUND_FOLDER)), [added.id]);
        const bytes = await Effect.runPromise(store.readCustomSound(added.id));
        assert.deepEqual(bytes, wavBytes());
        return added;
      },
      into,
    );
    await step(
      "a wrong type, an empty or too large file, an unknown id and a path are refused",
      async () => {
        const fake = join(sources, "notes.mp3");
        writeFileSync(fake, "This is text, not sound.");
        const failures: string[] = [];
        const refusals: ReadonlyArray<readonly [string, () => Effect.Effect<unknown, unknown>]> = [
          ["text named .mp3", () => store.addCustomSound(fake)],
          ["script", () => store.addCustomSound(join(sources, "run.sh"))],
          ["empty", () => store.addCustomSound(join(sources, "empty.wav"))],
          ["too large", () => store.addCustomSound(join(sources, "large.wav"))],
          ["unknown id", () => store.readCustomSound("00000000-0000-4000-8000-000000000000.wav")],
          ["path as id", () => store.readCustomSound("../openbot-sound-preference-v1.json")],
        ];
        for (const [name, run] of refusals) {
          if (name === "script") writeFileSync(join(sources, "run.sh"), "#!/bin/sh\necho no\n");
          if (name === "empty") writeFileSync(join(sources, "empty.wav"), "");
          if (name === "too large") {
            const large = new Uint8Array(CUSTOM_SOUND_MAX_BYTES + 1);
            large.set(wavBytes().subarray(0, 12));
            writeFileSync(join(sources, "large.wav"), large);
          }
          const result = await Effect.runPromise(Effect.result(run()));
          if (!("failure" in result)) failures.push(name);
        }
        assert.deepEqual(failures, []);
        assert.equal(readdirSync(join(userData, CUSTOM_SOUND_FOLDER)).length, 1);
      },
      into,
    );
    rmSync(sources, { recursive: true, force: true });
  } finally {
    setNativeSoundSource(null);
    rmSync(userData, { recursive: true, force: true });
  }
}

/** The sound center module of the story page: the same instance as the one that the section reads. */
async function soundCenterUrl(page: Page): Promise<string> {
  const url = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => /\/src\/renderer\/src\/sound-center\.ts(?:\?|$)/u.test(name)),
  );
  if (!url) throw new Error("The story page did not load sound-center.ts.");
  return url;
}

/** Turns a switch with the keyboard, as a keyboard user does. */
async function toggle(control: Locator): Promise<void> {
  await control.focus();
  await control.press("Space");
}

async function play(page: Page, url: string, id: string, who: string | null = null) {
  await page.evaluate(
    async ({ url, id, who }) => {
      const center = await import(/* @vite-ignore */ url);
      center.playSound(id, { who });
    },
    { url, id, who },
  );
}

/** How many audio nodes started in the page: the init script counts them. */
async function audioStarts(page: Page): Promise<number> {
  const count = Number(await page.evaluate("window.__soundStarts"));
  if (!Number.isFinite(count)) throw new Error("The page has no audio count.");
  return count;
}

/** The sound center as the in-memory main of the story keeps it. */
async function centerState(page: Page): Promise<SoundCenterState> {
  return decodeSoundCenterState(await page.evaluate("window.openbot.notifications.getSounds()"));
}

async function waitForRecent(page: Page, predicate: (state: SoundCenterState) => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate(await centerState(page))) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`Recent sounds did not show ${label}.`);
}

async function checkUi(browser: Browser): Promise<void> {
  const into: StepEntry[] = [];
  report.ui = into;
  const context = await browser.newContext({ viewport: { width: 1100, height: 1400 } });
  // Older-version choices in this browser, and a count of each audio node that starts.
  await context.addInitScript(`
    localStorage.setItem("openbot:task-sound", "bubble");
    localStorage.setItem("openbot:completion-sound-enabled", "true");
    localStorage.setItem("openbot:action-sounds-enabled", "true");
    localStorage.setItem("openbot:action-sounds-theme", "mech");
    // Storybook loads more modules than the default 250 resource entries; the check finds a module by its entry.
    performance.setResourceTimingBufferSize(20000);
    window.__soundStarts = 0;
    const start = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (...args) {
      window.__soundStarts += 1;
      return start.apply(this, args);
    };
  `);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${storybook}/iframe.html?id=settings-sounds--default&viewMode=story&globals=locale:en`);
  await page.getByText(english("settings.sounds.muteAll.title")).waitFor();
  const url = await soundCenterUrl(page);
  const recentList = () => page.locator("section", { hasText: english("settings.sounds.recent.title") }).last();

  await step("the page plays nothing when it opens", async () => assert.equal(await audioStarts(page), 0), into);
  await step(
    "the choices of an older version move in",
    async () => {
      await waitForRecent(page, (state) => state.saved, "a saved preference");
      const { preference } = await centerState(page);
      assert.deepEqual(preference.events["agent.reply-finished"], {
        enabled: true,
        sound: "bubble",
        volume: 100,
        customSoundId: null,
      });
      assert.equal(preference.events["interface.controls"]?.sound, "mech");
      assert.equal(preference.events["guard.question"]?.enabled, true);
      const trigger = page.getByRole("button", {
        name: english("settings.sounds.soundFor", { name: english("settings.sounds.event.replyFinished.title") }),
      });
      assert.equal((await trigger.textContent())?.trim(), english("settings.soundTheme.bubble"));
    },
    into,
  );
  await step(
    "every event of the registry shows its name",
    async () => {
      const titles = Object.entries(englishSettings).flatMap(([key, title]) =>
        /^settings\.sounds\.event\.[A-Za-z]+\.title$/u.test(key) && typeof title === "string"
          ? [[key, title] as const]
          : [],
      );
      assert.equal(titles.length, SOUND_EVENTS.length);
      const missing: string[] = [];
      for (const [, title] of titles)
        if ((await page.getByText(title, { exact: true }).count()) === 0) missing.push(title);
      assert.deepEqual(missing, []);
      return titles.map(([, title]) => title);
    },
    into,
  );
  await step(
    "an event that is off plays nothing",
    async () => {
      const name = english("settings.sounds.event.replyFinished.title");
      await toggle(page.getByRole("switch", { name: english("settings.sounds.enabled", { name }) }));
      await waitForRecent(page, (state) => state.preference.events["agent.reply-finished"]?.enabled === false, "off");
      const before = await audioStarts(page);
      await play(page, url, "agent.reply-finished", "Ana");
      await waitForRecent(page, (state) => state.recent[0]?.outcome === "event-off", "event-off");
      assert.equal(await audioStarts(page), before);
      await recentList().getByText(english("settings.sounds.recent.eventOff")).first().waitFor();
      await toggle(page.getByRole("switch", { name: english("settings.sounds.enabled", { name }) }));
      await waitForRecent(page, (state) => state.preference.events["agent.reply-finished"]?.enabled === true, "on");
      await play(page, url, "agent.reply-finished", "Ana");
      await waitForRecent(page, (state) => state.recent[0]?.outcome === "played", "played");
      assert.ok((await audioStarts(page)) > before, "the sound played once the event was on again");
    },
    into,
  );
  await step(
    "Mute all keeps every sound quiet",
    async () => {
      await toggle(page.getByRole("switch", { name: english("settings.sounds.muteAll.title") }));
      await waitForRecent(page, (state) => state.preference.muteAll, "mute all");
      const before = await audioStarts(page);
      await play(page, url, "guard.question", "Guard");
      await waitForRecent(page, (state) => state.recent[0]?.outcome === "mute-all", "mute-all");
      assert.equal(await audioStarts(page), before);
      await toggle(page.getByRole("switch", { name: english("settings.sounds.muteAll.title") }));
      await waitForRecent(page, (state) => !state.preference.muteAll, "unmuted");
    },
    into,
  );
  await step(
    "while the person dictates, only the sounds about the recording play",
    async () => {
      await page.evaluate(
        async (url) => (await import(/* @vite-ignore */ url)).setSoundsQuietFor("dictation:e2e", true),
        url,
      );
      await play(page, url, "agent.reply-finished", "Ana");
      await waitForRecent(page, (state) => state.recent[0]?.outcome === "speaking", "speaking");
      await play(page, url, "voice.limit-warning");
      await waitForRecent(
        page,
        (state) => state.recent[0]?.eventId === "voice.limit-warning" && state.recent[0]?.outcome === "played",
        "the limit warning",
      );
      await page.evaluate(
        async (url) => (await import(/* @vite-ignore */ url)).setSoundsQuietFor("dictation:e2e", false),
        url,
      );
    },
    into,
  );
  await step(
    "a new sound is saved, and the key of the older version follows it",
    async () => {
      const name = english("settings.sounds.event.replyFinished.title");
      await page.getByRole("button", { name: english("settings.sounds.soundFor", { name }) }).click();
      await page.getByRole("option", { name: english("settings.soundTheme.classic"), exact: true }).click();
      await waitForRecent(
        page,
        (state) => state.preference.events["agent.reply-finished"]?.sound === "classic",
        "classic",
      );
      assert.equal(await page.evaluate(() => localStorage.getItem("openbot:task-sound")), "classic");
    },
    into,
  );
  await step(
    "the play button plays the sound without an entry in Recent sounds",
    async () => {
      const recentBefore = (await centerState(page)).recent.length;
      const before = await audioStarts(page);
      const name = english("settings.sounds.event.guardQuestion.title");
      await page.getByRole("button", { name: english("settings.sounds.preview", { name }) }).click();
      for (let attempt = 0; attempt < 60 && (await audioStarts(page)) === before; attempt += 1)
        await page.waitForTimeout(50);
      assert.ok((await audioStarts(page)) > before, "the preview played");
      assert.equal((await centerState(page)).recent.length, recentBefore);
    },
    into,
  );
  await step(
    "Recent sounds lists a Guard question and the work that the task reviewer resumed",
    async () => {
      await play(page, url, "guard.question", "Guard");
      await play(page, url, "agent.work-finished", "Builder");
      await waitForRecent(page, (state) => state.recent[0]?.eventId === "agent.work-finished", "the resumed work");
      const list = recentList();
      await list.getByText(english("settings.sounds.event.guardQuestion.title")).first().waitFor();
      await list.getByText(english("settings.sounds.event.workFinished.title")).first().waitFor();
      await list
        .getByText(english("settings.sounds.recent.who", { who: "Builder" }), { exact: false })
        .first()
        .waitFor();
      mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: join(OUT, "sounds-section.png"), fullPage: true });
      return (await centerState(page)).recent.slice(0, 5);
    },
    into,
  );
  report.pageErrors = errors;
  if (errors.length) report.failures.push(`page errors: ${errors.join(" | ")}`);
  await context.close();
}

function checkGuard(): void {
  const into = report.guard;
  const probe = resolve(ROOT, "src/renderer/src/sound-center-e2e-stray.ts");
  try {
    writeFileSync(probe, 'export const chime = new Audio("chime.mp3");\n');
    const stray = spawnSync("bun", ["scripts/sound-port-guard.ts", "--files", probe], { cwd: ROOT, encoding: "utf8" });
    into.push({
      name: "a stray new Audio fails the guard",
      result: stray.status === 1 ? "passed" : `FAILED: exit ${stray.status}`,
    });
    if (stray.status !== 1) report.failures.push("the guard did not fail on a stray new Audio");
  } finally {
    rmSync(probe, { force: true });
  }
  const clean = spawnSync("bun", ["scripts/sound-port-guard.ts"], { cwd: ROOT, encoding: "utf8" });
  into.push({
    name: "the repository passes the guard",
    result: clean.status === 0 ? "passed" : `FAILED: ${clean.stdout}`,
  });
  if (clean.status !== 0) report.failures.push("the repository does not pass the guard");
}

await checkMain();
checkGuard();
if (storybook) {
  const browser = await chromium.launch(
    browserExecutable ? { executablePath: resolve(browserExecutable), headless: true } : { headless: true },
  );
  try {
    await checkUi(browser);
  } finally {
    await browser.close();
  }
}
report.passed = report.failures.length === 0;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
