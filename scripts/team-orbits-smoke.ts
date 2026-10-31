// Checks the Team panel ("Equipe") in a real browser with the app's stylesheet:
// `bun scripts/team-orbits-smoke.ts`. It serves the shared `OrbitsPanel` with Vite on 127.0.0.1,
// fed by `orbitsView` from the fixtures of its story (`src/renderer/stories/team-orbits-fixtures.ts`),
// and drives it with a headless Chromium of Playwright. It checks that:
// 1. each agent's name says its state and model family, as the signals give them;
// 2. each channel with work is a system with its members, a section holds the agents of no channel,
//    and a channel with no work does not show;
// 3. the top line counts the agents that generate, need the person, or stopped;
// 4. only the two agents that need attention most have a bubble;
// 5. a model mark filters the counts, and a second tap clears the filter;
// 6. an agent opens its card, and the card opens the channel of the work; a system name opens its channel;
// 7. reduced motion stops every loop, a hidden window pauses them, and the loops stay in the budget;
// 8. a joined server shows no time, and an empty workspace shows the empty text, in English and Portuguese.
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

declare global {
  interface Window {
    /** What the harness page recorded: the systems and the agents that a click opened. */
    __orbitsJumps?: { systems: string[]; agents: { id: string; channelId: string | null }[] };
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
import { StaticI18nProvider } from "../../../src/renderer/src/i18n-context";
import {
  ORBITS_CHANNELS,
  ORBITS_INPUT,
  ORBITS_NOW,
  ORBITS_QUIET_INPUT,
  ORBITS_REMOTE_INPUT,
} from "../../../src/renderer/stories/team-orbits-fixtures";

const params = new URLSearchParams(location.search);
const inputs = { busy: ORBITS_INPUT, remote: ORBITS_REMOTE_INPUT, quiet: ORBITS_QUIET_INPUT };
const scenario = params.get("scenario");
const input = scenario === "remote" || scenario === "quiet" ? inputs[scenario] : inputs.busy;
document.documentElement.dataset.openbotColorScheme = params.get("scheme") === "light" ? "light" : "dark";
const jumps = { systems: [], agents: [] };
window.__orbitsJumps = jumps;
render(
  () => (
    <StaticI18nProvider locale={params.get("locale") === "pt" ? "pt" : "en"}>
      <OrbitsPanel
        open
        onOpenChange={() => undefined}
        view={orbitsView(input)}
        now={ORBITS_NOW}
        channelName={(id) => ORBITS_CHANNELS.find((channel) => channel.id === id)?.title ?? null}
        onOpenSystem={(system) => jumps.systems.push(system.targetId)}
        onOpenAgent={(agent) => jumps.agents.push({ id: agent.id, channelId: agent.place?.channelId ?? null })}
        initialSelectedId={params.get("select") ?? undefined}
        initialFamily={params.get("family") ?? undefined}
      />
    </StaticI18nProvider>
  ),
  document.getElementById("root"),
);
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
    scenario?: "busy" | "remote" | "quiet";
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
    {
      timeout: UI_WAIT_MS,
    },
  );
  return page;
}

/** The window sizes where the panel is 440 and 360 pixels wide. */
const WIDE = { width: 1334, height: 900 } as const;
const NARROW = { width: 1090, height: 780 } as const;

/** A screenshot of the panel, or of the whole window with `window`. */
async function shot(page: Page, name: string, window = false) {
  const path = resolve(OUT, `${name}.png`);
  if (window) await page.screenshot({ path });
  else await page.locator(".orbits-panel").screenshot({ path });
  report.screenshots.push(path);
}

const agentButton = (page: Page, name: string, model: string, state: string) =>
  page.getByRole("button", { name: en("app.orbits.agentLabel", { name, model, state }), exact: true });

async function checkBusy(browser: Browser, url: string) {
  const page = await openPanel(browser, url, WIDE);
  const expected: [string, string, string][] = [
    ["Backend IA Naia", "Opus", en("app.orbits.state.working")],
    ["Lider Opus", "Opus", en("app.orbits.state.speaking")],
    ["Design Advisor", "Sonnet", en("app.orbits.state.thinking")],
    ["Front Naia", "Opus", en("app.orbits.state.waiting")],
    ["Red Team", "Opus", en("app.orbits.state.waitingYou")],
    ["Narrador", "Haiku", en("app.orbits.state.stalled")],
    ["Front Fluxos Naia", "Opus", en("app.orbits.state.done")],
    ["QA Naia", "Sonnet", en("app.orbits.state.idle")],
    ["Pesquisa Grok", "Grok", en("app.orbits.state.working")],
    ["Revisor Codex", "ChatGPT", en("app.orbits.state.waiting")],
  ];
  for (const [name, model, state] of expected) {
    check(
      `state and family: ${name} is ${model}, ${state}`,
      (await agentButton(page, name, model, state).count()) === 1,
    );
  }

  const system = (name: string) => page.getByRole("region", { name, exact: true });
  const members = async (name: string) =>
    system(name)
      .locator("[data-orbit-agent]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-orbit-agent")));
  const naia = await members("Naia");
  check(
    "grouping: the Naia channel holds its lead and its six members",
    naia.length === 7 && naia[0] === "lider-opus",
    naia.join(","),
  );
  const personal = await members("Pessoal");
  check(
    "grouping: the agents of no channel are in their section",
    personal.join(",") === "pesquisa-grok,revisor-codex",
    personal.join(","),
  );
  check("grouping: a channel with no work does not show", (await system("Marketing").count()) === 0);

  const countText = (await page.locator(".orbits-count").innerText()).replace(/\s+/g, " ");
  check(
    "counts: 12 generating, 1 needs you, 1 stopped",
    countText.includes(en("app.orbits.working", { count: 12 })) &&
      countText.includes(en("app.orbits.needsYou", { count: 1 })) &&
      countText.includes(en("app.orbits.stalled", { count: 1 })),
    countText,
  );

  const bubbles = await page.locator(".orbit-bubble").allInnerTexts();
  check(
    "attention: only the question and the first message have a bubble",
    bubbles.length === 2 &&
      bubbles.some((text) => text.startsWith("Posso rodar")) &&
      bubbles.some((text) => text.startsWith("Distribuí")),
    bubbles.join(" | "),
  );

  const running = await page.evaluate(
    () => document.getAnimations().filter((animation) => animation.playState === "running").length,
  );
  check("motion: the loops stay in the budget of 60", running > 0 && running <= 60, String(running));

  await shot(page, "440-dark");

  // The model filter.
  const opusChip = page.getByRole("button", { name: en("app.orbits.familyChip", { name: "Opus", count: 5 }) });
  await opusChip.click();
  const pressed = await opusChip.getAttribute("aria-pressed");
  const opusCount = (await page.locator(".orbits-count").innerText()).replace(/\s+/g, " ");
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

  // The card, and the jumps.
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
  await agentButton(page, "Backend IA Naia", "Opus", en("app.orbits.state.working")).focus();
  await page.keyboard.press("Enter");
  const backend = page.getByRole("dialog", { name: "Backend IA Naia" });
  await backend.waitFor({ timeout: UI_WAIT_MS });
  const backendText = (await backend.innerText()).replace(/\s+/g, " ");
  check(
    "card: running work shows its request, its time and its channel",
    backendText.includes("Lado do servidor da v2.1") &&
      backendText.includes(en("app.orbits.card.running", { count: 12 })) &&
      backendText.includes(en("app.orbits.card.in", { channel: "Naia" })),
    backendText,
  );
  await backend.getByRole("button", { name: en("app.orbits.card.goChannel") }).click();
  await page.getByRole("button", { name: en("app.orbits.openChannel", { name: "Vídeos" }) }).click();
  const jumps = await page.evaluate(() => window.__orbitsJumps);
  check(
    "jump: the card opens the channel of the work, and a name opens its channel",
    jumps?.agents.some((entry) => entry.id === "backend-ia-naia" && entry.channelId === "naia") === true &&
      jumps.systems.includes("videos"),
    JSON.stringify(jumps),
  );

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
  const lightCard = await openPanel(browser, url, { ...WIDE, scheme: "light", select: "front-naia" });
  await shot(lightCard, "440-light-card-front-naia");
  await lightCard.context().close();
  const smallFilter = await openPanel(browser, url, { ...NARROW, scheme: "light", family: "sonnet" });
  await shot(smallFilter, "360-light-filter-sonnet");
  await smallFilter.context().close();
}

async function checkReducedMotion(browser: Browser, url: string) {
  const page = await openPanel(browser, url, { ...WIDE, reducedMotion: true });
  const animations = await page.evaluate(
    () => document.getAnimations().filter((animation) => animation instanceof CSSAnimation).length,
  );
  check("motion: reduced motion stops every loop", animations === 0, String(animations));
  await shot(page, "440-dark-reduced");
  await page.context().close();
}

async function checkRemoteAndEmpty(browser: Browser, url: string) {
  const remote = await openPanel(browser, url, { ...WIDE, scenario: "remote", select: "backend-ia-naia" });
  const remoteCard = (await remote.getByRole("dialog", { name: "Backend IA Naia" }).innerText()).replace(/\s+/g, " ");
  check(
    "joined server: the card has no request time, and the agent still works",
    !remoteCard.includes(en("app.orbits.card.running", { count: 12 })) &&
      (await agentButton(remote, "Backend IA Naia", "Opus", en("app.orbits.state.working")).count()) === 1,
    remoteCard,
  );
  await remote.context().close();
  for (const locale of ["en", "pt"] as const) {
    const quiet = await openPanel(browser, url, { ...WIDE, scenario: "quiet", locale });
    const text = locale === "pt" ? pt("app.orbits.empty") : en("app.orbits.empty");
    check(`empty: the panel says that nothing runs (${locale})`, (await quiet.getByText(text).count()) === 1);
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
