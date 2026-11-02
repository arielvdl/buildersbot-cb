// Checks that the open chat keeps the hue of its section, in the stories, with the real sidebar and CSS,
// in a headless browser. A chat below a marker with the tint style, or in a section box with a color,
// showed that color; when the user opened it, its row turned to the gray of the theme, so it no longer
// read as part of its section. In the dark and the light theme, it checks that:
// - below a tint marker, with each of the presets of the color menu (set in the marker editor), and in a
//   section box, with each preset (set in the Color menu of the section) and a custom color, the open
//   chat, a row under the pointer and a row with the keyboard focus keep the hue of the color; the open
//   chat differs from the rows at rest at least as much as the gray open chat does from its rows; the
//   open chat keeps `aria-pressed="true"`, a focused row keeps its focus ring, and the title, the
//   preview and the time keep 4.5:1 on each of these rows and on the rows at rest;
// - below a tint marker in a box with another color, the open chat takes the color of the marker;
// - a chat with no color opens in the gray of the theme (the surface token), as before.
// Pass the URL that `bun run storybook` reports:
//
//   bun scripts/sidebar-section-color-e2e.ts --storybook=http://localhost:6006 [--browser-executable=<path>] [--label=<name>]
//
// Writes .openbot-build/sidebar-section-color-e2e/<label>/report.json and a screenshot of the sidebar in
// each theme, with the open chat below the marker and in a box. Exits with 1 when a check fails.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateFor } from "@openbot/i18n";
import { SIDEBAR_SECTION_COLOR_PRESETS } from "@openbot/ui/features/sidebar/section-color";
import { chromium, type Locator, type Page } from "playwright-core";

const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const storybook = argument("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const browserExecutable = argument("browser-executable");
const label = argument("label") ?? "run";
assert.match(label, /^[a-z0-9-]+$/, "--label takes lower-case letters, digits and hyphens.");
const OUT = resolve(import.meta.dirname, "../.openbot-build/sidebar-section-color-e2e", label);

const english = translateFor("en");
const STORY = "navigation-section-rail--colored-open-chat";
type Scheme = "dark" | "light";
const SCHEMES: Scheme[] = ["dark", "light"];

/** The least OKLCH chroma that reads as a color, not a gray. The gray rows are at 0. */
const MIN_CHROMA = 0.02;
/** The most that the OKLCH hue of a row may move from the hue of its color over the sidebar. */
const HUE_TOLERANCE = 12;
/** The least OKLab distance that a pointer makes visible on a row. */
const MIN_HOVER_DISTANCE = 0.01;
const MIN_CONTRAST = 4.5;

type Rgb = [number, number, number];

interface TextSample {
  part: string;
  color: Rgb;
  background: Rgb;
}

interface RowSample {
  background: Rgb;
  texts: TextSample[];
  pressed: string | null;
  focusVisible: boolean;
  focusRing: boolean;
}

interface StateCheck {
  context: string;
  color: string;
  state: "open" | "rest" | "hover" | "focus" | "open-focus";
  row: string;
  background: string;
  chroma: number;
  hueShift: number | null;
  distanceFromRest: number | null;
  minContrast: number;
  failures: string[];
}

/** The gray rows of a theme: the fills of a chat with no color. */
interface GrayBaseline {
  sidebar: string;
  surface: string;
  open: string;
  rest: string;
  hover: string;
  openDistanceFromRest: number;
  failures: string[];
}

interface SchemeResult {
  baseline: GrayBaseline | null;
  checks: StateCheck[];
  screenshots: string[];
}

const report: {
  storybook: string;
  label: string;
  schemes: Partial<Record<Scheme, SchemeResult>>;
  errors: string[];
  failures: string[];
  passed: boolean;
} = { storybook, label, schemes: {}, errors: [], failures: [], passed: false };

// --- Color math: sRGB to OKLab, OKLCH, and the WCAG contrast ratio. ---

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function oklab([r, g, b]: Rgb): [number, number, number] {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function chroma(color: Rgb): number {
  const [, a, b] = oklab(color);
  return Math.hypot(a, b);
}

function hue(color: Rgb): number {
  const [, a, b] = oklab(color);
  return (Math.atan2(b, a) * 180) / Math.PI;
}

function hueShift(first: Rgb, second: Rgb): number {
  const difference = Math.abs(hue(first) - hue(second)) % 360;
  return difference > 180 ? 360 - difference : difference;
}

function distance(first: Rgb, second: Rgb): number {
  const [l1, a1, b1] = oklab(first);
  const [l2, a2, b2] = oklab(second);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(first: Rgb, second: Rgb): number {
  const [one, two] = [luminance(first), luminance(second)];
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

function hex(color: string): Rgb {
  const channel = (index: number) => Number.parseInt(color.slice(index, index + 2), 16);
  return [channel(1), channel(3), channel(5)];
}

function mix(color: Rgb, share: number, base: Rgb): Rgb {
  const channel = (index: 0 | 1 | 2) => color[index] * share + base[index] * (1 - share);
  return [channel(0), channel(1), channel(2)];
}

const css = (color: Rgb) => `rgb(${color.map((channel) => Math.round(channel)).join(" ")})`;

// --- The page. ---

function storyUrl(scheme: Scheme): string {
  return `${storybook}/iframe.html?id=${STORY}&viewMode=story&globals=locale:en;colorScheme:${scheme}`;
}

const list = (page: Page) => page.locator(".agent-list");
const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A chat row: its accessible name starts with the chat name, then a comma, a period or nothing. */
const chatRow = (page: Page, name: string) =>
  list(page).getByRole("button", { name: new RegExp(`^${escapeName(name)}(?=[.,]|$)`) });

/** The row's colors as the screen shows them: each fill composed over the fills behind it. */
async function sample(row: Locator): Promise<RowSample> {
  return row.evaluate(async (element) => {
    const rgba = (value: string): [number, number, number, number] => {
      const srgb = value.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/);
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, Number(srgb[4] ?? 1)];
      const rgb = value.match(/^rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:[,/] ?([\d.]+))?\)$/);
      if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4] ?? 1)];
      throw new Error(`Unknown color: ${value}`);
    };
    const over = (top: number[], base: number[]): [number, number, number] => {
      const alpha = top[3] ?? 1;
      const channel = (index: number) => (top[index] ?? 0) * alpha + (base[index] ?? 0) * (1 - alpha);
      return [channel(0), channel(1), channel(2)];
    };
    const backdrop = (start: Element): [number, number, number] => {
      const layers: number[][] = [];
      for (let node: Element | null = start; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "contents") continue;
        const layer = rgba(style.backgroundColor);
        layers.push(layer);
        if (layer[3] >= 1) break;
      }
      return layers.reverse().reduce<[number, number, number]>((base, layer) => over(layer, base), [255, 255, 255]);
    };
    // A pointer or a focus change starts a transition: wait for it to end, not for a time. A working chat
    // has an endless animation, which is not a transition.
    getComputedStyle(element).backgroundColor;
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished),
    );
    const texts = [...element.querySelectorAll(".agent-row-title, .agent-row-preview, .agent-row-time")]
      .filter((part) => part.textContent?.trim())
      .map((part) => {
        const background = backdrop(part);
        return {
          part: part.className.split(" ")[0] ?? "",
          color: over(rgba(getComputedStyle(part).color), background),
          background,
        };
      });
    const shadow = getComputedStyle(element).boxShadow;
    return {
      background: backdrop(element),
      texts,
      pressed: element.getAttribute("aria-pressed"),
      focusVisible: element.matches(":focus-visible"),
      focusRing: shadow !== "none" && shadow !== "",
    };
  });
}

/** A theme token as the page resolves it, made opaque over the sidebar. */
async function token(page: Page, name: string): Promise<Rgb> {
  return list(page).evaluate((element, property): Rgb => {
    const probe = document.createElement("div");
    probe.style.background = `var(${property})`;
    element.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const rgb = value.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
    return [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0];
  }, name);
}

async function open(page: Page, name: string): Promise<Locator> {
  const row = chatRow(page, name);
  await row.click();
  await page.waitForFunction((element) => element?.getAttribute("aria-pressed") === "true", await row.elementHandle());
  // The pointer leaves the rows, so the open row shows its own state.
  await page.mouse.move(2, 2);
  return row;
}

/** Moves the keyboard focus with Tab or Shift+Tab until it reaches the row. */
async function tabTo(page: Page, row: Locator, key: "Tab" | "Shift+Tab"): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    if (await row.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  assert.fail("Tab did not reach the row.");
}

async function setMarkerColor(page: Page, marker: string, color: string, name: string): Promise<void> {
  await list(page)
    .getByRole("button", { name: english("sidebar.marker.edit", { label: marker }) })
    .click();
  const editor = page.getByRole("dialog", { name: english("sidebar.marker.editor") });
  await editor.getByRole("button", { name, exact: true }).click();
  await editor.getByRole("button", { name: english("common.save"), exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.waitForFunction(
    ({ label, value }) =>
      [...document.querySelectorAll<HTMLElement>(".sidebar-marker")].some(
        (element) =>
          element.textContent?.includes(label) &&
          element.style.getPropertyValue("--sidebar-marker-color").trim() === value,
      ),
    { label: marker, value: color },
  );
}

async function setSectionColor(page: Page, section: string, color: string, name: string): Promise<void> {
  const box = list(page).locator(`section[aria-label="${section}"]`);
  await box.locator(".sidebar-section-toggle").click({ button: "right" });
  await page.getByRole("menuitem", { name: english("sidebar.section.color"), exact: true }).click();
  const choice = page.getByRole("menuitemradio", { name, exact: true });
  if ((await choice.getAttribute("aria-checked")) === "true") await page.keyboard.press("Escape");
  else await choice.click();
  while ((await page.getByRole("menu").count()) > 0) await page.keyboard.press("Escape");
  await page.waitForFunction(
    ({ label, value }) =>
      document
        .querySelector<HTMLElement>(`section[aria-label="${label}"]`)
        ?.style.getPropertyValue("--sidebar-section-color")
        .trim() === value,
    { label: section, value: color },
  );
}

interface ColorContext {
  context: string;
  color: string;
  /** The hue reference: the color over the sidebar. */
  reference: Rgb;
  openRow: string;
  restRow: string;
  /** A second open row of the other kind (agent or channel), checked for the open state only. */
  otherOpenRow?: string;
}

function evaluateState(
  context: ColorContext,
  state: StateCheck["state"],
  row: string,
  sampled: RowSample,
  rest: RowSample | null,
  baselineDistance: number,
): StateCheck {
  const failures: string[] = [];
  const shift = hueShift(sampled.background, context.reference);
  const rowChroma = chroma(sampled.background);
  const minContrast = Math.min(...sampled.texts.map((text) => contrast(text.color, text.background)));
  if (rowChroma < MIN_CHROMA) failures.push(`gray, chroma ${rowChroma.toFixed(3)} < ${MIN_CHROMA}`);
  else if (shift > HUE_TOLERANCE) failures.push(`hue moves ${shift.toFixed(1)} deg > ${HUE_TOLERANCE}`);
  if (sampled.texts.length === 0) failures.push("no text measured");
  if (minContrast < MIN_CONTRAST) failures.push(`text contrast ${minContrast.toFixed(2)} < ${MIN_CONTRAST}`);
  const fromRest = rest ? distance(sampled.background, rest.background) : null;
  if ((state === "open" || state === "open-focus") && sampled.pressed !== "true")
    failures.push(`aria-pressed is ${sampled.pressed}`);
  if (state === "rest" || state === "hover" || state === "focus") {
    if (sampled.pressed !== "false") failures.push(`aria-pressed is ${sampled.pressed}`);
  }
  if (state === "open" && fromRest !== null && fromRest < baselineDistance)
    failures.push(`open row is ${fromRest.toFixed(3)} from rest < gray open row ${baselineDistance.toFixed(3)}`);
  if (state === "hover" && fromRest !== null && fromRest < MIN_HOVER_DISTANCE)
    failures.push(`pointer changes nothing (${fromRest.toFixed(3)})`);
  if (state === "focus" || state === "open-focus") {
    if (!sampled.focusVisible) failures.push("no :focus-visible");
    if (!sampled.focusRing) failures.push("no focus ring");
  }
  return {
    context: context.context,
    color: context.color,
    state,
    row,
    background: css(sampled.background),
    chroma: Number(rowChroma.toFixed(4)),
    hueShift: Number(shift.toFixed(1)),
    distanceFromRest: fromRest === null ? null : Number(fromRest.toFixed(4)),
    minContrast: Number(minContrast.toFixed(2)),
    failures,
  };
}

async function checkContext(page: Page, context: ColorContext, baselineDistance: number): Promise<StateCheck[]> {
  const checks: StateCheck[] = [];
  const openRow = await open(page, context.openRow);
  const restRow = chatRow(page, context.restRow);
  const rest = await sample(restRow);
  checks.push(evaluateState(context, "rest", context.restRow, rest, null, baselineDistance));
  checks.push(evaluateState(context, "open", context.openRow, await sample(openRow), rest, baselineDistance));
  await restRow.hover();
  checks.push(evaluateState(context, "hover", context.restRow, await sample(restRow), rest, baselineDistance));
  await page.mouse.move(2, 2);
  // The focus moves from the open row with the keyboard, so it is visible.
  await tabTo(page, restRow, "Tab");
  checks.push(evaluateState(context, "focus", context.restRow, await sample(restRow), rest, baselineDistance));
  await tabTo(page, openRow, "Shift+Tab");
  checks.push(evaluateState(context, "open-focus", context.openRow, await sample(openRow), rest, baselineDistance));
  if (context.otherOpenRow) {
    const other = await open(page, context.otherOpenRow);
    checks.push(evaluateState(context, "open", context.otherOpenRow, await sample(other), rest, baselineDistance));
  }
  return checks;
}

async function screenshot(page: Page, name: string): Promise<string> {
  const sidebar = page.locator(".sidebar").first();
  const rect = await sidebar.boundingBox();
  assert.ok(rect, "The sidebar has no box.");
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({
    path,
    clip: { x: rect.x, y: rect.y, width: rect.width, height: Math.min(rect.height, 860) },
  });
  return path;
}

async function runScheme(page: Page, scheme: Scheme): Promise<void> {
  await page.goto(storyUrl(scheme));
  // The first load of a fresh Storybook compiles the stories first.
  await chatRow(page, "requests").waitFor({ timeout: 180_000 });
  const result: SchemeResult = { baseline: null, checks: [], screenshots: [] };
  report.schemes[scheme] = result;
  await page.mouse.move(2, 2);
  result.screenshots.push(await screenshot(page, `${scheme}-marker-open`));
  await open(page, "Recon");
  result.screenshots.push(await screenshot(page, `${scheme}-box-open`));

  // A chat with no color: "launch", above the marker, opens on the surface token; "Writer", below the
  // plain marker, rests on the sidebar.
  const sidebar = await token(page, "--openbot-bg-sidebar");
  const surface = await token(page, "--openbot-bg-surface");
  const grayOpen = await sample(await open(page, "launch"));
  const grayRest = await sample(chatRow(page, "Writer"));
  await chatRow(page, "Writer").hover();
  const grayHover = await sample(chatRow(page, "Writer"));
  await page.mouse.move(2, 2);
  const baselineDistance = distance(grayOpen.background, grayRest.background);
  const grayFailures: string[] = [];
  if (distance(grayOpen.background, surface) > 0.002)
    grayFailures.push(`open gray row ${css(grayOpen.background)} is not the surface ${css(surface)}`);
  if (distance(grayRest.background, sidebar) > 0.002)
    grayFailures.push(`gray row at rest ${css(grayRest.background)} is not the sidebar ${css(sidebar)}`);
  if (chroma(grayHover.background) > 0.005) grayFailures.push(`gray row under the pointer has a color`);
  if (grayOpen.pressed !== "true") grayFailures.push("open gray row is not pressed");
  result.baseline = {
    sidebar: css(sidebar),
    surface: css(surface),
    open: css(grayOpen.background),
    rest: css(grayRest.background),
    hover: css(grayHover.background),
    openDistanceFromRest: Number(baselineDistance.toFixed(4)),
    failures: grayFailures,
  };
  for (const failure of grayFailures) report.failures.push(`${scheme} no color: ${failure}`);

  const presets = SIDEBAR_SECTION_COLOR_PRESETS.map((preset) => ({ color: preset.color, name: english(preset.label) }));
  const contexts: { context: ColorContext; setup: () => Promise<void> }[] = [
    ...presets.map((preset) => ({
      context: {
        context: "marker",
        color: preset.color,
        reference: mix(hex(preset.color), 0.2, sidebar),
        openRow: "requests",
        restRow: "chat improvements",
        otherOpenRow: "Scout",
      },
      setup: () => setMarkerColor(page, "Routines", preset.color, preset.name),
    })),
    ...presets.map((preset) => ({
      context: {
        context: "box",
        color: preset.color,
        reference: mix(hex(preset.color), 0.2, sidebar),
        openRow: "Recon",
        restRow: "Exploit",
        otherOpenRow: "ops",
      },
      setup: () => setSectionColor(page, "Red Team", preset.color, preset.name),
    })),
    {
      context: {
        context: "box-custom",
        color: "#14b8a6",
        reference: mix(hex("#14b8a6"), 0.2, sidebar),
        openRow: "Opus",
        restRow: "Fable",
      },
      setup: async () => undefined,
    },
    {
      // The yellow marker in the blue cb box: the open chat takes the marker color.
      context: {
        context: "marker-in-box",
        color: "#eab308",
        reference: mix(hex("#eab308"), 0.2, sidebar),
        openRow: "Host",
        restRow: "live",
      },
      setup: async () => undefined,
    },
  ];
  for (const { context, setup } of contexts) {
    await setup();
    const checks = await checkContext(page, context, baselineDistance);
    // In the nested case the row at rest mixes the two colors, so only the open row checks the hue.
    for (const check of checks) {
      if (context.context === "marker-in-box" && check.state !== "open" && check.state !== "open-focus")
        check.failures = check.failures.filter((failure) => !failure.startsWith("hue") && !failure.startsWith("gray"));
      result.checks.push(check);
      for (const failure of check.failures)
        report.failures.push(`${scheme} ${check.context} ${check.color} ${check.state} ${check.row}: ${failure}`);
    }
  }

  // The gray open row is the same after the colors changed.
  const grayAgain = await sample(await open(page, "Editor"));
  if (distance(grayAgain.background, surface) > 0.002)
    report.failures.push(`${scheme} no color: open "Editor" ${css(grayAgain.background)} is not the surface`);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), headless: true } : { headless: true },
);
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 1000 }, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => report.errors.push(error.message));
  for (const scheme of SCHEMES) await runScheme(page, scheme);
} finally {
  await browser.close();
}

for (const error of report.errors) report.failures.push(`page error: ${error}`);
report.passed = report.failures.length === 0;
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const print = (line: string) => process.stdout.write(`${line}\n`);
for (const scheme of SCHEMES) {
  const result = report.schemes[scheme];
  if (!result) continue;
  const failed = result.checks.filter((check) => check.failures.length > 0).length;
  print(`${scheme}: ${result.checks.length - failed}/${result.checks.length} row states pass`);
  for (const state of ["open", "hover", "focus", "rest"] as const) {
    const rows = result.checks.filter((check) => check.state === state);
    const bad = rows.filter((check) => check.failures.length > 0).length;
    print(`  ${state}: ${rows.length - bad}/${rows.length}`);
  }
}
print(`${report.failures.length} failures. Report: ${resolve(OUT, "report.json")}`);
if (!report.passed) {
  for (const failure of report.failures.slice(0, 40)) print(`  - ${failure}`);
  process.exit(1);
}
