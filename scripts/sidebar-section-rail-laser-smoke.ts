// Checks the laser of a working section in the section rail (`sidebar-section-rail.css`) with the real
// stylesheets, in an isolated headless browser. The page copies the markup of `SectionRailButton`
// (`SidebarSectionRail.tsx`) and the lifted copy of `createVerticalDragPreview`, and the script first
// checks that the sources still have that markup. It checks that:
// - ten lasers that turn cause no style recalculation, no layout and no paint on the main thread, and
//   that each laser animates only `transform`;
// - with reduced motion, no laser animates;
// - `--section-rail-laser-play: paused` on the rail stops each laser, and an item with `data-dragging`
//   stops only its own laser;
// - the lifted copy of a drag (with its paint containment) has no halo, and its laser turns;
// - the still ring of reduced motion stands out from the sidebar for the accent, each preset color and
//   colors near the sidebar color, in the dark and the light theme.
// Run: `bun scripts/sidebar-section-rail-laser-smoke.ts [--browser-executable=<path>]`.
// Writes .openbot-build/sidebar-laser/report.json and the screenshots in the same folder.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, ".openbot-build/sidebar-laser");
const browserExecutable = process.argv
  .find((arg) => arg.startsWith("--browser-executable="))
  ?.slice("--browser-executable=".length);

// The stylesheets that draw the rail, in the order of `src/renderer/src/styles.css`.
const STYLESHEETS = [
  "packages/brand/src/tokens.css",
  "packages/brand/src/tokens-light.css",
  "packages/ui/src/styles/primitives.css",
  "src/renderer/src/styles/base.css",
  "src/renderer/src/styles/app-shell.css",
  "packages/ui/src/features/sidebar/sidebar-section-color.css",
  "packages/ui/src/features/sidebar/sidebar-section-rail.css",
];

// The preset colors of `SIDEBAR_SECTION_COLOR_PRESETS` (`section-color.ts`).
const PRESET_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
];
// Custom colors near the sidebar color of one theme, and black and white.
const EXTREME_COLORS = ["#111111", "#f4f4f4", "#000000", "#ffffff"];
// The lowest contrast ratio of the still ring against the sidebar. The preset colors give at least 1.9
// (green and lime on the light theme). Without the lightness range of the laser, a custom color near
// the sidebar color gives about 1.0.
const MIN_RING_CONTRAST = 1.8;

type Theme = "dark" | "light";
type BadgeKind = "waiting" | "unread" | "working";

interface Tile {
  name: string;
  kind: "all" | "unassigned" | "letter" | "emoji" | "image";
  text?: string;
  color?: string;
  selected?: boolean;
  running?: boolean;
  badge?: BadgeKind;
  unread?: number;
}

interface Report {
  browser: string | null;
  sources: { passed: boolean; missing: string[] };
  cost: {
    lasers: number;
    windowMs: number;
    recalcStyle: number;
    layout: number;
    mainThreadPaint: number;
    mainTaskMs: number;
    advancedMs: number;
    animatedProperties: string[];
  } | null;
  reducedMotion: { animations: number } | null;
  pause: { railPaused: string[]; railRunning: string[]; draggedItem: string[]; otherItems: string[] } | null;
  dragPreview: Record<Theme, { halo: string; playState: string; screenshot: string }> | null;
  contrast: { theme: Theme; color: string; ring: number[]; sidebar: number[]; ratio: number }[];
  minContrast: number | null;
  screenshots: string[];
  failures: string[];
  passed: boolean;
}

const report: Report = {
  browser: null,
  sources: { passed: false, missing: [] },
  cost: null,
  reducedMotion: null,
  pause: null,
  dragPreview: null,
  contrast: [],
  minContrast: null,
  screenshots: [],
  failures: [],
  passed: false,
};

function fail(message: string): void {
  report.failures.push(message);
}

// The page must copy the real markup, so a change of the sources makes this script fail.
function checkSources(): void {
  const rail = readFileSync(resolve(ROOT, "packages/ui/src/features/sidebar/SidebarSectionRail.tsx"), "utf8");
  const preview = readFileSync(resolve(ROOT, "packages/ui/src/components/createVerticalDragPreview.ts"), "utf8");
  const expected: [string, string][] = [
    [rail, '<span class="section-rail-laser" aria-hidden="true">'],
    [rail, '<span class="section-rail-laser-ring" />'],
    [rail, 'data-running={running() ? "" : undefined}'],
    [rail, '"--section-rail-laser-play": laserPlayState()'],
    [rail, 'class: "server-rail-button section-rail-button"'],
    [rail, 'className: "section-rail-drag-preview"'],
    [preview, 'clone.style.contain = "layout paint style";'],
    [preview, 'clone.style.willChange = "transform";'],
  ];
  report.sources.missing = expected.filter(([source, text]) => !source.includes(text)).map(([, text]) => text);
  report.sources.passed = report.sources.missing.length === 0;
  if (!report.sources.passed) fail(`The sources no longer have: ${report.sources.missing.join(" | ")}`);
}

const GLYPH_ALL =
  '<svg class="section-rail-glyph" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>';
const GLYPH_INBOX =
  '<svg class="section-rail-glyph" viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
const IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 2'%3E%3Crect width='2' height='2' fill='%230ea5e9'/%3E%3Crect width='1' height='1' fill='%23f59e0b'/%3E%3C/svg%3E";

function markHtml(tile: Tile): string {
  switch (tile.kind) {
    case "all":
      return `<span class="section-rail-mark-tile" data-kind="all" aria-hidden="true">${GLYPH_ALL}</span>`;
    case "unassigned":
      return `<span class="section-rail-mark-tile" data-kind="unassigned" aria-hidden="true">${GLYPH_INBOX}</span>`;
    case "emoji":
      return `<span class="section-rail-mark-tile" data-kind="emoji" aria-hidden="true"><span class="section-rail-emoji">${tile.text ?? ""}</span></span>`;
    case "image":
      return `<span class="section-rail-mark-tile" data-kind="image" aria-hidden="true"><img class="section-rail-image" src="${IMAGE}" alt="" /></span>`;
    case "letter":
      return `<span class="section-rail-mark-tile" data-kind="letter" aria-hidden="true"><span class="section-rail-letter">${tile.text ?? ""}</span></span>`;
  }
}

// The markup of `SectionRailButton`. Every tile except "All" can be reordered, as on the local server.
function tileHtml(tile: Tile): string {
  const reorder = tile.kind !== "all" && tile.kind !== "unassigned";
  const style = `${tile.color ? `--sidebar-section-color: ${tile.color};` : ""}${reorder ? "--section-rail-drag-step: 0;" : ""}`;
  const attributes = [
    'type="button"',
    'class="ui-button ui-button-variant-ghost ui-button-size-default server-rail-button section-rail-button"',
    `aria-label="${tile.name}"`,
    `aria-pressed="${tile.selected ? "true" : "false"}"`,
    `tabindex="${tile.selected ? 0 : -1}"`,
    style ? `style="${style}"` : "",
    reorder ? `draggable="true" data-section-rail-id="${tile.name}"` : "",
    tile.color ? "data-section-color" : "",
    tile.running ? "data-running" : "",
    tile.kind === "unassigned" ? "data-unassigned" : "",
  ].filter(Boolean);
  const laser = tile.running
    ? '<span class="section-rail-laser" aria-hidden="true"><span class="section-rail-laser-ring"></span></span>'
    : "";
  const badge = tile.badge
    ? `<span class="section-rail-badge" data-kind="${tile.badge}" aria-hidden="true">${tile.badge === "unread" ? Math.min(tile.unread ?? 0, 99) : ""}</span>`
    : "";
  return `<button ${attributes.join(" ")}><span class="server-rail-mark" aria-hidden="true"></span>${markHtml(tile)}${laser}${badge}</button>`;
}

function pageHtml(tiles: Tile[]): string {
  const links = STYLESHEETS.map(
    (path) => `<link rel="stylesheet" href="${pathToFileURL(resolve(ROOT, path)).href}" />`,
  );
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
${links.join("\n")}
<style>
  html, body { margin: 0; background: var(--openbot-bg-sidebar); }
  .server-rail { --server-rail-width: 64px; --left-header-height: 38px; width: 64px; height: 100vh; padding-top: 16px; }
</style>
</head>
<body>
<nav class="server-rail section-rail" aria-label="Sections">
  <div class="server-rail-list section-rail-list">
${tiles.map(tileHtml).join("\n")}
  </div>
</nav>
</body>
</html>
`;
}

function writePage(name: string, tiles: Tile[]): string {
  const path = resolve(OUT, `${name}.html`);
  writeFileSync(path, pageHtml(tiles));
  return pathToFileURL(path).href;
}

async function openPage(
  browser: Browser,
  url: string,
  options: { theme?: Theme; reducedMotion?: boolean; scale?: number; height?: number } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 200, height: options.height ?? 720 },
    deviceScaleFactor: options.scale ?? 2,
    reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => fail(`Page error: ${error.message}`));
  await page.goto(url, { waitUntil: "load" });
  if (options.theme === "light") {
    await page.evaluate(() => document.documentElement.setAttribute("data-openbot-color-scheme", "light"));
  }
  // The animations start after the next frames.
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((animation) => animation.ready));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  return { context, page };
}

// Stops each animation at the same point of its turn, so two screenshots are the same.
async function freeze(page: Page, phase: number): Promise<void> {
  await page.evaluate((value) => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = value * Number(animation.effect?.getTiming().duration ?? 0);
    }
  }, phase);
}

async function screenshot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path, clip });
  report.screenshots.push(path);
  return path;
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

// The events of a Chromium trace (`{ traceEvents: [...] }`).
function traceEvents(trace: unknown): TraceEvent[] {
  if (typeof trace !== "object" || trace === null || !("traceEvents" in trace)) return [];
  return Array.isArray(trace.traceEvents) ? trace.traceEvents.filter(isTraceEvent) : [];
}

async function checkCost(browser: Browser): Promise<void> {
  const tiles: Tile[] = Array.from({ length: 10 }, (_, index) => ({
    name: `S${index}`,
    kind: "letter",
    text: `S${index}`,
    color: index % 2 ? PRESET_COLORS[index] : undefined,
    running: true,
  }));
  const { context, page } = await openPage(browser, writePage("cost", tiles));
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const metrics = async () =>
      Object.fromEntries(
        (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]),
      );
    // `getAnimations` updates the style, so the script reads the time of the turn outside the window.
    const time = () => page.evaluate(() => Number(document.getAnimations()[0]?.currentTime ?? 0));
    const windowMs = 2000;
    const startTime = await time();
    await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
    const before = await metrics();
    // The cost is the work during a time window, so this wait is the measure.
    await page.waitForTimeout(windowMs);
    const after = await metrics();
    const events = traceEvents(JSON.parse((await browser.stopTracing()).toString()));
    const endTime = await time();
    const threads = new Map<string, string>();
    for (const event of events) {
      if (event.name === "thread_name") threads.set(`${event.pid}:${event.tid}`, event.args?.name ?? "");
    }
    const mainThreadPaint = events.filter(
      (event) =>
        event.name === "Paint" && event.ph !== "E" && threads.get(`${event.pid}:${event.tid}`) === "CrRendererMain",
    ).length;
    const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0);
    const animations = await page.evaluate(() =>
      document.getAnimations().map((animation) => {
        const effect = animation.effect instanceof KeyframeEffect ? animation.effect : null;
        return (effect?.getKeyframes() ?? []).flatMap((frame) => Object.keys(frame));
      }),
    );
    const meta = new Set(["offset", "computedOffset", "easing", "composite"]);
    const animatedProperties = [...new Set(animations.flat().filter((key) => !meta.has(key)))];
    report.cost = {
      lasers: animations.length,
      windowMs,
      recalcStyle: delta("RecalcStyleCount"),
      layout: delta("LayoutCount"),
      mainThreadPaint,
      mainTaskMs: Math.round(delta("TaskDuration") * 1000),
      advancedMs: Math.round(endTime - startTime),
      animatedProperties,
    };
    if (animations.length !== 10) fail(`Expected 10 laser animations, got ${animations.length}.`);
    if (report.cost.advancedMs < windowMs / 2) fail(`The lasers did not turn: ${report.cost.advancedMs} ms.`);
    if (report.cost.recalcStyle !== 0) fail(`The lasers caused ${report.cost.recalcStyle} style recalculations.`);
    if (report.cost.layout !== 0) fail(`The lasers caused ${report.cost.layout} layouts.`);
    if (mainThreadPaint !== 0) fail(`The lasers caused ${mainThreadPaint} paints on the main thread.`);
    if (animatedProperties.join() !== "transform") {
      fail(`The lasers animate ${animatedProperties.join(", ")}, not only transform.`);
    }
  } finally {
    await context.close();
  }
}

async function checkPause(browser: Browser): Promise<void> {
  const tiles: Tile[] = [0, 1, 2, 3].map((index) => ({
    name: `P${index}`,
    kind: "letter",
    text: `P${index}`,
    running: true,
  }));
  const { context, page } = await openPage(browser, writePage("pause", tiles));
  try {
    const states = () => page.evaluate(() => document.getAnimations().map((animation) => animation.playState));
    await page.evaluate(() =>
      document.querySelector<HTMLElement>(".section-rail")?.style.setProperty("--section-rail-laser-play", "paused"),
    );
    const railPaused = await states();
    await page.evaluate(() =>
      document.querySelector<HTMLElement>(".section-rail")?.style.setProperty("--section-rail-laser-play", "running"),
    );
    const railRunning = await states();
    const dragged = await page.evaluate(() => {
      const button = document.querySelectorAll<HTMLElement>(".section-rail-button")[1];
      button?.setAttribute("data-dragging", "");
      const own: string[] = [];
      const others: string[] = [];
      for (const animation of document.getAnimations()) {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        (target && button?.contains(target) ? own : others).push(animation.playState);
      }
      return { own, others };
    });
    report.pause = { railPaused, railRunning, draggedItem: dragged.own, otherItems: dragged.others };
    if (railPaused.length !== 4 || railPaused.some((state) => state !== "paused")) {
      fail(`A paused rail must stop each laser: ${railPaused.join(", ")}.`);
    }
    if (railRunning.length !== 4 || railRunning.some((state) => state !== "running")) {
      fail(`A running rail must turn each laser: ${railRunning.join(", ")}.`);
    }
    if (dragged.own.join() !== "paused") fail(`The dragged item must stop its laser: ${dragged.own.join(", ")}.`);
    if (dragged.others.length !== 3 || dragged.others.some((state) => state !== "running")) {
      fail(`Only the dragged item stops its laser: ${dragged.others.join(", ")}.`);
    }
  } finally {
    await context.close();
  }
}

const GALLERY: Tile[] = [
  { name: "All", kind: "all", selected: false },
  { name: "N", kind: "letter", text: "N", running: true, badge: "working" },
  { name: "R", kind: "letter", text: "R", color: "#22c55e", selected: true, running: true, badge: "unread", unread: 4 },
  { name: "V", kind: "letter", text: "V", color: "#a855f7" },
  { name: "Rocket", kind: "emoji", text: "\u{1F680}", color: "#f97316", running: true, badge: "waiting" },
  { name: "Image", kind: "image", color: "#3b82f6", running: true },
  { name: "K", kind: "letter", text: "K", color: "#111111", selected: true, running: true },
  { name: "W", kind: "letter", text: "W", color: "#f4f4f4", running: true },
  { name: "C", kind: "letter", text: "C", badge: "unread", unread: 12 },
  { name: "Unassigned", kind: "unassigned", running: true, badge: "working" },
];

async function checkGallery(browser: Browser): Promise<void> {
  const url = writePage("gallery", GALLERY);
  for (const theme of ["dark", "light"] as const) {
    const { context, page } = await openPage(browser, url, { theme, scale: 3 });
    try {
      for (const phase of [0.1, 0.6]) {
        await freeze(page, phase);
        await screenshot(page, `gallery-${theme}-p${phase}`, { x: 0, y: 0, width: 64, height: 600 });
      }
    } finally {
      await context.close();
    }
  }
  const { context, page } = await openPage(browser, url, { reducedMotion: true, scale: 3 });
  try {
    report.reducedMotion = { animations: await page.evaluate(() => document.getAnimations().length) };
    if (report.reducedMotion.animations !== 0) {
      fail(`With reduced motion, ${report.reducedMotion.animations} lasers still animate.`);
    }
    await screenshot(page, "gallery-dark-reduced-motion", { x: 0, y: 0, width: 64, height: 600 });
  } finally {
    await context.close();
  }
}

// The lifted copy, as `createVerticalDragPreview` makes it, of the selected green tile that works.
async function checkDragPreview(browser: Browser): Promise<void> {
  const url = writePage("drag", GALLERY);
  report.dragPreview = {
    dark: await checkDragPreviewIn(browser, url, "dark"),
    light: await checkDragPreviewIn(browser, url, "light"),
  };
}

async function checkDragPreviewIn(
  browser: Browser,
  url: string,
  theme: Theme,
): Promise<{ halo: string; playState: string; screenshot: string }> {
  const { context, page } = await openPage(browser, url, { theme, scale: 4 });
  try {
    const state = await page.evaluate(() => {
      const source = document.querySelectorAll<HTMLElement>(".section-rail-button")[2];
      const clone = source?.cloneNode(true);
      if (!source || !(clone instanceof HTMLElement)) throw new Error("No source tile.");
      const bounds = source.getBoundingClientRect();
      clone.classList.add("section-rail-drag-preview");
      clone.setAttribute("aria-hidden", "true");
      clone.setAttribute("inert", "");
      clone.removeAttribute("tabindex");
      clone.removeAttribute("draggable");
      clone.style.width = `${bounds.width}px`;
      clone.style.top = "0px";
      clone.style.contain = "layout paint style";
      clone.style.willChange = "transform";
      document.body.append(clone);
      clone.style.left = "110px";
      clone.style.transform = `translate3d(0, ${bounds.top}px, 0)`;
      const laser = clone.querySelector(".section-rail-laser");
      const animation = document.getAnimations().find((item) => {
        const target = item.effect instanceof KeyframeEffect ? item.effect.target : null;
        return target ? clone.contains(target) : false;
      });
      return {
        top: bounds.top,
        halo: laser ? getComputedStyle(laser).boxShadow : "missing",
        playState: animation?.playState ?? "missing",
      };
    });
    await freeze(page, 0.3);
    // The source tile at the left and its lifted copy at the right.
    const path = await screenshot(page, `drag-${theme}`, { x: 0, y: state.top - 12, width: 170, height: 70 });
    if (state.halo !== "none") fail(`The lifted copy (${theme}) has a halo: ${state.halo}.`);
    if (state.playState !== "running") fail(`The laser of the lifted copy (${theme}) is ${state.playState}.`);
    return { halo: state.halo, playState: state.playState, screenshot: path };
  } finally {
    await context.close();
  }
}

function luminance([red, green, blue]: number[]): number {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red ?? 0) + 0.7152 * linear(green ?? 0) + 0.0722 * linear(blue ?? 0);
}

function contrastRatio(first: number[], second: number[]): number {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

// The still ring of reduced motion has the color of the laser body. It is measured on the screenshot:
// the middle of the top edge of the ring, against the sidebar under the last tile.
async function checkContrast(browser: Browser): Promise<void> {
  const colors = [undefined, ...PRESET_COLORS, ...EXTREME_COLORS];
  const tiles: Tile[] = colors.map((color, index) => ({
    name: color ?? "accent",
    kind: "letter",
    text: String.fromCharCode(65 + index),
    color,
    running: true,
  }));
  const url = writePage("contrast", tiles);
  for (const theme of ["dark", "light"] as const) {
    const { context, page } = await openPage(browser, url, { theme, reducedMotion: true, scale: 2, height: 1000 });
    try {
      const path = await screenshot(page, `contrast-${theme}`);
      const png = readFileSync(path).toString("base64");
      const samples = await page.evaluate(async (data) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context2d = canvas.getContext("2d");
        if (!context2d) throw new Error("No 2D context.");
        context2d.drawImage(bitmap, 0, 0);
        const scale = bitmap.width / window.innerWidth;
        const pixel = (x: number, y: number) =>
          Array.from(context2d.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3));
        const rings = [...document.querySelectorAll(".section-rail-laser-ring")].map((ring) => {
          const box = ring.getBoundingClientRect();
          return pixel(box.left + box.width / 2, box.top + 1);
        });
        const last = [...document.querySelectorAll(".section-rail-button")].at(-1)?.getBoundingClientRect();
        return { rings, sidebar: pixel(32, (last?.bottom ?? 0) + 40) };
      }, png);
      samples.rings.forEach((ring, index) => {
        const color = colors[index] ?? "accent";
        const ratio = Math.round(contrastRatio(ring, samples.sidebar) * 100) / 100;
        report.contrast.push({ theme, color, ring, sidebar: samples.sidebar, ratio });
      });
    } finally {
      await context.close();
    }
  }
  report.minContrast = Math.min(...report.contrast.map((item) => item.ratio));
  for (const item of report.contrast) {
    if (item.ratio < MIN_RING_CONTRAST) {
      fail(`The ring of ${item.color} on the ${item.theme} theme has a contrast of ${item.ratio}.`);
    }
  }
}

mkdirSync(OUT, { recursive: true });
checkSources();
const browser = await chromium.launch(
  browserExecutable
    ? { executablePath: resolve(browserExecutable), headless: true }
    : { channel: "chrome", headless: true },
);
try {
  report.browser = browser.version();
  await checkCost(browser);
  await checkPause(browser);
  await checkGallery(browser);
  await checkDragPreview(browser);
  await checkContrast(browser);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
}
report.passed = report.failures.length === 0;
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...report, contrast: undefined }, null, 2)}\n`);
assert.deepEqual(report.failures, [], "The laser smoke found failures.");
