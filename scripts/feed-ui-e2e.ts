// Checks the feed page in the stories, with the real components, the real store and the preview mock
// of the IPC, in a headless browser (Edge or Chromium). It checks that:
// - with 5,000 cards, only the cards on screen are in the DOM, each card says it is one of 5,000, and
//   scrolling through the whole timeline keeps frames short;
// - choosing an agent in the Team list shows only its runs, and choosing it again shows all;
// - the counters go to the next card that needs the person, and the arrow keys move between cards;
// - "/" goes to the search, and a search keeps only the matching runs;
// - with new runs coming, scrolling up pauses the timeline and counts "N new", and the button goes
//   back to the newest card and follows again;
// - in the whole app of the preview, the Feed button of the page rail opens the page, and a card opens
//   the chat of its agent;
// - the light and the dark palette render, axe-core finds no violation, and no error halts the page.
// Pass the URL that `bun run storybook` reports:
//
//   bun scripts/feed-ui-e2e.ts --storybook=http://localhost:6006 [--browser-executable=<path>] [--prints=<folder>]
//
// Writes .openbot-build/feed-ui-e2e/report.json and screenshots; `--prints` copies the screenshots there.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";

declare global {
  interface Window {
    /** The frame times that the scroll check records in the page. */
    feedFrames?: { times: number[]; running: boolean };
    /** axe-core, added to the page by the accessibility check (the same type as `status-page-smoke.ts`). */
    axe?: { run: () => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> };
  }
  interface Performance {
    /** Chromium only: the JavaScript heap of the page. */
    memory?: { usedJSHeapSize: number };
  }
}

const OUT = resolve(import.meta.dirname, "../.openbot-build/feed-ui-e2e");
const AXE = resolve(import.meta.dirname, "../node_modules/axe-core/axe.min.js");
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const storybook = argument("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const browserExecutable = argument("browser-executable");
const prints = argument("prints");

type Locale = "en" | "pt";
type Scheme = "dark" | "light";

const TEXT = {
  en: {
    search: "Search the feed",
    paused: "Paused",
    live: "Live, following the newest",
    showing: (shown: number, total: number) => `Showing ${shown} of ${total}`,
    needsYou: "Needs you",
  },
  pt: {
    search: "Buscar no feed",
    paused: "Pausado",
    live: "Ao vivo, seguindo o fim",
    showing: (shown: number, total: number) => `Mostrando ${shown} de ${total}`,
    needsYou: "Precisa de você",
  },
} as const;

interface FrameStats {
  frames: number;
  averageMs: number;
  p95Ms: number;
  maxMs: number;
  longFrames: number;
}

const report: {
  storybook: string;
  browser: string;
  dom?: { total: number; cards: number; rows: number; setSize: string | null; heapMb: number | null };
  domTypicalDay?: { total: number; cards: number };
  /** The axe-core violations of the page, by story. */
  accessibility: Record<string, string[]>;
  scroll?: FrameStats & { distancePx: number };
  liveScroll?: FrameStats;
  steps: string[];
  screenshots: string[];
  errors: string[];
  failures: string[];
  passed: boolean;
} = {
  storybook,
  browser: browserExecutable ?? "chromium",
  steps: [],
  screenshots: [],
  errors: [],
  failures: [],
  accessibility: {},
  passed: false,
};

function storyUrl(id: string, locale: Locale, scheme: Scheme): string {
  const story = id.includes("--") ? id : `features-feed--${id}`;
  return `${storybook}/iframe.html?id=${story}&viewMode=story&globals=locale:${locale};colorScheme:${scheme}`;
}

async function open(browser: Browser, id: string, locale: Locale, scheme: Scheme) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${id}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(`${id}: ${message.text().slice(0, 400)}`);
  });
  await page.goto(storyUrl(id, locale, scheme), { waitUntil: "domcontentloaded", timeout: 300_000 });
  return { context, page };
}

async function shot(page: Page, name: string): Promise<void> {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  report.screenshots.push(path);
}

/**
 * Scrolls the timeline up with the wheel, as a person does, `turns` times by `step` pixels, and times
 * every frame of the page meanwhile.
 */
async function scrollFrames(page: Page, step: number, turns: number): Promise<FrameStats & { distancePx: number }> {
  const timeline = page.locator(".feed-timeline");
  const start = await timeline.evaluate((element) => element.scrollTop);
  await timeline.hover();
  await page.evaluate(() => {
    const recorder: { times: number[]; running: boolean } = { times: [], running: true };
    window.feedFrames = recorder;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      recorder.times.push(now - last);
      last = now;
      if (recorder.running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let turn = 0; turn < turns; turn += 1) {
    await page.mouse.wheel(0, -step);
    await page.waitForTimeout(16);
  }
  const times = await page.evaluate(() => {
    const recorder = window.feedFrames;
    if (!recorder) return [];
    recorder.running = false;
    return recorder.times.slice(1);
  });
  const end = await timeline.evaluate((element) => element.scrollTop);
  const sorted = [...times].sort((a, b) => a - b);
  return {
    frames: times.length,
    averageMs: Number((times.reduce((a, b) => a + b, 0) / Math.max(times.length, 1)).toFixed(2)),
    p95Ms: Number((sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2)),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
    longFrames: times.filter((time) => time > 50).length,
    distancePx: Math.round(start - end),
  };
}

/** Runs axe-core on the feed page and keeps the rules that failed, with the first element of each. */
async function accessibility(page: Page, name: string): Promise<void> {
  await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => {
    if (!document.querySelector(".feed-page") || !window.axe) return ["no feed page or no axe"];
    // The story frame holds the feed page alone.
    const result = await window.axe.run();
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(" ") ?? ""}`);
  });
  report.accessibility[name] = violations;
  assert.deepEqual(violations, [], `${name}: axe found accessibility violations.`);
}

async function domCounts(page: Page) {
  return page.evaluate(() => ({
    total: document.querySelectorAll("*").length,
    cards: document.querySelectorAll(".feed-card").length,
    rows: document.querySelectorAll(".feed-virtual-row").length,
    setSize: document.querySelector(".feed-card")?.getAttribute("aria-setsize") ?? null,
    heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1_048_576) : null,
  }));
}

/** 5,000 cards, dark, Portuguese: the DOM, the scroll, the Team filter, the counters, the keys, the search. */
async function checkFiveThousand(browser: Browser): Promise<void> {
  const { context, page } = await open(browser, "five-thousand", "pt", "dark");
  const text = TEXT.pt;
  try {
    await page.locator(".feed-card").first().waitFor({ timeout: 240_000 });
    await page.getByText(text.showing(5_000, 5_000)).waitFor({ timeout: 10_000 });
    const dom = await domCounts(page);
    report.dom = dom;
    assert.equal(dom.setSize, "5000", "A card says it is one of 5,000.");
    assert.ok(dom.cards <= 60, `Only the cards on screen are in the DOM, not ${dom.cards}.`);
    assert.ok(dom.total < 4_000, `The page has ${dom.total} elements with 5,000 cards.`);
    await shot(page, "feed-mvp-5000-dark");
    report.steps.push("5,000 cards: DOM and screenshot");

    const scroll = await scrollFrames(page, 600, 120);
    report.scroll = scroll;
    assert.ok(scroll.distancePx > 40_000, `The timeline scrolled only ${scroll.distancePx}px.`);
    assert.ok(scroll.p95Ms < 50, `95% of the frames take less than 50 ms, not ${scroll.p95Ms} ms.`);
    const afterScroll = await domCounts(page);
    assert.ok(afterScroll.cards <= 60, `After the scroll, ${afterScroll.cards} cards are in the DOM.`);
    await page.getByText(text.paused, { exact: false }).first().waitFor({ timeout: 5_000 });
    report.steps.push("120 wheel turns up: frames timed, timeline paused");

    // The Team filter: Líder Opus only, then every agent again.
    const member = page.locator(".feed-team-member", { hasText: "Líder Opus" }).first();
    await member.click();
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll(".feed-card-agent")].map((element) => element.textContent?.trim());
      return names.length > 0 && names.every((name) => name === "Líder Opus");
    });
    assert.equal(await member.getAttribute("aria-pressed"), "true", "The chosen agent is pressed.");
    const shownText = await page.locator(".feed-showing").textContent();
    assert.ok(shownText && !shownText.includes(text.showing(5_000, 5_000)), "The filter shows fewer runs.");
    await member.click();
    await page.getByText(text.showing(5_000, 5_000)).waitFor({ timeout: 5_000 });
    report.steps.push("Team filter on and off");

    // The counter goes to the next card that needs the person.
    await page.locator(".feed-counter[data-state='needs-you']").click();
    await page.waitForFunction(() => document.activeElement?.matches(".feed-card[data-state='needs-you']") ?? false);
    const first = await page.evaluate(() => document.activeElement?.getAttribute("data-feed-id") ?? null);
    await page.locator(".feed-counter[data-state='needs-you']").click();
    await page.waitForFunction(
      (previous) =>
        (document.activeElement?.matches(".feed-card[data-state='needs-you']") ?? false) &&
        document.activeElement?.getAttribute("data-feed-id") !== previous,
      first,
    );
    report.steps.push("needs-you counter goes from one card to the next");

    // The arrow keys move between the cards.
    const before = await page.evaluate(() => Number(document.activeElement?.getAttribute("aria-posinset")));
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(
      (position) => Number(document.activeElement?.getAttribute("aria-posinset")) === position - 1,
      before,
    );
    report.steps.push("ArrowUp moves to the card before");

    // "/" goes to the search; a search keeps the matching runs.
    await page.locator(".feed-page-header").click();
    await page.keyboard.press("/");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
    assert.equal(focused, text.search, '"/" goes to the search.');
    await page.keyboard.type("migracao");
    await page.waitForFunction(() => {
      const titles = [...document.querySelectorAll(".feed-card-title")].map((element) => element.textContent ?? "");
      return titles.length > 0 && titles.every((title) => title.includes("Migração"));
    });
    report.steps.push('"/" then a search without accents');
  } finally {
    await context.close();
  }
}

/** New runs come while the reader scrolled up: the timeline pauses and counts them. English, light. */
async function checkLive(browser: Browser): Promise<void> {
  const { context, page } = await open(browser, "live", "en", "light");
  const text = TEXT.en;
  try {
    await page.locator(".feed-card").first().waitFor({ timeout: 240_000 });
    await page.getByText(text.live).waitFor({ timeout: 10_000 });
    await page.locator(".feed-timeline").hover();
    await page.mouse.wheel(0, -2_000);
    await page.getByText(text.paused, { exact: false }).first().waitFor({ timeout: 5_000 });
    const pill = page.locator(".feed-newest-button");
    await pill.getByText(/\d+ new/u).waitFor({ timeout: 10_000 });
    await shot(page, "feed-mvp-paused-light");
    await accessibility(page, "paused-light");
    await pill.click();
    await page.getByText(text.live).waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => {
      const scroller = document.querySelector<HTMLElement>(".feed-timeline");
      return scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 80 : false;
    });
    report.steps.push("scroll up pauses and counts new runs; the button follows again");
  } finally {
    await context.close();
  }
}

/** 5,000 cards while new runs come every 250 ms: the scroll stays smooth. */
async function checkLiveScroll(browser: Browser): Promise<void> {
  const { context, page } = await open(browser, "live-five-thousand", "en", "dark");
  try {
    await page.locator(".feed-card").first().waitFor({ timeout: 240_000 });
    report.liveScroll = await scrollFrames(page, 400, 90);
    assert.ok(report.liveScroll.p95Ms < 50, `With new runs, 95% of frames take ${report.liveScroll.p95Ms} ms.`);
    report.steps.push("5,000 cards with new runs: scroll timed");
  } finally {
    await context.close();
  }
}

async function checkScreens(browser: Browser): Promise<void> {
  for (const [id, locale, scheme, name] of [
    ["typical-day", "pt", "dark", "feed-mvp-dia-escuro"],
    ["typical-day-light", "pt", "light", "feed-mvp-dia-claro"],
    ["five-thousand-light", "pt", "light", "feed-mvp-5000-light"],
    ["empty", "en", "dark", "feed-mvp-empty-dark"],
  ] as const) {
    const { context, page } = await open(browser, id, locale, scheme);
    try {
      await page
        .locator(id === "empty" ? ".feed-timeline-empty" : ".feed-card")
        .first()
        .waitFor({ timeout: 240_000 });
      if (id === "typical-day") report.domTypicalDay = await domCounts(page);
      await shot(page, name);
      if (id !== "empty") await accessibility(page, name);
      if (id === "typical-day") {
        await page.getByRole("button", { name: "Por projeto" }).click();
        await page.locator(".feed-group-head").first().waitFor({ timeout: 5_000 });
        await accessibility(page, `${name}-por-projeto`);
      }
    } finally {
      await context.close();
    }
  }
  report.steps.push("light and dark screenshots");
}

/**
 * The whole app of the preview: the Feed button of the page rail opens the page beside the sidebar,
 * and "Open conversation" on a card opens the chat of its agent and closes the page.
 */
async function checkInApp(browser: Browser): Promise<void> {
  for (const scheme of ["dark", "light"] as const) {
    const { context, page } = await open(browser, "app--playground", "pt", scheme);
    try {
      const rail = page.getByRole("navigation", { name: "Páginas" });
      await rail.getByRole("button", { name: "Feed", exact: true }).click({ timeout: 240_000 });
      await page.locator(".feed-card").first().waitFor({ timeout: 30_000 });
      await page.locator(".feed-team-member").first().waitFor({ timeout: 10_000 });
      assert.equal(
        await rail.getByRole("button", { name: "Feed", exact: true }).getAttribute("aria-current"),
        "page",
        "The rail marks the Feed page.",
      );
      await shot(page, scheme === "dark" ? "feed-mvp-app-escuro" : "feed-mvp-app-claro");
      if (scheme === "dark") {
        const card = page.locator(".feed-card").last();
        const agent = (await card.locator(".feed-card-agent").textContent())?.trim() ?? "";
        await card.getByRole("button", { name: "Abrir conversa" }).click();
        await page.locator(".feed-page").waitFor({ state: "detached", timeout: 10_000 });
        report.steps.push(`in the app: the rail opens the feed; a card opens the chat of ${agent}`);
      }
    } finally {
      await context.close();
    }
  }
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), headless: true } : { headless: true },
);
try {
  for (const check of [checkFiveThousand, checkLive, checkLiveScroll, checkScreens, checkInApp]) {
    try {
      await check(browser);
    } catch (error) {
      report.failures.push(`${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await browser.close();
}
const halted = report.errors.filter((error) =>
  /REACTIVITY_HALTED|PRIMITIVE_IN_EFFECT|not a valid selector/u.test(error),
);
if (halted.length > 0) report.failures.push(`An error halted the page: ${halted[0]}`);
report.passed = report.failures.length === 0;
if (prints) {
  mkdirSync(prints, { recursive: true });
  for (const path of report.screenshots) copyFileSync(path, join(prints, path.split("/").at(-1) ?? "feed.png"));
}
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.deepEqual(report.failures, [], "The feed UI check found failures.");
