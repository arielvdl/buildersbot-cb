// Checks the Guard's siren (`packages/ui/src/features/guard/GuardSiren.tsx` and `guard-siren.css`).
//
// 1. The stylesheet, read as text: each keyframe animates only `transform` and `opacity`; each rule
//    that starts an animation is in the `prefers-reduced-motion: no-preference` block, reads
//    `--guard-siren-play`, and has no `filter`, `drop-shadow`, `box-shadow` or `backdrop-filter`; no
//    rule of the siren uses them at all; and a `prefers-reduced-motion: reduce` block exists.
// 2. The stories in Storybook, with the real components and CSS, in a headless browser:
//    - each siren runs three animations at most, and they animate only `transform` and `opacity`;
//    - on a page with only the rendered siren and the real stylesheets, a siren that turns causes no
//      style recalculation, no layout and no paint on the main thread; next to an animation that the
//      main thread draws on each frame (a conversation that changes), it adds no layout and no style
//      recalculation to the ones of that animation alone;
//    - with reduced motion nothing animates; a hidden document pauses every animation;
//    - the card of a Guard question shows the compact siren, which turns, hidden from screen readers;
//    - the Guard page shows the siren at the top and the level cards under it. A card sets the level
//      (Off), the level list follows, and the list sets it back (Light) while the cards follow; the
//      arrow keys move between the levels that can be chosen; the stricter levels cannot be chosen.
//      The page says the state in text, with a contrast of at least 4.5 (3 for the large level name)
//      in the dark and the light theme;
//    - while the page reads the Guard, it names no level and the cards cannot be chosen;
//    - a question of the Guard sounds the alarm of the page, but not a question of a joined server.
// The checks read the text, the state of the controls and the animations, not the markup.
// Pass the URL that `bun run storybook` reports:
//
//   bun scripts/guard-siren-e2e.ts --storybook=http://localhost:6006 [--css=<path>] [--browser-executable=<path>]
//
// `--css` checks another copy of the stylesheet (part 1 only), to see the check fail on a bad rule.
// Writes .openbot-build/guard-siren-e2e/report.json and the screenshots in the same folder.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/guard-siren-e2e");
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const cssPath = resolve(argument("css") ?? resolve(ROOT, "packages/ui/src/features/guard/guard-siren.css"));
const storybook = argument("storybook")?.replace(/\/$/u, "");
const browserExecutable = argument("browser-executable");

type Theme = "dark" | "light";
type Locale = "en" | "pt";

interface Report {
  css: { path: string; keyframes: string[]; animatedRules: string[]; passed: boolean };
  stories: {
    animations: { sirens: number; perSiren: number[]; properties: string[] } | null;
    cost: { alone: CostSample; control: CostSample; withControl: CostSample } | null;
    reducedMotion: { animations: number; beamsShown: number } | null;
    hidden: { paused: string[]; resumed: string[] } | null;
    card: { animations: number; ariaHidden: string | null; title: string } | null;
    page: { theme: Theme; locale: Locale; steps: string[]; contrast: { level: number; status: number } }[];
    loading: { status: string; levelNames: string[]; disabledRadios: number; checkedRadios: number } | null;
    asking: { story: string; status: string; animations: number }[];
  };
  screenshots: string[];
  errors: string[];
  failures: string[];
  passed: boolean;
}

interface CostSample {
  animations: number;
  recalcStyle: number;
  layout: number;
  mainThreadPaint: number;
  advancedMs: number;
}

const report: Report = {
  css: { path: cssPath, keyframes: [], animatedRules: [], passed: false },
  stories: {
    animations: null,
    cost: null,
    reducedMotion: null,
    hidden: null,
    card: null,
    page: [],
    loading: null,
    asking: [],
  },
  screenshots: [],
  errors: [],
  failures: [],
  passed: false,
};

function fail(message: string): void {
  report.failures.push(message);
}

/* Part 1: the stylesheet. */

interface CssRule {
  prelude: string;
  parents: string[];
  declarations: [string, string][];
}

/** The leaf rules of a stylesheet with the at-rules round them. Comments are dropped. */
function parseCss(text: string): CssRule[] {
  const source = text.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: CssRule[] = [];
  const stack: { prelude: string; start: number }[] = [];
  let segment = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      stack.push({ prelude: source.slice(segment, index).trim(), start: index + 1 });
      segment = index + 1;
    } else if (character === "}") {
      const open = stack.pop();
      if (!open) throw new Error(`An unmatched } in ${cssPath}.`);
      const body = source.slice(open.start, index);
      if (!body.includes("{")) {
        const declarations = body
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part): [string, string] => {
            const colon = part.indexOf(":");
            return [part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim()];
          });
        rules.push({ prelude: open.prelude, parents: stack.map((item) => item.prelude), declarations });
      }
      segment = index + 1;
    } else if (character === ";") {
      segment = index + 1;
    }
  }
  if (stack.length > 0) throw new Error(`An unclosed { in ${cssPath}.`);
  return rules;
}

const COSTLY = /^(?:filter|backdrop-filter|-webkit-backdrop-filter|box-shadow)$/u;

function checkCss(): void {
  const rules = parseCss(readFileSync(cssPath, "utf8"));
  const failures: string[] = [];
  for (const rule of rules) {
    const keyframes = rule.parents.find((parent) => parent.startsWith("@keyframes"));
    if (keyframes) {
      report.css.keyframes.push(`${keyframes} ${rule.prelude}`);
      for (const [property] of rule.declarations) {
        if (property !== "transform" && property !== "opacity") {
          failures.push(`${keyframes} animates ${property}; only transform and opacity may move.`);
        }
      }
      continue;
    }
    for (const [property, value] of rule.declarations) {
      if (COSTLY.test(property) || /drop-shadow\(/u.test(value)) {
        failures.push(`${rule.prelude} sets ${property}: ${value}; the siren uses no filter or shadow.`);
      }
    }
    const animation = rule.declarations.find(
      ([property, value]) => (property === "animation" || property === "animation-name") && value !== "none",
    );
    if (!animation) continue;
    report.css.animatedRules.push(rule.prelude);
    if (!rule.parents.some((parent) => /prefers-reduced-motion:\s*no-preference/u.test(parent))) {
      failures.push(`${rule.prelude} starts an animation outside the prefers-reduced-motion: no-preference block.`);
    }
    if (
      !rule.declarations.some(
        ([property, value]) => property === "animation-play-state" && value.includes("--guard-siren-play"),
      )
    ) {
      failures.push(`${rule.prelude} starts an animation that --guard-siren-play cannot pause.`);
    }
  }
  if (!rules.some((rule) => rule.parents.some((parent) => /prefers-reduced-motion:\s*reduce/u.test(parent)))) {
    failures.push("The stylesheet has no prefers-reduced-motion: reduce rule.");
  }
  if (report.css.animatedRules.length === 0)
    failures.push("The stylesheet starts no animation; the check reads nothing.");
  report.css.passed = failures.length === 0;
  report.failures.push(...failures);
}

/* Part 2: the stories. */

function storyUrl(id: string, theme: Theme = "dark", locale: Locale = "en", args = ""): string {
  return `${storybook}/iframe.html?id=${id}&viewMode=story&globals=locale:${locale};colorScheme:${theme}${args ? `&args=${args}` : ""}`;
}

async function openStory(
  browser: Browser,
  id: string,
  options: {
    theme?: Theme;
    locale?: Locale;
    reducedMotion?: boolean;
    width?: number;
    height?: number;
    args?: string;
    /** Text that shows when the story is ready. Without it, the story is ready when a siren shows. */
    waitFor?: string;
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1200, height: options.height ?? 820 },
    deviceScaleFactor: 2,
    reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${id}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(`${id}: ${message.text().slice(0, 300)}`);
  });
  await page.goto(storyUrl(id, options.theme, options.locale, options.args), {
    waitUntil: "domcontentloaded",
    timeout: 300_000,
  });
  await (options.waitFor ? page.getByText(options.waitFor, { exact: true }) : page.locator(".guard-siren"))
    .first()
    .waitFor({ timeout: 240_000 });
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((animation) => animation.ready));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  return { context, page };
}

async function screenshot(page: Page, name: string): Promise<void> {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path });
  report.screenshots.push(path);
}

/** Stops each animation at the same point of its turn, so two screenshots are the same. */
async function freeze(page: Page, phase: number): Promise<void> {
  await page.evaluate((value) => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = value * Number(animation.effect?.getTiming().duration ?? 0);
    }
  }, phase);
}

/** The animations of each siren on the page, and the properties they animate. */
async function sirenAnimations(page: Page) {
  return page.evaluate(() => {
    const sirens = [...document.querySelectorAll(".guard-siren")];
    const perSiren = sirens.map(() => 0);
    const properties = new Set<string>();
    const meta = new Set(["offset", "computedOffset", "easing", "composite"]);
    const costly: string[] = [];
    for (const animation of document.getAnimations()) {
      const effect = animation.effect instanceof KeyframeEffect ? animation.effect : null;
      const target = effect?.target ?? null;
      const index = target ? sirens.findIndex((siren) => siren.contains(target)) : -1;
      if (index < 0 || !target) continue;
      perSiren[index] = (perSiren[index] ?? 0) + 1;
      for (const frame of effect?.getKeyframes() ?? []) {
        for (const key of Object.keys(frame)) if (!meta.has(key)) properties.add(key);
      }
      for (
        let node: Element | null = target;
        node && node !== sirens[index]?.parentElement;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        if (style.filter !== "none" || style.boxShadow !== "none" || style.backdropFilter !== "none") {
          costly.push(`${node.getAttribute("class")}: ${style.filter} ${style.boxShadow} ${style.backdropFilter}`);
        }
      }
    }
    return { sirens: sirens.length, perSiren, properties: [...properties].sort(), costly };
  });
}

interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  args?: { name?: string };
}

function isTraceEvent(value: unknown): value is TraceEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "ph" in value &&
    typeof value.ph === "string" &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "tid" in value &&
    typeof value.tid === "number"
  );
}

function traceEvents(trace: unknown): TraceEvent[] {
  if (typeof trace !== "object" || trace === null || !("traceEvents" in trace)) return [];
  return Array.isArray(trace.traceEvents) ? trace.traceEvents.filter(isTraceEvent) : [];
}

async function checkLevels(browser: Browser): Promise<void> {
  for (const theme of ["dark", "light"] as const) {
    const { context, page } = await openStory(browser, "guard-guardsiren--levels", { theme });
    try {
      if (theme === "dark") {
        const animations = await sirenAnimations(page);
        report.stories.animations = {
          sirens: animations.sirens,
          perSiren: animations.perSiren,
          properties: animations.properties,
        };
        if (animations.sirens !== 10) fail(`The Levels story shows ${animations.sirens} sirens, not 10.`);
        if (animations.perSiren.some((count) => count > 3))
          fail(`A siren runs more than 3 animations: ${animations.perSiren.join(", ")}.`);
        // Off and Light at rest do not move; Strict and Very strict turn; each level that asks turns.
        const expected = [0, 0, 2, 3, 0, 0, 3, 3, 3, 3];
        if (animations.perSiren.join() !== expected.join()) {
          fail(`The animations per siren are ${animations.perSiren.join(", ")}, not ${expected.join(", ")}.`);
        }
        if (animations.properties.some((property) => property !== "transform" && property !== "opacity")) {
          fail(`A siren animates ${animations.properties.join(", ")}; only transform and opacity may move.`);
        }
        if (animations.costly.length > 0) fail(`An animated part has a filter or a shadow: ${animations.costly[0]}.`);
      }
      await freeze(page, 0.2);
      await screenshot(page, `levels-${theme}`);
    } finally {
      await context.close();
    }
  }
}

// The stylesheets that draw the siren, in the order of `src/renderer/src/styles.css`.
const STYLESHEETS = [
  "packages/brand/src/tokens.css",
  "packages/brand/src/tokens-light.css",
  "packages/brand/src/logo.css",
  "packages/ui/src/features/guard/guard-siren.css",
];

/**
 * An animation that the main thread draws on each frame, as a conversation does while its text
 * arrives: a background color that changes. Without it, a page that does not change draws no frame
 * on the main thread, and a part of the siren that makes each such frame lay out the page again costs
 * nothing.
 */
const CONTROL = `<div class="cost-control"></div><style>@keyframes cost-control { to { background-color: var(--openbot-guard-siren-red); } }
.cost-control { width: 40px; height: 40px; background: var(--openbot-bg-surface); animation: cost-control 1s linear infinite alternate; }</style>`;

/** Writes a page with the real stylesheets of the siren and `body`, so the work of Storybook does not count. */
function costPage(name: string, body: string): string {
  const links = STYLESHEETS.map(
    (path) => `<link rel="stylesheet" href="${pathToFileURL(resolve(ROOT, path)).href}" />`,
  );
  const file = resolve(OUT, `${name}.html`);
  writeFileSync(
    file,
    `<!doctype html><html data-openbot-color-scheme="dark"><head><meta charset="utf-8" />${links.join("")}
<style>body { margin: 0; padding: 24px; width: 760px; background: var(--openbot-bg-canvas); }</style></head>
<body>${body}</body></html>`,
  );
  return file;
}

/** The style recalculations, layouts and main thread paints of a page during a time window. */
async function measureWindow(browser: Browser, file: string): Promise<CostSample> {
  const context = await browser.newContext({ viewport: { width: 820, height: 520 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`cost page: ${error.message}`));
  try {
    await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().map((animation) => animation.ready));
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const metrics = async () =>
      Object.fromEntries(
        (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]),
      );
    // `getAnimations` updates the style, so the script reads the time of the turn outside the window.
    const time = () => page.evaluate(() => Number(document.getAnimations()[0]?.currentTime ?? 0));
    const windowMs = 2000;
    const start = await time();
    await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
    const before = await metrics();
    // The cost is the work during a time window, so this wait is the measure.
    await page.waitForTimeout(windowMs);
    const after = await metrics();
    const events = traceEvents(JSON.parse((await browser.stopTracing()).toString()));
    const end = await time();
    const threads = new Map<string, string>();
    for (const event of events)
      if (event.name === "thread_name") threads.set(`${event.pid}:${event.tid}`, event.args?.name ?? "");
    const mainThreadPaint = events.filter(
      (event) =>
        event.name === "Paint" && event.ph !== "E" && threads.get(`${event.pid}:${event.tid}`) === "CrRendererMain",
    ).length;
    const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0);
    return {
      animations: await page.evaluate(() => document.getAnimations().length),
      recalcStyle: delta("RecalcStyleCount"),
      layout: delta("LayoutCount"),
      mainThreadPaint,
      advancedMs: Math.round(end - start),
    };
  } finally {
    await context.close();
  }
}

/**
 * The cost of a siren that turns: alone on a page, the control animation alone, and the two together.
 * With the control, the siren may add no layout and no style recalculation; two frames of difference
 * between the two windows are allowed.
 */
async function measureCost(browser: Browser, markup: string): Promise<void> {
  const alone = await measureWindow(browser, costPage("cost", markup));
  const control = await measureWindow(browser, costPage("cost-control", CONTROL));
  const withControl = await measureWindow(browser, costPage("cost-with-control", `${markup}${CONTROL}`));
  report.stories.cost = { alone, control, withControl };
  if (alone.animations !== 3) fail(`The isolated asking siren runs ${alone.animations} animations, not 3.`);
  if (alone.advancedMs < 1000) fail(`The siren did not turn: ${alone.advancedMs} ms.`);
  if (alone.recalcStyle !== 0) fail(`The siren caused ${alone.recalcStyle} style recalculations.`);
  if (alone.layout !== 0) fail(`The siren caused ${alone.layout} layouts.`);
  if (alone.mainThreadPaint !== 0) fail(`The siren caused ${alone.mainThreadPaint} paints on the main thread.`);
  if (control.recalcStyle < 30) fail(`The control drew ${control.recalcStyle} frames; the measure reads nothing.`);
  if (withControl.layout > control.layout + 2) {
    fail(`Next to the control, the siren caused ${withControl.layout} layouts, not ${control.layout}.`);
  }
  if (withControl.recalcStyle > control.recalcStyle + 2) {
    fail(
      `Next to the control, the siren caused ${withControl.recalcStyle} style recalculations, not ${control.recalcStyle}.`,
    );
  }
}

async function checkCost(browser: Browser): Promise<void> {
  // The trace reads every page of the browser, so the story page closes before the measure.
  const story = await openStory(browser, "guard-guardsiren--hero-asking");
  const markup = await story.page.evaluate(() => document.querySelector(".guard-siren-hero")?.outerHTML ?? "");
  await story.context.close();
  await measureCost(browser, markup);
  const { context, page } = await openStory(browser, "guard-guardsiren--hero-asking");
  try {
    // A hidden document pauses the siren; a shown one runs it again.
    const states = () => page.evaluate(() => document.getAnimations().map((animation) => animation.playState));
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState === "paused"));
    const paused = await states();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState === "running"));
    const resumed = await states();
    report.stories.hidden = { paused, resumed };
    if (paused.length !== 3) fail(`The asking siren runs ${paused.length} animations, not 3.`);
    await freeze(page, 0.35);
    await screenshot(page, "hero-asking-dark");
  } finally {
    await context.close();
  }
}

async function checkReducedMotion(browser: Browser): Promise<void> {
  const { context, page } = await openStory(browser, "guard-guardsiren--levels", { reducedMotion: true });
  try {
    report.stories.reducedMotion = await page.evaluate(() => ({
      animations: document.getAnimations().length,
      beamsShown: [...document.querySelectorAll(".guard-siren-beams")].filter(
        (beams) => getComputedStyle(beams).display !== "none",
      ).length,
    }));
    if (report.stories.reducedMotion.animations !== 0) {
      fail(`With reduced motion, ${report.stories.reducedMotion.animations} animations still run.`);
    }
    if (report.stories.reducedMotion.beamsShown !== 0) fail("With reduced motion, the beams still show.");
    await screenshot(page, "levels-dark-reduced-motion");
  } finally {
    await context.close();
  }
}

async function checkCard(browser: Browser): Promise<void> {
  for (const [id, theme, width] of [
    ["conversation-approvalcard--guard-question", "dark", 760],
    ["conversation-approvalcard--guard-question", "light", 760],
    ["conversation-approvalcard--guard-question-narrow", "dark", 420],
  ] as const) {
    const { context, page } = await openStory(browser, id, { theme, width, height: 520 });
    try {
      const card = await page.evaluate(() => {
        const siren = document.querySelector(".approval-card .guard-siren");
        const animations = document.getAnimations().filter((animation) => {
          const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
          return target ? (siren?.contains(target) ?? false) : false;
        });
        return {
          animations: animations.length,
          ariaHidden: siren?.getAttribute("aria-hidden") ?? null,
          title: document.querySelector(".approval-card-header strong")?.textContent ?? "",
        };
      });
      if (theme === "dark" && width === 760) report.stories.card = card;
      // The alarm is the one mode with three animations: the beams, the reflector and the halo.
      if (card.animations !== 3) fail(`The siren of a Guard question runs ${card.animations} animations, not 3.`);
      if (card.ariaHidden !== "true") fail("The siren of a Guard question is not hidden from screen readers.");
      if (card.title !== "The Guard asks you to confirm") fail(`The card title is "${card.title}".`);
      await freeze(page, 0.3);
      await screenshot(page, `card-${id.endsWith("narrow") ? "narrow" : "wide"}-${theme}`);
    } finally {
      await context.close();
    }
  }
}

const PAGE_TEXT = {
  en: {
    siren: "The Guard's siren",
    choose: "Choose the level",
    level: "Level",
    names: ["Off", "Light", "Strict", "Very strict", "Custom"],
    light: "Light",
    off: "Off",
    offOption: "Off (asleep)",
    later: ["Strict", "Very strict", "Custom"],
    soon: "Soon",
    loading: "Reading the state of the Guard…",
    signedOut: "Calm. Only the local check runs: you are not signed in to Cultura Builder.",
    asleep: "Nothing is checked until you choose Light.",
    asking: "Asking you now. Answer on the card in the conversation.",
  },
  pt: {
    siren: "A sirene do Guarda",
    choose: "Escolha o nível",
    level: "Nível",
    names: ["Desligado", "Leve", "Exigente", "Muito exigente", "Personalizado"],
    light: "Leve",
    off: "Desligado",
    offOption: "Desligado (dormindo)",
    later: ["Exigente", "Muito exigente", "Personalizado"],
    soon: "Em breve",
    loading: "Lendo o estado do Guarda…",
    signedOut: "Calmo. Só a verificação local roda: você não entrou no Cultura Builder.",
    asleep: "Nada é conferido até você escolher Leve.",
    asking: "Perguntando a você agora. Responda no cartão da conversa.",
  },
} as const;

/** The contrast of the text of `selector` with the first background behind it that is not clear. */
async function textContrast(page: Page, selector: string): Promise<number> {
  return page.evaluate((query) => {
    const element = document.querySelector(query);
    if (!element) return 0;
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context2d = canvas.getContext("2d", { willReadFrequently: true });
    if (!context2d) return 0;
    const rgb = (color: string) => {
      context2d.clearRect(0, 0, 1, 1);
      context2d.fillStyle = color;
      context2d.fillRect(0, 0, 1, 1);
      return [...context2d.getImageData(0, 0, 1, 1).data.slice(0, 4)];
    };
    let background = [0, 0, 0, 0];
    for (let node: Element | null = element; node; node = node.parentElement) {
      background = rgb(getComputedStyle(node).backgroundColor);
      if ((background[3] ?? 0) > 200) break;
    }
    const linear = (value: number) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: number[]) =>
      0.2126 * linear(color[0] ?? 0) + 0.7152 * linear(color[1] ?? 0) + 0.0722 * linear(color[2] ?? 0);
    const text = luminance(rgb(getComputedStyle(element).color));
    const back = luminance(background);
    return Math.round(((Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05)) * 100) / 100;
  }, selector);
}

async function chooseLevel(page: Page, levelName: string, option: string): Promise<void> {
  await page.locator(`.ui-select-trigger[aria-label="${levelName}"]`).click();
  await page.locator("[data-popper-positioner] [role=option]", { hasText: option }).first().click();
  await page.locator("[data-popper-positioner]").waitFor({ state: "detached", timeout: 5_000 });
}

/** The text of the siren region, the level name and the state, as the catalog writes it (not in capitals). */
async function sirenText(page: Page, locale: Locale): Promise<string> {
  return (await page.getByRole("region", { name: PAGE_TEXT[locale].siren }).textContent()) ?? "";
}

/** Waits until the state of the siren region is `status`, and gives the text of the region. */
async function waitForStatus(page: Page, locale: Locale, status: string): Promise<string> {
  const region = page.getByRole("region", { name: PAGE_TEXT[locale].siren });
  await region.getByRole("status").filter({ hasText: status }).waitFor({ timeout: 15_000 });
  return sirenText(page, locale);
}

async function checkPage(browser: Browser): Promise<void> {
  for (const [theme, locale, width, height] of [
    ["dark", "pt", 1200, 820],
    ["light", "en", 1200, 820],
    ["dark", "en", 640, 720],
    ["light", "pt", 420, 760],
  ] as const) {
    const text = PAGE_TEXT[locale];
    const { context, page } = await openStory(browser, "settings-settingsmodal--guard", {
      theme,
      locale,
      width,
      height,
    });
    const steps: string[] = [];
    try {
      const cards = page.getByRole("radiogroup", { name: text.choose });
      const card = (name: string) => cards.getByRole("radio", { name, exact: true });
      const levelList = page.locator(`.ui-select-trigger[aria-label="${text.level}"]`);
      const light = await waitForStatus(page, locale, text.signedOut);
      if (!light.includes(text.light)) fail(`${theme} ${locale}: the siren does not name ${text.light}: "${light}".`);
      assert.equal(await card(text.light).isChecked(), true, "The Light card is not chosen.");
      for (const name of text.later) {
        if (!(await card(name).isDisabled())) fail(`${theme} ${locale}: the ${name} card can be chosen.`);
        const ids = (await card(name).getAttribute("aria-describedby"))?.split(" ").filter(Boolean) ?? [];
        const soon = (await Promise.all(ids.map((id) => page.locator(`[id="${id}"]`).innerText()))).join(" ");
        if (soon !== text.soon) fail(`${theme} ${locale}: the ${name} card says "${soon}", not "${text.soon}".`);
      }
      steps.push("Light: the siren names Light, the Light card is chosen, the stricter cards say Soon");
      const contrast = {
        level: await textContrast(page, ".guard-siren-level"),
        status: await textContrast(page, ".guard-siren-status"),
      };
      if (contrast.level < 3) fail(`${theme}: the level name has a contrast of ${contrast.level}.`);
      if (contrast.status < 4.5) fail(`${theme}: the status text has a contrast of ${contrast.status}.`);
      await screenshot(page, `page-light-${theme}-${locale}-${width}`);

      // A card sets the level, and the level list follows.
      await cards.getByText(text.off, { exact: true }).click();
      const off = await waitForStatus(page, locale, text.asleep);
      if (!off.includes(text.off)) fail(`${theme} ${locale}: the siren does not name ${text.off}: "${off}".`);
      await page.waitForFunction(
        ({ label, option }) =>
          document.querySelector(`.ui-select-trigger[aria-label="${label}"]`)?.textContent?.includes(option) ?? false,
        { label: text.level, option: text.offOption },
        { timeout: 15_000 },
      );
      assert.equal(await card(text.off).isChecked(), true, "The Off card is not chosen.");
      steps.push("Off card: the siren says nothing is checked, the level list shows Off");
      // The siren goes down into the box and the card lifts: the screenshot waits for those motions to end.
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
      await screenshot(page, `page-off-${theme}-${locale}-${width}`);

      // The level list sets the level, and the cards follow.
      await chooseLevel(page, text.level, text.light);
      await waitForStatus(page, locale, text.signedOut);
      assert.equal(await card(text.light).isChecked(), true, "The Light card does not follow the level list.");
      steps.push("Light from the level list: the Light card is chosen");

      // The arrow keys move between the levels that can be chosen, and set the level.
      await card(text.light).focus();
      await page.keyboard.press("ArrowLeft");
      await waitForStatus(page, locale, text.asleep);
      await page.keyboard.press("ArrowRight");
      await waitForStatus(page, locale, text.signedOut);
      if (!(await levelList.innerText()).includes(text.light))
        fail(`${theme} ${locale}: the list does not show Light.`);
      steps.push("Arrow keys: Off, then Light");
      report.stories.page.push({ theme, locale, steps, contrast });
    } catch (error) {
      fail(`Guard page ${theme} ${locale} ${width}: ${error instanceof Error ? error.message : String(error)}`);
      await screenshot(page, `page-failure-${theme}-${locale}-${width}`).catch(() => undefined);
    } finally {
      await context.close();
    }
  }
}

/** Before main answers, the page names no level and the cards cannot be chosen. */
async function checkLoading(browser: Browser): Promise<void> {
  for (const locale of ["en", "pt"] as const) {
    const text = PAGE_TEXT[locale];
    const { context, page } = await openStory(browser, "settings-settingsmodal--guard-loading", {
      locale,
      waitFor: text.loading,
    });
    try {
      const region = await sirenText(page, locale);
      const levelNames = text.names.filter((name) => region.includes(name));
      const radios = page.getByRole("radiogroup", { name: text.choose }).getByRole("radio");
      let disabledRadios = 0;
      let checkedRadios = 0;
      for (const radio of await radios.all()) {
        if (await radio.isDisabled()) disabledRadios += 1;
        if (await radio.isChecked()) checkedRadios += 1;
      }
      if (locale === "en") {
        report.stories.loading = { status: region, levelNames, disabledRadios, checkedRadios };
        await screenshot(page, "page-loading-dark-en-1200");
      }
      if (levelNames.length > 0) fail(`${locale}: while it loads, the siren names ${levelNames.join(", ")}.`);
      if (disabledRadios !== 5) fail(`${locale}: while it loads, ${5 - disabledRadios} level cards can be chosen.`);
      if (checkedRadios !== 0) fail(`${locale}: while it loads, ${checkedRadios} level cards are chosen.`);
    } catch (error) {
      fail(`Guard page while it loads (${locale}): ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await context.close();
    }
  }
}

/**
 * A question of the Guard sounds the alarm of the page: the state says so and the siren turns. A
 * question of a joined server does not: the page shows the Guard of this computer.
 */
async function checkAsking(browser: Browser): Promise<void> {
  for (const [story, status, animations] of [
    ["guard-asking", PAGE_TEXT.en.asking, 3],
    ["guard-joined-server-asking", PAGE_TEXT.en.signedOut, 0],
  ] as const) {
    const { context, page } = await openStory(browser, `settings-settingsmodal--${story}`, { waitFor: status });
    try {
      const region = page.getByRole("region", { name: PAGE_TEXT.en.siren });
      const shown = (await region.getByRole("status").innerText()).trim();
      const turning = await region.evaluate(
        (element) =>
          document.getAnimations().filter((animation) => {
            const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
            return target ? element.contains(target) && animation.effect?.getTiming().iterations === Infinity : false;
          }).length,
      );
      report.stories.asking.push({ story, status: shown, animations: turning });
      if (shown !== status) fail(`${story}: the siren says "${shown}", not "${status}".`);
      if (turning !== animations) fail(`${story}: the siren runs ${turning} animations, not ${animations}.`);
      if (story === "guard-asking") {
        await freeze(page, 0.35);
        await screenshot(page, "page-asking-dark-en-1200");
      }
    } catch (error) {
      fail(`${story}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await context.close();
    }
  }
}

async function checkStories(): Promise<void> {
  const browser = await chromium.launch(
    browserExecutable ? { executablePath: resolve(browserExecutable), headless: true } : { headless: true },
  );
  try {
    // Each check runs also when one before it fails, so one run shows every failure.
    for (const check of [checkLevels, checkCost, checkReducedMotion, checkCard, checkPage, checkLoading, checkAsking]) {
      try {
        await check(browser);
      } catch (error) {
        fail(`${check.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await browser.close();
  }
  const halted = report.errors.filter((error) => /REACTIVITY_HALTED|not a valid selector/u.test(error));
  if (halted.length > 0) fail(`An error halted a story: ${halted[0]}`);
}

mkdirSync(OUT, { recursive: true });
checkCss();
if (storybook) await checkStories();
else if (!argument("css")) fail("Pass --storybook=<url> with the URL that `bun run storybook` reports.");
report.passed = report.failures.length === 0;
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.deepEqual(report.failures, [], "The Guard siren check found failures.");
