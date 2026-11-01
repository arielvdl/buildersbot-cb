// Checks the Guard's siren (`packages/ui/src/features/guard/GuardSiren.tsx` and `guard-siren.css`).
//
// 1. The stylesheet, read as text: each keyframe animates only `transform` and `opacity`; each rule
//    that starts an animation is in the `prefers-reduced-motion: no-preference` block, reads
//    `--guard-siren-play`, and has no `filter`, `drop-shadow`, `box-shadow` or `backdrop-filter`; no
//    rule of the siren uses them at all; and a `prefers-reduced-motion: reduce` block exists.
// 2. The stories in Storybook, with the real components and CSS, in a headless browser:
//    - each siren runs three animations at most, and they animate only `transform` and `opacity`;
//    - a siren that turns causes no style recalculation, no layout and no paint on the main thread, on a
//      page with only the rendered siren and the real stylesheets;
//    - with reduced motion nothing animates; a hidden document pauses every animation;
//    - the card of a Guard question shows the compact siren, at the alarm, hidden from screen readers;
//    - the Guard page shows the siren at the top, follows the level list (Light, Off, Light) and says
//      the state in text; the text has a contrast of at least 4.5 (3 for the large level name) in
//      the dark and the light theme.
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
    cost: {
      animations: number;
      recalcStyle: number;
      layout: number;
      mainThreadPaint: number;
      advancedMs: number;
    } | null;
    reducedMotion: { animations: number; beamsShown: number } | null;
    hidden: { paused: string[]; resumed: string[] } | null;
    card: { mode: string; animations: number; ariaHidden: string | null; title: string } | null;
    page: { theme: Theme; locale: Locale; steps: string[]; contrast: { level: number; status: number } }[];
  };
  screenshots: string[];
  errors: string[];
  failures: string[];
  passed: boolean;
}

const report: Report = {
  css: { path: cssPath, keyframes: [], animatedRules: [], passed: false },
  stories: { animations: null, cost: null, reducedMotion: null, hidden: null, card: null, page: [] },
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
  await page.locator(".guard-siren").first().waitFor({ timeout: 240_000 });
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
 * The cost of a siren that turns, on a page with only the siren: the markup that the story rendered
 * and the real stylesheets, so the work of Storybook does not count.
 */
async function measureCost(browser: Browser, markup: string): Promise<void> {
  const links = STYLESHEETS.map(
    (path) => `<link rel="stylesheet" href="${pathToFileURL(resolve(ROOT, path)).href}" />`,
  );
  const file = resolve(OUT, "cost.html");
  writeFileSync(
    file,
    `<!doctype html><html data-openbot-color-scheme="dark"><head><meta charset="utf-8" />${links.join("")}
<style>body { margin: 0; padding: 24px; width: 760px; background: var(--openbot-bg-canvas); }</style></head>
<body>${markup}</body></html>`,
  );
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
    const animations = await page.evaluate(() => document.getAnimations().length);
    report.stories.cost = {
      animations,
      recalcStyle: delta("RecalcStyleCount"),
      layout: delta("LayoutCount"),
      mainThreadPaint,
      advancedMs: Math.round(end - start),
    };
    if (animations !== 3) fail(`The isolated asking siren runs ${animations} animations, not 3.`);
    if (report.stories.cost.advancedMs < windowMs / 2)
      fail(`The siren did not turn: ${report.stories.cost.advancedMs} ms.`);
    if (report.stories.cost.recalcStyle !== 0)
      fail(`The siren caused ${report.stories.cost.recalcStyle} style recalculations.`);
    if (report.stories.cost.layout !== 0) fail(`The siren caused ${report.stories.cost.layout} layouts.`);
    if (mainThreadPaint !== 0) fail(`The siren caused ${mainThreadPaint} paints on the main thread.`);
  } finally {
    await context.close();
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
          mode: siren?.getAttribute("data-mode") ?? "missing",
          animations: animations.length,
          ariaHidden: siren?.getAttribute("aria-hidden") ?? null,
          title: document.querySelector(".approval-card-header strong")?.textContent ?? "",
        };
      });
      if (theme === "dark" && width === 760) report.stories.card = card;
      if (card.mode !== "alarm") fail(`The siren of a Guard question is ${card.mode}, not the alarm.`);
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
    level: "Level",
    light: "Light",
    off: "Off (asleep)",
    signedOut: "Calm. Only the local check runs: you are not signed in to Cultura Builder.",
    asleep: "Asleep. The Guard checks nothing.",
  },
  pt: {
    level: "Nível",
    light: "Leve",
    off: "Desligado (dormindo)",
    signedOut: "Calmo. Só a verificação local roda: você não entrou no Cultura Builder.",
    asleep: "Dormindo. O Guarda não confere nada.",
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
      const hero = page.locator(".guard-siren-hero");
      await hero.waitFor({ timeout: 60_000 });
      await page.waitForFunction(
        (expected) => document.querySelector(".guard-siren-status")?.textContent === expected,
        text.signedOut,
        { timeout: 15_000 },
      );
      assert.equal(await hero.getAttribute("data-level"), "light", "The Guard page siren is not at Light.");
      assert.equal(await page.locator(".guard-siren-hero .guard-siren").getAttribute("data-mode"), "calm");
      steps.push("Light: calm siren, signed-out status");
      const contrast = {
        level: await textContrast(page, ".guard-siren-level"),
        status: await textContrast(page, ".guard-siren-status"),
      };
      if (contrast.level < 3) fail(`${theme}: the level name has a contrast of ${contrast.level}.`);
      if (contrast.status < 4.5) fail(`${theme}: the status text has a contrast of ${contrast.status}.`);
      await screenshot(page, `page-light-${theme}-${locale}-${width}`);

      await chooseLevel(page, text.level, text.off);
      await page.waitForFunction(
        (expected) =>
          document.querySelector(".guard-siren-hero")?.getAttribute("data-level") === "off" &&
          document.querySelector(".guard-siren-hero .guard-siren")?.getAttribute("data-mode") === "asleep" &&
          document.querySelector(".guard-siren-status")?.textContent === expected,
        text.asleep,
        { timeout: 15_000 },
      );
      steps.push("Off: asleep siren, asleep status");
      // The siren goes down into the box: the screenshot waits for that motion to end.
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
      await screenshot(page, `page-off-${theme}-${locale}-${width}`);

      await chooseLevel(page, text.level, text.light);
      await page.waitForFunction(
        () => document.querySelector(".guard-siren-hero")?.getAttribute("data-level") === "light",
        undefined,
        { timeout: 15_000 },
      );
      steps.push("Light again");
      report.stories.page.push({ theme, locale, steps, contrast });
    } catch (error) {
      fail(`Guard page ${theme} ${locale} ${width}: ${error instanceof Error ? error.message : String(error)}`);
      await screenshot(page, `page-failure-${theme}-${locale}-${width}`).catch(() => undefined);
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
    await checkLevels(browser);
    await checkCost(browser);
    await checkReducedMotion(browser);
    await checkCard(browser);
    await checkPage(browser);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
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
