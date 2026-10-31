// Checks the Team panel ("Equipe") in a real browser with the app's stylesheet:
// `bun scripts/team-orbits-smoke.ts`. It serves the shared `OrbitsPanel` with Vite on 127.0.0.1,
// fed by `orbitsView` from the fixtures of its story (`src/renderer/stories/team-orbits-fixtures.ts`),
// and drives it with a headless Chromium of Playwright. The page holds the signals in a Solid signal,
// so the smoke changes them while the panel is open, as the app does. It checks that:
// 1. each agent's name says its state and model family, as the signals give them;
// 2. each channel with work is a system with its members, a section holds the agents of no channel,
//    a channel with no work does not show, and two channels of one coloured section differ in colour;
// 3. the top line counts the agents that generate, need the person, or stopped, and an old failed turn
//    is a still mark that the line does not count;
// 4. only the two agents that need attention most have a bubble, one in each system, and two agents of
//    one channel that ask the person do not stack their bubbles;
// 5. the model marks are those that generate, in a fixed order; a mark filters the counts, a second tap
//    clears the filter, and a filter on a family that leaves the panel clears;
// 6. an agent opens its card, and the card opens the channel of the work; a system name opens its
//    channel; a card closes when its system leaves, and does not open again when it comes back;
// 7. an agent that finishes with the panel open goes to the edge of its system;
// 8. a working planet does not cross the working sun on a full lap;
// 9. reduced motion stops every loop, a hidden window pauses them, the loops stay in the budget, and the
//    frame loop stops when no agent orbits or drifts;
// 10. a joined server shows no time, and an empty workspace shows the empty text, in English and
//    Portuguese.
// Writes .openbot-build/team-orbits/report.json and screenshots of the panel at 440 and 360 pixels wide
// (a window of 1334x900 and of 1090x780: the panel takes a third of the window, from 360 to 560 pixels),
// dark and light.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { createBuildersBotLogger } from "@openbot/logging";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { type Browser, chromium, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { findAvailablePort } from "./dev-services";

type Scenario = "busy" | "remote" | "quiet" | "still" | "backendDone" | "bugsGone" | "twoAsk";

declare global {
  interface Window {
    /** What the harness page recorded: the systems and the agents that a click opened. */
    __orbitsJumps?: { systems: string[]; agents: { id: string; channelId: string | null }[] };
    /** Gives the open panel the signals of another scenario. */
    __orbitsScenario?: (scenario: Scenario) => void;
    /** The frames that the page asked for since it loaded. */
    __orbitsFrames?: number;
    /** `requestAnimationFrame` as the browser gives it, which does not count. */
    __orbitsNativeFrame?: (callback: FrameRequestCallback) => number;
  }
}

const logger = createBuildersBotLogger("team-orbits-smoke");
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/team-orbits");
const HARNESS = resolve(OUT, "harness");
const UI_WAIT_MS = 30_000;
const en = translateFor("en");
const pt = translateFor("pt");

const HARNESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Team orbits smoke</title></head>
<body style="margin:0"><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`;

const HARNESS_MAIN = `import "../../../src/renderer/src/styles.css";
import { OrbitsPanel } from "@openbot/ui/features/orbits/OrbitsPanel";
import { orbitsView } from "@openbot/ui/features/orbits/orbits-view";
import { render } from "@solidjs/web";
import { createMemo, createSignal } from "solid-js";
import { StaticI18nProvider } from "../../../src/renderer/src/i18n-context";
import {
  ORBITS_BACKEND_DONE_INPUT,
  ORBITS_BUGS_GONE_INPUT,
  ORBITS_CHANNELS,
  ORBITS_INPUT,
  ORBITS_NOW,
  ORBITS_QUIET_INPUT,
  ORBITS_REMOTE_INPUT,
  ORBITS_TWO_ASK_INPUT,
} from "../../../src/renderer/stories/team-orbits-fixtures";

// Counts the frames that the page asks for, so the smoke can see when the frame loop stops.
const nativeFrame = window.requestAnimationFrame.bind(window);
window.__orbitsNativeFrame = nativeFrame;
window.__orbitsFrames = 0;
window.requestAnimationFrame = (callback) => {
  window.__orbitsFrames += 1;
  return nativeFrame(callback);
};

// Only the Segurança channel has work, and nothing in it orbits or drifts: its lead writes a message,
// and a member asks the person.
const STILL_INPUT = {
  ...ORBITS_QUIET_INPUT,
  channels: ORBITS_INPUT.channels.map((channel) =>
    channel.id === "seguranca" ? channel : { ...channel, activeTasks: 0, lastMessage: null },
  ),
  waits: { "red-team": ORBITS_INPUT.waits["red-team"] },
};
const inputs = {
  busy: ORBITS_INPUT,
  remote: ORBITS_REMOTE_INPUT,
  quiet: ORBITS_QUIET_INPUT,
  still: STILL_INPUT,
  backendDone: ORBITS_BACKEND_DONE_INPUT,
  bugsGone: ORBITS_BUGS_GONE_INPUT,
  twoAsk: ORBITS_TWO_ASK_INPUT,
};
const params = new URLSearchParams(location.search);
const first = params.get("scenario");
const [scenario, setScenario] = createSignal(first !== null && first in inputs ? first : "busy");
window.__orbitsScenario = (name) => setScenario(name);
document.documentElement.dataset.openbotColorScheme = params.get("scheme") === "light" ? "light" : "dark";
const jumps = { systems: [], agents: [] };
window.__orbitsJumps = jumps;
render(() => {
  const view = createMemo(() => orbitsView(inputs[scenario()]));
  return (
    <StaticI18nProvider locale={params.get("locale") === "pt" ? "pt" : "en"}>
      <OrbitsPanel
        open
        onOpenChange={() => undefined}
        view={view()}
        now={ORBITS_NOW}
        channelName={(id) => ORBITS_CHANNELS.find((channel) => channel.id === id)?.title ?? null}
        onOpenSystem={(system) => jumps.systems.push(system.targetId)}
        onOpenAgent={(agent) => jumps.agents.push({ id: agent.id, channelId: agent.place?.channelId ?? null })}
        initialSelectedId={params.get("select") ?? undefined}
        initialFamily={params.get("family") ?? undefined}
      />
    </StaticI18nProvider>
  );
}, document.getElementById("root"));
`;

interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}

const report: {
  checks: Check[];
  screenshots: string[];
  pageErrors: string[];
  /** Solid development warnings that name a component of the panel. */
  panelWarnings: string[];
  passed: boolean;
} = {
  checks: [],
  screenshots: [],
  pageErrors: [],
  panelWarnings: [],
  passed: false,
};

function check(name: string, passed: boolean, detail?: string) {
  report.checks.push(detail === undefined ? { name, passed } : { name, passed, detail });
  if (!passed) logger.error(`FAILED: ${name}`, { detail });
}

async function startHarness(): Promise<{ server: ViteDevServer; url: string }> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(HARNESS, { recursive: true });
  writeFileSync(resolve(HARNESS, "index.html"), HARNESS_HTML);
  writeFileSync(resolve(HARNESS, "main.tsx"), HARNESS_MAIN);
  const port = await findAvailablePort(6190, new Set());
  const server = await createServer({
    configFile: false,
    root: HARNESS,
    logLevel: "warn",
    // Only this computer can open it.
    server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [ROOT] } },
    plugins: [tailwindcss({ optimize: false }), solidPlugin()],
    optimizeDeps: { include: ["@norbert_bodziony/bloub"] },
    resolve: {
      alias: [{ find: "solid-js/web", replacement: "@solidjs/web" }],
      dedupe: ["solid-js", "@solidjs/web"],
    },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function openPanel(
  browser: Browser,
  url: string,
  options: {
    width: number;
    height: number;
    scheme?: "dark" | "light";
    scenario?: Scenario;
    locale?: "en" | "pt";
    select?: string;
    family?: string;
    reducedMotion?: boolean;
  },
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: 2,
    colorScheme: options.scheme ?? "dark",
    reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "warning" && /<Orbit/u.test(text) && !report.panelWarnings.includes(text)) {
      report.panelWarnings.push(text);
    }
  });
  const query = new URLSearchParams({
    scheme: options.scheme ?? "dark",
    scenario: options.scenario ?? "busy",
    locale: options.locale ?? "en",
    ...(options.select ? { select: options.select } : {}),
    ...(options.family ? { family: options.family } : {}),
  });
  await page.goto(`${url}?${query}`, { timeout: UI_WAIT_MS });
  const title = (options.locale ?? "en") === "pt" ? pt("app.orbits.title") : en("app.orbits.title");
  await page.getByRole("dialog", { name: title }).waitFor({ timeout: UI_WAIT_MS });
  // The systems measure themselves after the first frame.
  await page.waitForFunction(
    () => document.querySelectorAll(".orbit-rings").length > 0 || !!document.querySelector(".orbits-empty"),
    undefined,
    { timeout: UI_WAIT_MS },
  );
  return page;
}

/** The window sizes where the panel is 440 and 360 pixels wide. */
const WIDE = { width: 1334, height: 900 } as const;
const NARROW = { width: 1090, height: 780 } as const;

/** A screenshot of the panel, or of the whole window with `window`, after the panel and its card end their entry. */
async function shot(page: Page, name: string, window = false) {
  const path = resolve(OUT, `${name}.png`);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  if (window) await page.screenshot({ path });
  else await page.locator(".orbits-panel").screenshot({ path });
  report.screenshots.push(path);
}

const agentButton = (page: Page, name: string, model: string, state: string) =>
  page.getByRole("button", { name: en("app.orbits.agentLabel", { name, model, state }), exact: true });

const systemRegion = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

const countText = async (page: Page) => (await page.locator(".orbits-count").innerText()).replace(/\s+/g, " ");

/** Gives the open panel the signals of another scenario. */
async function setScenario(page: Page, scenario: Scenario) {
  await page.evaluate((name) => window.__orbitsScenario?.(name), scenario);
}

/** Waits for `count` frames of the browser, with the frame function that the harness does not count. */
async function waitFrames(page: Page, count: number) {
  await page.evaluate(
    (frames) =>
      new Promise<void>((done) => {
        let left = frames;
        const step = () => {
          left -= 1;
          if (left <= 0) done();
          else window.__orbitsNativeFrame?.(step);
        };
        window.__orbitsNativeFrame?.(step);
      }),
    count,
  );
}

/** The frames that the page asked for while the browser drew `count` frames. */
async function framesAskedDuring(page: Page, count: number) {
  const before = await page.evaluate(() => window.__orbitsFrames ?? 0);
  await waitFrames(page, count);
  return (await page.evaluate(() => window.__orbitsFrames ?? 0)) - before;
}

/** The bubbles of the panel: their text, the system that holds each one, and their boxes. */
async function bubbles(page: Page) {
  return page.locator(".orbit-bubble").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        text: node.textContent ?? "",
        system: node.closest("section")?.getAttribute("aria-label") ?? "",
        box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      };
    }),
  );
}

type Box = { left: number; top: number; right: number; bottom: number };
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function checkStates(page: Page) {
  const expected: [string, string, string][] = [
    ["Backend", "Opus", en("app.orbits.state.working")],
    ["Líder Produto", "Opus", en("app.orbits.state.speaking")],
    ["Design", "Sonnet", en("app.orbits.state.thinking")],
    ["Front", "Opus", en("app.orbits.state.waiting")],
    ["Red Team", "Opus", en("app.orbits.state.waitingYou")],
    ["Narrador", "Haiku", en("app.orbits.state.stalled")],
    ["QA", "Sonnet", en("app.orbits.state.failed")],
    ["Front Fluxos", "Opus", en("app.orbits.state.done")],
    ["Registro", "Haiku", en("app.orbits.state.idle")],
    ["Pesquisa", "Grok", en("app.orbits.state.working")],
    ["Revisor", "ChatGPT", en("app.orbits.state.waiting")],
    ["Tradutor", "Kimi", en("app.orbits.state.waiting")],
  ];
  for (const [name, model, state] of expected) {
    check(
      `state and family: ${name} is ${model}, ${state}`,
      (await agentButton(page, name, model, state).count()) === 1,
    );
  }

  const members = async (name: string) =>
    systemRegion(page, name)
      .locator("[data-orbit-agent]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-orbit-agent")));
  const produto = await members("Produto");
  check(
    "grouping: the Produto channel holds its lead and its six members",
    produto.length === 7 && produto[0] === "lider-produto",
    produto.join(","),
  );
  const personal = await members("Pessoal");
  check(
    "grouping: the agents of no channel are in their section",
    personal.join(",") === "pesquisa,revisor,tradutor",
    personal.join(","),
  );
  check("grouping: a channel with no work does not show", (await systemRegion(page, "Marketing").count()) === 0);
  const colours = await page
    .locator("section.orbit-system")
    .evaluateAll((nodes) =>
      nodes.slice(0, 5).map((node) => getComputedStyle(node).getPropertyValue("--orbit-color").trim()),
    );
  check(
    "colour: the five channels of one coloured section have five colours",
    new Set(colours).size === 5,
    colours.join(" | "),
  );

  const counts = await countText(page);
  check(
    "counts: 12 generating, 1 needs you, 1 stopped (the old failed turn does not count)",
    counts.includes(en("app.orbits.working", { count: 12 })) &&
      counts.includes(en("app.orbits.needsYou", { count: 1 })) &&
      counts.includes(en("app.orbits.stalled", { count: 1 })),
    counts,
  );
  const failedLoops = await page.evaluate(
    () => document.querySelector('[data-orbit-agent="qa"]')?.getAnimations({ subtree: true }).length ?? -1,
  );
  check("failed: an old failed turn is a still mark with no loop", failedLoops === 0, String(failedLoops));

  const shown = await bubbles(page);
  check(
    "attention: only the question and the first message have a bubble, one in each system",
    shown.length === 2 &&
      shown.some((bubble) => bubble.text.startsWith("Posso rodar") && bubble.system === "Segurança") &&
      shown.some((bubble) => bubble.text.startsWith("Distribuí") && bubble.system === "Produto"),
    JSON.stringify(shown.map((bubble) => [bubble.system, bubble.text])),
  );
}

async function checkChips(page: Page) {
  const chips = await page
    .locator(".orbits-chips button")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));
  check(
    "chips: only the families that generate show, in a fixed order",
    chips.join(",") === "Opus,Sonnet,Haiku,Grok",
    chips.join(","),
  );
  const bar = await page.locator(".orbits-bar").evaluate((node) => {
    const chipsBox = node.querySelector(".orbits-chips")?.getBoundingClientRect();
    const countBox = node.querySelector(".orbits-count")?.getBoundingClientRect();
    if (!chipsBox || !countBox) return { offset: -1, sizes: "" };
    return {
      offset: Math.abs(chipsBox.top + chipsBox.height / 2 - (countBox.top + countBox.height / 2)),
      sizes: `bar ${node.clientWidth}, marks ${chipsBox.width.toFixed(0)}, count ${countBox.width.toFixed(0)}`,
    };
  });
  check(
    "chips: the marks and the count share one line at 440 pixels",
    bar.offset >= 0 && bar.offset < 4,
    `${bar.offset.toFixed(0)}: ${bar.sizes}`,
  );
}

async function checkFilter(page: Page) {
  const opusChip = page.getByRole("button", { name: en("app.orbits.familyChip", { name: "Opus", count: 5 }) });
  await opusChip.click();
  const pressed = await opusChip.getAttribute("aria-pressed");
  const opusCount = await countText(page);
  check(
    "filter: the Opus mark keeps the 5 Opus agents that generate",
    pressed === "true" && opusCount.includes(en("app.orbits.working", { count: 5 })),
    `${pressed} ${opusCount}`,
  );
  check(
    "filter: an agent of another family dims, and keeps its place",
    (await page.locator('[data-orbit-agent="editor"][data-filtered]').count()) === 1,
  );
  await shot(page, "440-dark-filter-opus");
  await opusChip.click();
  check("filter: a second tap clears the filter", (await opusChip.getAttribute("aria-pressed")) === "false");
}

async function checkCardAndJumps(page: Page) {
  await agentButton(page, "Narrador", "Haiku", en("app.orbits.state.stalled")).click();
  const card = page.getByRole("dialog", { name: "Narrador" });
  await card.waitFor({ timeout: UI_WAIT_MS });
  const cardText = (await card.innerText()).replace(/\s+/g, " ");
  check(
    "card: the stopped agent shows its task and why it stopped",
    cardText.includes("Gerando a voz do episódio") &&
      cardText.includes(en("app.orbits.card.stopped", { reason: "O provedor de voz não respondeu." })),
    cardText,
  );
  await shot(page, "440-dark-card-narrador");
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "detached", timeout: UI_WAIT_MS });
  check(
    "card: Escape closes the card and leaves the panel open",
    (await page.getByRole("dialog", { name: en("app.orbits.title") }).count()) === 1,
  );
  // A working agent moves all the time, so the keyboard opens it: the focus and Enter.
  await agentButton(page, "Backend", "Opus", en("app.orbits.state.working")).focus();
  await page.keyboard.press("Enter");
  const backend = page.getByRole("dialog", { name: "Backend" });
  await backend.waitFor({ timeout: UI_WAIT_MS });
  const backendText = (await backend.innerText()).replace(/\s+/g, " ");
  const goChannel = backend.getByRole("button", { name: en("app.orbits.openChannel", { name: "Produto" }) });
  check(
    "card: running work shows its request and its time, and one button names its channel",
    backendText.includes("Lado do servidor da v2.1") &&
      backendText.includes(en("app.orbits.card.running", { count: 12 })) &&
      (await goChannel.count()) === 1,
    backendText,
  );
  await goChannel.click();
  await page.getByRole("button", { name: en("app.orbits.openChannel", { name: "Vídeos" }) }).click();
  const jumps = await page.evaluate(() => window.__orbitsJumps);
  check(
    "jump: the card opens the channel of the work, and a name opens its channel",
    jumps?.agents.some((entry) => entry.id === "backend" && entry.channelId === "produto") === true &&
      jumps.systems.includes("videos"),
    JSON.stringify(jumps),
  );
}

/** The signals change while the panel is open. */
async function checkChanges(page: Page) {
  // An agent finishes its work.
  await setScenario(page, "backendDone");
  const done = agentButton(page, "Backend", "Opus", en("app.orbits.state.done"));
  await done.waitFor({ timeout: UI_WAIT_MS });
  check(
    "change: an agent that finishes goes to the edge of its system, and the count drops",
    (await done.getAttribute("data-kind")) === "tiny" &&
      (await countText(page)).includes(en("app.orbits.working", { count: 11 })),
    await countText(page),
  );
  await setScenario(page, "busy");
  await agentButton(page, "Backend", "Opus", en("app.orbits.state.working")).waitFor({ timeout: UI_WAIT_MS });

  // A system leaves while the card of its sun is open, and the filter is on a family that leaves.
  const grokChip = page.getByRole("button", { name: en("app.orbits.familyChip", { name: "Grok", count: 1 }) });
  await grokChip.click();
  await agentButton(page, "Triagem", "Sonnet", en("app.orbits.state.working")).click();
  await page.getByRole("dialog", { name: "Triagem" }).waitFor({ timeout: UI_WAIT_MS });
  await setScenario(page, "bugsGone");
  await systemRegion(page, "Bugs").waitFor({ state: "detached", timeout: UI_WAIT_MS });
  await page.waitForFunction(() => document.querySelectorAll("[data-orbit-agent][data-filtered]").length === 0);
  const hiddenBubbles = await page.locator(".orbit-bubble[data-hidden]").count();
  const gone = await countText(page);
  check(
    "change: the card of an agent that leaves closes, and the bubbles show again",
    (await page.getByRole("dialog", { name: "Triagem" }).count()) === 0 && hiddenBubbles === 0,
    String(hiddenBubbles),
  );
  check(
    "change: a filter on a family that leaves clears, so no agent stays dim",
    (await page.locator(".orbits-chips button[aria-pressed='true']").count()) === 0 &&
      gone.includes(en("app.orbits.working", { count: 10 })),
    gone,
  );
  await setScenario(page, "busy");
  await systemRegion(page, "Bugs").waitFor({ timeout: UI_WAIT_MS });
  await waitFrames(page, 10);
  check(
    "change: the card does not open again when its agent comes back",
    (await page.getByRole("dialog", { name: "Triagem" }).count()) === 0,
  );

  // Two agents of one channel ask the person.
  await setScenario(page, "twoAsk");
  await page.locator(".orbit-bubble", { hasText: "Posso apagar" }).waitFor({ timeout: UI_WAIT_MS });
  await waitFrames(page, 2);
  const asked = await bubbles(page);
  const systems = new Set(asked.map((bubble) => bubble.system));
  const [left, right] = asked;
  check(
    "attention: two agents of one channel that ask get one bubble, and the next bubble goes to another system",
    asked.length === 2 &&
      systems.size === 2 &&
      asked.some((bubble) => bubble.system === "Produto" && bubble.text.startsWith("Posso apagar")) &&
      asked.some((bubble) => bubble.system === "Segurança" && bubble.text.startsWith("Posso rodar")) &&
      left !== undefined &&
      right !== undefined &&
      !overlaps(left.box, right.box),
    JSON.stringify(asked.map((bubble) => [bubble.system, bubble.text])),
  );
  await page.locator(".orbits-scroll").evaluate((node) => node.scrollTo({ top: 0 }));
  await shot(page, "440-dark-two-ask");
  await setScenario(page, "busy");
}

/** A working planet passes over and under the working sun of the Release channel on each lap. */
async function checkRings(page: Page) {
  const gap = await page.evaluate(
    () =>
      new Promise<number>((done) => {
        const region = [...document.querySelectorAll("section.orbit-system")].find(
          (node) => node.getAttribute("aria-label") === "Release",
        );
        const sun = region?.querySelector<HTMLElement>('[data-orbit-agent="lider-release"]');
        const planet = region?.querySelector<HTMLElement>('[data-orbit-agent="release-bot"]');
        const sunRing = sun?.querySelector<SVGSVGElement>(".orbit-progress");
        const planetRing = planet?.querySelector<SVGSVGElement>(".orbit-progress");
        if (!sun || !planet || !sunRing || !planetRing) {
          done(-1000);
          return;
        }
        // The drawn edge of a working ring: the circle (r 19) and half its stroke (1.1) in a 44 box.
        const edge = (ring: SVGSVGElement) => ((ring.clientWidth / 2) * 20.1) / 22;
        const center = (node: HTMLElement) => {
          const box = node.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2, scale: box.width / node.offsetWidth };
        };
        let smallest = Number.POSITIVE_INFINITY;
        // One lap is 3.6 seconds: 260 frames at 60 frames a second cover it.
        let left = 260;
        const step = () => {
          const a = center(sun);
          const b = center(planet);
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          smallest = Math.min(smallest, distance - edge(sunRing) * a.scale - edge(planetRing) * b.scale);
          left -= 1;
          if (left <= 0) done(smallest);
          else window.__orbitsNativeFrame?.(step);
        };
        window.__orbitsNativeFrame?.(step);
      }),
  );
  check("rings: a working planet does not cross the working sun on a full lap", gap > 0, gap.toFixed(1));
}

async function checkMotion(browser: Browser, url: string, page: Page) {
  const running = await page.evaluate(
    () => document.getAnimations().filter((animation) => animation.playState === "running").length,
  );
  check("motion: the loops stay in the budget of 60", running > 0 && running <= 60, String(running));
  const busyFrames = await framesAskedDuring(page, 20);
  check("motion: the frame loop runs while agents orbit", busyFrames >= 10, String(busyFrames));

  // A hidden window pauses every loop.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() => document.querySelector(".orbits-scroll")?.getAttribute("data-motion") === "off");
  const stillRunning = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((animation) => animation.playState === "running" && animation instanceof CSSAnimation).length,
  );
  check("motion: a hidden window pauses the loops", stillRunning === 0, String(stillRunning));
  await waitFrames(page, 3);
  const hiddenFrames = await framesAskedDuring(page, 20);
  check("motion: a hidden window stops the frame loop", hiddenFrames === 0, String(hiddenFrames));

  // Nothing orbits or drifts: the frame loop stops after its last frame.
  const still = await openPanel(browser, url, { ...WIDE, scenario: "still" });
  // The first frames place the nodes and draw the links.
  await waitFrames(still, 10);
  const stillFrames = await framesAskedDuring(still, 30);
  check("motion: the frame loop stops when no agent orbits or drifts", stillFrames === 0, String(stillFrames));
  await still.context().close();
}

async function checkBusy(browser: Browser, url: string) {
  const page = await openPanel(browser, url, WIDE);
  await checkStates(page);
  await checkChips(page);
  await shot(page, "440-dark");
  await checkRings(page);
  await checkFilter(page);
  await checkCardAndJumps(page);
  await checkChanges(page);
  await checkMotion(browser, url, page);
  await page.context().close();

  for (const [size, name, scheme] of [
    [WIDE, "440", "light"],
    [NARROW, "360", "dark"],
    [NARROW, "360", "light"],
  ] as const) {
    const sized = await openPanel(browser, url, { ...size, scheme });
    await shot(sized, `${name}-${scheme}`);
    if (name === "440") await shot(sized, `window-${scheme}`, true);
    await sized.context().close();
  }
  const lightCard = await openPanel(browser, url, { ...WIDE, scheme: "light", select: "front" });
  await shot(lightCard, "440-light-card-front");
  await lightCard.context().close();
  const smallFilter = await openPanel(browser, url, { ...NARROW, scheme: "light", family: "sonnet" });
  await shot(smallFilter, "360-light-filter-sonnet");
  await smallFilter.context().close();
}

async function checkReducedMotion(browser: Browser, url: string) {
  const page = await openPanel(browser, url, { ...WIDE, reducedMotion: true });
  // A loop repeats without end. A fade as the dialog opens is not a loop: reduced motion keeps it.
  const animations = await page.evaluate(() =>
    document
      .getAnimations()
      .flatMap((animation) =>
        animation instanceof CSSAnimation && animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY
          ? [animation.animationName]
          : [],
      ),
  );
  check("motion: reduced motion stops every loop", animations.length === 0, animations.join(" | "));
  await waitFrames(page, 3);
  const frames = await framesAskedDuring(page, 20);
  check("motion: reduced motion runs no frame loop", frames === 0, String(frames));
  await shot(page, "440-dark-reduced");
  await page.context().close();
}

async function checkRemoteAndEmpty(browser: Browser, url: string) {
  const remote = await openPanel(browser, url, { ...WIDE, scenario: "remote", select: "backend" });
  const remoteCard = (await remote.getByRole("dialog", { name: "Backend" }).innerText()).replace(/\s+/g, " ");
  check(
    "joined server: the card has no request time, and the agent still works",
    !remoteCard.includes(en("app.orbits.card.running", { count: 12 })) &&
      (await agentButton(remote, "Backend", "Opus", en("app.orbits.state.working")).count()) === 1,
    remoteCard,
  );
  await remote.context().close();
  for (const locale of ["en", "pt"] as const) {
    const quiet = await openPanel(browser, url, { ...WIDE, scenario: "quiet", locale });
    const text = locale === "pt" ? pt("app.orbits.empty") : en("app.orbits.empty");
    check(
      `empty: the panel says that nothing runs, also with old failed turns (${locale})`,
      (await quiet.getByText(text).count()) === 1,
    );
    await shot(quiet, `440-dark-empty-${locale}`);
    await quiet.context().close();
  }
  const portuguese = await openPanel(browser, url, { ...WIDE, scheme: "light", locale: "pt" });
  check(
    "language: the panel reads in Portuguese",
    (await portuguese.getByRole("dialog", { name: pt("app.orbits.title") }).count()) === 1 &&
      (await portuguese.getByText(pt("app.orbits.working", { count: 12 })).count()) === 1,
  );
  await shot(portuguese, "440-light-pt");
  await portuguese.context().close();
}

const { server, url } = await startHarness();
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true });
  await checkBusy(browser, url);
  await checkReducedMotion(browser, url);
  await checkRemoteAndEmpty(browser, url);
} catch (error) {
  check("run", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  await browser?.close();
  await server.close();
}
report.passed = report.pageErrors.length === 0 && report.checks.every((entry) => entry.passed);
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
logger.info(`${report.checks.filter((entry) => entry.passed).length} of ${report.checks.length} checks passed.`, {
  report: resolve(OUT, "report.json"),
});
if (!report.passed) process.exitCode = 1;
