// Measures how the agent chat handles very large text, in a running Storybook that renders the real
// chat against the preview mock (`Conversation/Conversation/Very Long Reply`). Read-only.
//
// `bun scripts/chat-large-text-perf-e2e.ts --storybook=<url> [--scenarios=open,stream,history,composer]
//  [--sizes=10000,100000,1000000] [--kinds=markdown,code,table] [--out=<folder>] [--compare=<report.json>]`
//
// - open: one reply of each size and kind. Time until the reply shows, long tasks, heap and DOM nodes.
//   The whole reply must be in the page: its last line is in the row text.
// - stream: a reply of each size that grows by 150 steps, one each 30 ms. Main-thread time per step
//   (CDP `TaskDuration`), frame gaps and long tasks while it grows.
// - history: 5000 short messages, and 500 messages of 10 KB. Time to open and to jump to the start.
// - composer: a paste of each size into the message box, then 30 typed characters after a 90 KB draft.
//   A paste must lose no text: the message box holds all of it, or it holds an attachment.
//
// Start Storybook with `OPENBOT_STORYBOOK_SOLID_RELEASE=1 bun run storybook --no-open`, so Solid's
// development checks and performance tracks do not take most of the time. The rest of Storybook is a
// development build, so compare times only with other runs of this script. The script
// stops when swap grows by more than `--max-swap-growth-mb` (default 600), so it cannot push the
// computer into heavy swapping. Writes .openbot-build/<out>/report.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { type Browser, type CDPSession, chromium, type Page } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const STORY = "conversation-conversation--very-long-reply";
const REPLY = '[data-chat-search-message="long-reply"]';
const COMPOSER = ".composer [contenteditable='true']";
const CASE_TIMEOUT_MS = 180_000;
const STREAM_STEPS = 150;
const STREAM_GAP_MS = 30;

function option(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const storybook = option("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const scenarios = new Set((option("scenarios") ?? "open,stream,history,composer").split(","));
// 5 MB is not in the default: a reply of that size can crash the page of a development build.
const sizes = (option("sizes") ?? "10000,100000,1000000").split(",").map(Number);
const kinds = (option("kinds") ?? "markdown,code,table").split(",");
const outName = option("out") ?? "chat-large-text-perf";
assert.match(outName, /^\w[\w.-]*$/, "--out takes a folder name, not a path.");
const OUT = resolve(ROOT, ".openbot-build", outName);
const maxSwapGrowthMb = Number(option("max-swap-growth-mb") ?? "600");
const comparePath = option("compare");

type Row = Record<string, number | string | boolean | null>;
interface Report {
  createdAt: string;
  commit: string;
  swapStartMb: number;
  stoppedForSwap: boolean;
  rows: Row[];
  failures: string[];
  comparison?: Row[];
}

function swapUsedMb(): number {
  if (process.platform !== "darwin") return 0;
  const text = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" });
  return Number(/used = ([\d.]+)M/u.exec(text)?.[1] ?? "0");
}

const report: Report = {
  createdAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  swapStartMb: swapUsedMb(),
  stoppedForSwap: false,
  rows: [],
  failures: [],
};

/* Long tasks, frame gaps and slow input events, from page start.
   Storybook runs the development build of Solid, which writes a warning with its whole owner path for
   each untracked read, and Storybook sends each console entry to its server. The release build has
   neither, and a 100 KB reply made 18,000 of them, so the console does not forward them here. */
const OBSERVERS = `(() => {
  const quiet = (original) => (...args) => {
    if (typeof args[0] === "string" && args[0].startsWith("[")) return;
    original.apply(console, args);
  };
  for (const level of ["warn", "error"]) {
    const filtered = quiet(console[level]);
    Object.defineProperty(console, level, { configurable: false, get: () => filtered, set: () => {} });
  }
  const state = { from: 0, longTasks: [], frames: [], events: [] };
  window.__largeTextPerf = state;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) state.longTasks.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) state.events.push({ name: entry.name, start: entry.startTime, duration: entry.duration });
  }).observe({ type: "event", durationThreshold: 16, buffered: true });
  let last = 0;
  const frame = (now) => {
    if (last) state.frames.push({ at: now, gap: now - last });
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})()`;

interface ObservedEntry {
  start?: number;
  at?: number;
  duration?: number;
  gap?: number;
}

declare global {
  interface Window {
    __largeTextPerf?: { longTasks: ObservedEntry[]; frames: ObservedEntry[]; events: ObservedEntry[] };
    __largeTextImportedBytes?: number;
  }
}

interface WindowStats {
  longTasks: number;
  longTaskMs: number;
  longestTaskMs: number;
  framesP95Ms: number;
  framesMaxMs: number;
  slowInputEvents: number;
  slowestInputMs: number;
}

async function windowStats(page: Page, from: number): Promise<WindowStats> {
  return page.evaluate((start) => {
    const state = window.__largeTextPerf;
    if (!state) throw new Error("The page has no observers.");
    const tasks = state.longTasks.filter((entry) => (entry.start ?? 0) >= start);
    const gaps = state.frames
      .filter((entry) => (entry.at ?? 0) >= start)
      .map((entry) => entry.gap ?? 0)
      .sort((a, b) => a - b);
    const events = state.events.filter((entry) => (entry.start ?? 0) >= start);
    const percentile = (values: number[], share: number) =>
      values[Math.min(values.length - 1, Math.floor(values.length * share))] ?? 0;
    return {
      longTasks: tasks.length,
      longTaskMs: Math.round(tasks.reduce((sum, entry) => sum + (entry.duration ?? 0), 0)),
      longestTaskMs: Math.round(Math.max(0, ...tasks.map((entry) => entry.duration ?? 0))),
      framesP95Ms: Math.round(percentile(gaps, 0.95)),
      framesMaxMs: Math.round(gaps.at(-1) ?? 0),
      slowInputEvents: events.length,
      slowestInputMs: Math.round(Math.max(0, ...events.map((entry) => entry.duration ?? 0))),
    };
  }, from);
}

async function cdpMetrics(client: CDPSession): Promise<Record<string, number>> {
  const { metrics } = await client.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

/** Two frames, so the work that a change started has painted. */
async function painted(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now())))),
  );
}

async function heapAndNodes(page: Page, client: CDPSession): Promise<{ heapMb: number; domNodes: number }> {
  await client.send("HeapProfiler.collectGarbage");
  const metrics = await cdpMetrics(client);
  return {
    heapMb: Math.round((metrics.JSHeapUsedSize ?? 0) / 1048576),
    domNodes: await page.evaluate(() => document.getElementsByTagName("*").length),
  };
}

function storyUrl(parameters: Record<string, string | number>): string {
  const query = new URLSearchParams({ id: STORY, viewMode: "story" });
  for (const [key, value] of Object.entries(parameters)) query.set(key, String(value));
  return `${storybook}/iframe.html?${query}`;
}

async function openPage(browser: Browser, parameters: Record<string, string | number>) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
  page.setDefaultTimeout(CASE_TIMEOUT_MS);
  await page.addInitScript(OBSERVERS);
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  // A story that throws never shows the reply: fail at once instead of at the case timeout.
  const crashed = new Promise<never>((_, reject) =>
    page.on("pageerror", (error) => reject(new Error(`The story threw: ${error.message}`))),
  );
  await page.goto(storyUrl(parameters), { waitUntil: "domcontentloaded" });
  await Promise.race([page.waitForSelector(REPLY, { state: "attached" }), crashed]);
  const painting = await painted(page);
  // From the mount of the chat, so the time leaves out the Storybook start.
  const mountAt = await page.evaluate(() => performance.getEntriesByName("long-reply:mount")[0]?.startTime ?? 0);
  return { page, client, readyAt: painting - mountAt, mountAt };
}

/** The text of the reply's last line, which must be in the page once the reply shows. */
function lastLineMarker(kind: string, bytes: number): RegExp {
  if (kind === "code") return /const value\d+ = compute/u;
  if (kind === "table") return /Owner \d+/u;
  return bytes > 0 ? /Run the smoke test again/u : /./u;
}

async function caseOpen(browser: Browser, kind: string, bytes: number): Promise<Row> {
  const { page, client, readyAt, mountAt } = await openPage(browser, { longReply: kind, longReplyBytes: bytes });
  try {
    const metrics = await cdpMetrics(client);
    const stats = await windowStats(page, mountAt);
    const memory = await heapAndNodes(page, client);
    const text = await page.locator(REPLY).evaluate((row) => row.textContent ?? "");
    assert.match(text.slice(-400), lastLineMarker(kind, bytes), `The ${kind} reply of ${bytes} bytes shows its end.`);
    return {
      scenario: "open",
      kind,
      bytes,
      openMs: Math.round(readyAt),
      scriptMs: Math.round((metrics.ScriptDuration ?? 0) * 1000),
      layoutMs: Math.round((metrics.LayoutDuration ?? 0) * 1000),
      styleMs: Math.round((metrics.RecalcStyleDuration ?? 0) * 1000),
      replyTextChars: text.length,
      ...stats,
      ...memory,
    };
  } finally {
    await page.close();
  }
}

async function caseStream(browser: Browser, kind: string, bytes: number): Promise<Row> {
  const { page, client } = await openPage(browser, {
    longReply: kind,
    longReplyBytes: bytes,
    streamSteps: STREAM_STEPS,
    streamGapMs: STREAM_GAP_MS,
  });
  try {
    // Let the first render settle, so the stream window holds only the stream.
    await page.waitForTimeout(1_000);
    const before = await cdpMetrics(client);
    const from = await page.evaluate(() => {
      window.dispatchEvent(new Event("long-reply-stream"));
      return performance.now();
    });
    await page.waitForFunction(() => performance.getEntriesByName("long-reply:stream-end").length > 0, undefined, {
      polling: 100,
    });
    const after = await cdpMetrics(client);
    const wallMs = await page.evaluate(() => {
      const start = performance.getEntriesByName("long-reply:stream-start")[0]?.startTime ?? 0;
      const end = performance.getEntriesByName("long-reply:stream-end")[0]?.startTime ?? 0;
      return end - start;
    });
    const per = (name: string) =>
      Math.round((((after[name] ?? 0) - (before[name] ?? 0)) * 1000 * 10) / STREAM_STEPS) / 10;
    return {
      scenario: "stream",
      kind,
      bytes,
      steps: STREAM_STEPS,
      wallMs: Math.round(wallMs),
      idealMs: STREAM_STEPS * STREAM_GAP_MS,
      taskMsPerStep: per("TaskDuration"),
      scriptMsPerStep: per("ScriptDuration"),
      layoutMsPerStep: per("LayoutDuration"),
      styleMsPerStep: per("RecalcStyleDuration"),
      ...(await windowStats(page, from)),
    };
  } finally {
    await page.close();
  }
}

async function caseHistory(browser: Browser, count: number, historyBytes: number): Promise<Row> {
  const { page, client, readyAt } = await openPage(browser, {
    longReplyBytes: 1_000,
    historyCount: count,
    historyBytes,
  });
  try {
    const opened = await heapAndNodes(page, client);
    const from = await page.evaluate(() => performance.now());
    await page.evaluate((selector) => {
      const scroll = document.querySelector(selector);
      if (scroll) scroll.scrollTop = 0;
    }, ".conversation-scroll");
    const jumped = await painted(page);
    await page.waitForTimeout(500);
    return {
      scenario: "history",
      kind: "markdown",
      bytes: historyBytes,
      messages: count,
      openMs: Math.round(readyAt),
      jumpToStartMs: Math.round(jumped - from),
      ...(await windowStats(page, from)),
      ...opened,
    };
  } finally {
    await page.close();
  }
}

function pasteText(bytes: number): string {
  const line = "Pasted log line with a request id, a status and a short note about the result.\n";
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

async function composerState(page: Page): Promise<{ chars: number; attachments: number; importedBytes: number }> {
  return page.evaluate((selector) => {
    const editor = document.querySelector(selector);
    return {
      chars: editor?.textContent?.length ?? 0,
      attachments: editor?.querySelectorAll("[data-attachment-reference-id]").length ?? 0,
      importedBytes: window.__largeTextImportedBytes ?? 0,
    };
  }, COMPOSER);
}

/* Counts the bytes of the files that the message box imports, at the preview API boundary. */
const COUNT_IMPORTS = `(() => {
  window.__largeTextImportedBytes = 0;
  const agent = window.openbot.agent;
  const importData = agent.importAttachmentData.bind(agent);
  agent.importAttachmentData = (data) => {
    for (const file of data) window.__largeTextImportedBytes += file.bytes.byteLength;
    return importData(data);
  };
})()`;

async function casePaste(browser: Browser, bytes: number): Promise<Row> {
  const { page } = await openPage(browser, { longReplyBytes: 1_000 });
  try {
    await page.evaluate(COUNT_IMPORTS);
    await page.locator(COMPOSER).click();
    const from = await page.evaluate(
      ({ selector, text }) => {
        const editor = document.querySelector(selector);
        const data = new DataTransfer();
        data.setData("text/plain", text);
        const start = performance.now();
        editor?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        return start;
      },
      { selector: COMPOSER, text: pasteText(bytes) },
    );
    const done = await painted(page);
    // The text is in the box, or a file import put a reference to it there.
    await page
      .waitForFunction(
        ({ selector, size }) => {
          const editor = document.querySelector(selector);
          return (
            (editor?.textContent?.length ?? 0) >= Math.min(size, 100_000) ||
            (editor?.querySelector("[data-attachment-reference-id]") ?? null) !== null
          );
        },
        { selector: COMPOSER, size: bytes },
        { timeout: 30_000 },
      )
      .catch(() => undefined);
    const state = await composerState(page);
    const kept = state.chars >= bytes || (state.attachments === 1 && state.importedBytes >= bytes);
    if (!kept)
      report.failures.push(
        `A paste of ${bytes} characters kept ${state.chars} characters and ${state.importedBytes} bytes of files.`,
      );
    return {
      scenario: "paste",
      kind: "text",
      bytes,
      pasteMs: Math.round(done - from),
      composerChars: state.chars,
      attachments: state.attachments,
      importedBytes: state.importedBytes,
      textKept: kept,
      ...(await windowStats(page, from)),
    };
  } finally {
    await page.close();
  }
}

async function caseTyping(browser: Browser, draftBytes: number): Promise<Row> {
  const { page } = await openPage(browser, { longReplyBytes: 1_000 });
  try {
    const editor = page.locator(COMPOSER);
    await editor.click();
    if (draftBytes > 0) {
      await page.evaluate(
        ({ selector, text }) => {
          const data = new DataTransfer();
          data.setData("text/plain", text);
          document
            .querySelector(selector)
            ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        },
        { selector: COMPOSER, text: pasteText(draftBytes) },
      );
      await painted(page);
      await page.waitForTimeout(500);
    }
    const typed = "abcdefghij".repeat(3);
    const from = await page.evaluate(() => performance.now());
    await page.keyboard.type(typed);
    const done = await painted(page);
    const state = await composerState(page);
    return {
      scenario: "typing",
      kind: "text",
      bytes: draftBytes,
      keys: typed.length,
      msPerKey: Math.round(((done - from) / typed.length) * 10) / 10,
      composerChars: state.chars,
      ...(await windowStats(page, from)),
    };
  } finally {
    await page.close();
  }
}

function compareRows(previous: readonly DynamicRecord[], current: Row[]): Row[] {
  const key = (row: DynamicRecord | Row) => `${row.scenario}:${row.kind}:${row.bytes}:${row.messages ?? ""}`;
  const old = new Map(previous.map((row) => [key(row), row]));
  return current.flatMap((row) => {
    const before = old.get(key(row));
    if (!before) return [];
    const change: Row = { case: key(row) };
    for (const [name, value] of Object.entries(row)) {
      const earlier = before[name];
      if (typeof value === "number" && typeof earlier === "number" && name !== "bytes" && name !== "messages")
        change[name] = `${earlier} -> ${value}`;
    }
    return [change];
  });
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const cases: { name: string; run: () => Promise<Row> }[] = [];
if (scenarios.has("open")) {
  cases.push({ name: "open markdown 1000", run: () => caseOpen(browser, "markdown", 1_000) });
  for (const kind of kinds)
    for (const bytes of sizes) cases.push({ name: `open ${kind} ${bytes}`, run: () => caseOpen(browser, kind, bytes) });
}
if (scenarios.has("stream"))
  for (const kind of kinds)
    for (const bytes of sizes.filter((size) => size <= 1_000_000))
      cases.push({ name: `stream ${kind} ${bytes}`, run: () => caseStream(browser, kind, bytes) });
if (scenarios.has("history")) {
  cases.push({ name: "history 5000 x 200", run: () => caseHistory(browser, 5_000, 200) });
  cases.push({ name: "history 500 x 10000", run: () => caseHistory(browser, 500, 10_000) });
}
if (scenarios.has("composer")) {
  for (const bytes of sizes) cases.push({ name: `paste ${bytes}`, run: () => casePaste(browser, bytes) });
  cases.push({ name: "typing empty", run: () => caseTyping(browser, 0) });
  cases.push({ name: "typing 90000", run: () => caseTyping(browser, 90_000) });
}
try {
  // The first load compiles the story modules. It is not a measurement.
  await (await openPage(browser, { longReplyBytes: 1_000 })).page.close();
  // Swap that Storybook's start added is not the cases' doing.
  report.swapStartMb = swapUsedMb();
  for (const entry of cases) {
    if (swapUsedMb() - report.swapStartMb > maxSwapGrowthMb) {
      report.stoppedForSwap = true;
      report.failures.push(`Stopped before "${entry.name}": swap grew by more than ${maxSwapGrowthMb} MB.`);
      break;
    }
    try {
      const row = await entry.run();
      report.rows.push(row);
      process.stdout.write(`${entry.name}: ${JSON.stringify(row)}\n`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
      report.failures.push(`${entry.name}: ${message}`);
      report.rows.push({ scenario: entry.name, error: message ?? "failed" });
      process.stdout.write(`${entry.name}: failed: ${message}\n`);
    }
  }
  if (comparePath) {
    const previous = JSON.parse(readFileSync(comparePath, "utf8"));
    const rows = isDynamicRecord(previous) && Array.isArray(previous.rows) ? previous.rows.filter(isDynamicRecord) : [];
    report.comparison = compareRows(rows, report.rows);
  }
} finally {
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
assert.equal(report.failures.length, 0, report.failures.join("\n"));
