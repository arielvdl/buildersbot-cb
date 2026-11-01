// Checks the model section of the agent dialog of a channel ("New agent"), in the real app on the
// preview mock, with the real CSS, in a headless browser with a new profile. Pass the URL that
// `bun run storybook` reports:
//
//   bun scripts/agent-model-picker-e2e.ts --storybook=http://localhost:6006
//
// The window sizes and interface sizes are the ones of a person who reported the section cut to a
// strip: the interface size is Chromium page zoom, so a window of W x H at 110% is a viewport of
// W/1.1 x H/1.1 CSS pixels at a device scale of 1.1. For each one, the script opens the section and
// checks that every control in it can be seen and hit (no ancestor clips it and nothing covers it),
// and that the dialog does not move under the pointer. It checks the section again when the
// provider check answers after the section opened, and that the answer does not pull back a person
// who went on to the next fields. Then it chooses a provider, a model and an effort, and checks the
// closed row shows them. It checks the keyboard (Enter in the search does not send the form, and
// Escape closes the section before the dialog), an agent to edit, a model that its provider no
// longer lists, and the focus when a provider of Other providers gets ready. `--keep-going` records
// a failed case and goes on, to take the screenshots of every case before it fails.
//
// Writes .openbot-build/agent-model-picker-e2e/report.json and one screenshot per state.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";

const logger = createBuildersBotLogger("agent-model-picker-e2e");
const OUT = resolve(import.meta.dirname, "../.openbot-build/agent-model-picker-e2e");
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const storybook = argument("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const keepGoing = process.argv.includes("--keep-going");
/** Runs only the cases whose name holds one of these comma-separated parts. */
const only = argument("only")?.split(",") ?? null;

type Locale = "en" | "pt";
type Scheme = "dark" | "light";

interface WindowCase {
  name: string;
  width: number;
  height: number;
  zoom: number;
}

/** The window of the report at 110%, the same at 100% and 130%, a short window and a narrow one. */
const WINDOWS: WindowCase[] = [
  { name: "1280x800-100", width: 1280, height: 800, zoom: 1 },
  { name: "1280x800-110", width: 1280, height: 800, zoom: 1.1 },
  { name: "1280x800-130", width: 1280, height: 800, zoom: 1.3 },
  { name: "short-1280x600-110", width: 1280, height: 600, zoom: 1.1 },
  { name: "short-1280x600-130", width: 1280, height: 600, zoom: 1.3 },
  { name: "narrow-640x760-110", width: 640, height: 760, zoom: 1.1 },
];

const TEXT = {
  en: {
    model: /^Agent model: /u,
    providers: "Model providers",
    efforts: "Agent reasoning effort",
    others: /^Other providers/u,
    claude: /^Claude\b/u,
    opus: "Claude Opus 5.5",
    effort: "Low",
    download: "Download",
    connect: "Connect",
    name: "Agent name",
    instructions: "Agent instructions",
    search: "Search models",
    openRouter: /^OpenRouter: /u,
    checking: "ChatGPT: Checking",
    connectGrok: "Connect Grok",
    grok: /^Grok: /u,
    sonnet: "Claude Sonnet 5",
    high: "High",
    notListed: "Not listed",
    notDownloaded: "Not downloaded",
    notInstalled: "Not installed",
    downloadCline: "Download Cline to use its models.",
  },
  pt: {
    model: /^Modelo do agente: /u,
    providers: "Provedores de modelos",
    efforts: "Esforço de raciocínio do agente",
    others: /^Outros provedores/u,
    claude: /^Claude\b/u,
    opus: "Claude Opus 5.5",
    effort: "Baixo",
    download: "Baixar",
    connect: "Conectar",
    name: "Nome do agente",
    instructions: "Instruções do agente",
    search: "Buscar modelos",
    openRouter: /^OpenRouter: /u,
    checking: "ChatGPT: Verificando",
    connectGrok: "Conectar Grok",
    grok: /^Grok: /u,
    sonnet: "Claude Sonnet 5",
    high: "Alto",
    notListed: "Não listado",
    notDownloaded: "Não baixado",
    notInstalled: "Não instalado",
    downloadCline: "Baixe Cline para usar seus modelos.",
  },
} as const;

function storyUrl(story: string, locale: Locale, scheme: Scheme): string {
  return `${storybook}/iframe.html?id=${story}&viewMode=story&globals=locale:${locale};colorScheme:${scheme}`;
}

const screenshots: string[] = [];
const results: { name: string; ok: boolean; detail: string }[] = [];
mkdirSync(OUT, { recursive: true });

async function shot(page: Page, name: string): Promise<void> {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  screenshots.push(path);
}

/** A page in a window of this size and interface size, in a new profile. */
async function newWindow(browser: Browser, size: WindowCase, locale: Locale, scheme: Scheme) {
  const context = await browser.newContext({
    viewport: { width: Math.round(size.width / size.zoom), height: Math.round(size.height / size.zoom) },
    deviceScaleFactor: size.zoom,
    locale: locale === "pt" ? "pt-BR" : "en-US",
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  return { context, page: await context.newPage() };
}

/** Two animation frames: the layout, the resize observers and the scroll that they start are done. */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );
}

/** Waits for the row to say that its section is open, or closed. */
async function waitExpanded(page: Page, trigger: Locator, open: boolean): Promise<void> {
  await page.waitForFunction(([button, expanded]) => button?.getAttribute("aria-expanded") === expanded, [
    await trigger.elementHandle(),
    open ? "true" : "false",
  ] as const);
}

/**
 * Each element can be seen and hit: after it scrolls into the middle of its scroll box, its center
 * and a point near the middle of each edge hit the element itself. A point that an ancestor clips,
 * or that another element covers (the next field, the sticky footer), hits something else. A radio
 * input is drawn by its item, so the item is the one that is hit.
 */
async function hiddenParts(elements: Locator, scroll = true): Promise<string[]> {
  return elements.evaluateAll((nodes, scrollFirst) => {
    const problems: string[] = [];
    for (const node of nodes) {
      const target =
        node instanceof HTMLInputElement && node.type === "radio"
          ? (node.closest("[role=radio], label, div") ?? node)
          : node;
      // Only the boxes that the user scrolls move, from the inner one out: scrollIntoView would also
      // scroll the frame of the dialog, which clips its overflow, and hide a part that the user
      // cannot reach.
      for (let scroller = scrollFirst ? target.parentElement : null; scroller; scroller = scroller.parentElement) {
        if (!/^(auto|scroll)$/u.test(getComputedStyle(scroller).overflowY)) continue;
        const port = scroller.getBoundingClientRect();
        const own = target.getBoundingClientRect();
        scroller.scrollTop += own.top + own.height / 2 - (port.top + port.height / 2);
      }
      const box = target.getBoundingClientRect();
      const name = (target.getAttribute("aria-label") ?? target.textContent ?? "").trim().slice(0, 40);
      if (box.width < 4 || box.height < 4) {
        problems.push(`${name}: ${Math.round(box.width)}x${Math.round(box.height)}`);
        continue;
      }
      const inset = Math.min(3, box.width / 4, box.height / 4);
      const middleX = box.left + box.width / 2;
      const middleY = box.top + box.height / 2;
      const points = [
        [middleX, middleY],
        [middleX, box.top + inset],
        [middleX, box.bottom - inset],
        [box.left + inset, middleY],
        [box.right - inset, middleY],
      ] as const;
      for (const [x, y] of points) {
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === target || target.contains(hit))) continue;
        const what = hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join(".")}` : "nothing";
        problems.push(`${name}: (${Math.round(x)}, ${Math.round(y)}) hits ${what}`);
        break;
      }
    }
    return problems;
  }, scroll);
}

/**
 * How much of the picker the form shows right after it opens, between its top and the footer. A
 * picker taller than the form starts one scroll margin under the top of the form, so the field
 * above it stays in sight.
 */
async function shownAfterOpen(trigger: Locator): Promise<{ shown: number; needed: number }> {
  return trigger.evaluate((button) => {
    const picker = button.parentElement ?? button;
    const form = button.closest("form");
    const footer = form?.querySelector("footer");
    if (!form) return { shown: 0, needed: 1 };
    const port = form.getBoundingClientRect();
    const bottom = footer ? footer.getBoundingClientRect().top : port.bottom;
    const margin = Number.parseFloat(getComputedStyle(picker).scrollMarginTop) || 0;
    const box = picker.getBoundingClientRect();
    const shown = Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, port.top));
    const room = bottom - port.top - margin;
    return { shown: Math.round(shown), needed: Math.round(Math.min(box.height, room) - 2) };
  });
}

/** The top of the dialog that holds the row, in the window. */
async function dialogTop(trigger: Locator): Promise<number> {
  return trigger.evaluate((button) => Math.round(button.closest("[role=dialog]")?.getBoundingClientRect().top ?? -1));
}

/** The height of the section that the row opens. */
async function sectionHeight(trigger: Locator): Promise<number> {
  return trigger.evaluate((button) => {
    const id = button.getAttribute("aria-controls");
    return id ? (document.getElementById(id)?.getBoundingClientRect().height ?? 0) : 0;
  });
}

/** Waits for the section of the row to be taller than `height`. */
async function waitSectionTaller(page: Page, trigger: Locator, height: number): Promise<void> {
  await page.waitForFunction(
    ([button, before]) => {
      const id = button?.getAttribute("aria-controls");
      const section = id ? document.getElementById(id) : null;
      return (section?.getBoundingClientRect().height ?? 0) > before;
    },
    [await trigger.elementHandle(), height] as const,
  );
}

/** The role of the focused element, its name, and whether it is the chosen tab. */
async function focused(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    const radio = element instanceof HTMLInputElement && element.type === "radio";
    return {
      role: radio ? "radio" : (element?.getAttribute("role") ?? element?.tagName.toLowerCase()),
      name: (element?.getAttribute("aria-label") ?? element?.textContent ?? "").trim(),
      selected: element?.getAttribute("aria-selected"),
    };
  });
}

async function openDialog(page: Page, url: string, locale: Locale) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 300_000 });
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 240_000 });
  const trigger = dialog.getByRole("button", { name: TEXT[locale].model });
  await trigger.waitFor({ timeout: 60_000 });
  return { dialog, trigger };
}

/** The controls of the open section: the providers, the models, the efforts. */
function sectionControls(page: Page, locale: Locale) {
  const providers = page.getByRole("tablist", { name: TEXT[locale].providers }).getByRole("tab");
  const models = page.getByRole("listbox").getByRole("option");
  const efforts = page.getByRole("radiogroup", { name: TEXT[locale].efforts }).getByRole("radio");
  return { providers, models, efforts };
}

async function checkSection(page: Page, trigger: Locator, locale: Locale, label: string): Promise<void> {
  const { providers, models, efforts } = sectionControls(page, locale);
  await models.first().waitFor({ timeout: 30_000 });
  await nextFrames(page);
  // The dialog that holds the row: a popover of the picker is a dialog too.
  const frame = await trigger.evaluate((button) => button.closest("[role=dialog]")?.scrollTop ?? 0);
  assert.equal(frame, 0, `${label}: the frame of the dialog scrolled, so its header or footer moved.`);
  const shown = await shownAfterOpen(trigger);
  assert.ok(
    shown.shown >= shown.needed,
    `${label}: the form shows ${shown.shown}px of the open section, not ${shown.needed}px.`,
  );
  const problems = [...(await hiddenParts(providers)), ...(await hiddenParts(models)), ...(await hiddenParts(efforts))];
  assert.deepEqual(problems, [], `${label}: a part of the model section cannot be seen or hit.`);
  assert.ok((await providers.count()) >= 4, `${label}: the section lists fewer than four ready providers.`);
  assert.ok((await efforts.count()) >= 2, `${label}: the section shows no effort choice.`);
}

async function runCase(browser: Browser, size: WindowCase, locale: Locale, scheme: Scheme, full: boolean) {
  const label = `${size.name}-${locale}-${scheme}`;
  const { context, page } = await newWindow(browser, size, locale, scheme);
  try {
    const { dialog, trigger } = await openDialog(
      page,
      storyUrl("channels-member-dialog--new-agent", locale, scheme),
      locale,
    );
    await shot(page, `${label}-closed`);
    const closedTop = await dialogTop(trigger);
    await trigger.click();
    await waitExpanded(page, trigger, true);
    await sectionControls(page, locale).models.first().waitFor({ timeout: 30_000 });
    await shot(page, `${label}-open`);
    await checkSection(page, trigger, locale, label);
    // The dialog grows down from its top: the row that was just pressed stays under the pointer,
    // and only the form scrolls when the section needs the room.
    assert.equal(await dialogTop(trigger), closedTop, `${label}: the dialog moved when the section opened.`);
    if (!full) return;

    // The other providers are listed apart, each with the action it needs.
    const others = dialog.getByRole("button", { name: TEXT[locale].others });
    await others.click();
    const download = dialog.getByRole("button", { name: TEXT[locale].download });
    const connect = dialog.getByRole("button", { name: TEXT[locale].connect });
    await download.first().waitFor();
    await connect.first().waitFor();
    assert.deepEqual(
      [...(await hiddenParts(download)), ...(await hiddenParts(connect))],
      [],
      `${label}: an action of the other providers cannot be seen or hit.`,
    );
    await shot(page, `${label}-others`);

    // A provider, a model and an effort, chosen with the pointer; the closed row shows them.
    const { providers, models } = sectionControls(page, locale);
    await providers.filter({ hasText: TEXT[locale].claude }).click();
    await models.filter({ hasText: TEXT[locale].opus }).click();
    // The segment is what the pointer presses; its radio input is drawn by it.
    const efforts = page.getByRole("radiogroup", { name: TEXT[locale].efforts });
    await efforts.getByText(TEXT[locale].effort, { exact: true }).click();
    await page.waitForFunction(
      (input) => input instanceof HTMLInputElement && input.checked,
      await efforts.getByRole("radio", { name: TEXT[locale].effort, exact: true }).elementHandle(),
    );
    await shot(page, `${label}-chosen`);
    await trigger.click();
    await waitExpanded(page, trigger, false);
    const row = await trigger.innerText();
    assert.match(
      row,
      new RegExp(TEXT[locale].opus.replace(".", "\\.")),
      `${label}: the closed row does not show the model.`,
    );
    assert.match(row, new RegExp(TEXT[locale].effort), `${label}: the closed row does not show the effort.`);
    assert.ok(
      (await trigger.getAttribute("aria-label"))?.endsWith(`: ${TEXT[locale].opus} · ${TEXT[locale].effort}`),
      `${label}: the name of the row is not the model and the effort.`,
    );
    await shot(page, `${label}-closed-after-choice`);

    // The keyboard: the row opens with Enter, Tab goes into the section and ArrowRight chooses the
    // next provider. Escape on a model or on an effort closes only the section, and the focus goes
    // back to the row; the dialog stays open. Escape on the row then closes the dialog.
    await trigger.focus();
    await page.keyboard.press("Enter");
    await waitExpanded(page, trigger, true);
    await page.keyboard.press("Tab");
    const first = await focused(page);
    assert.equal(first.role, "tab", `${label}: Tab after the row does not go to the providers.`);
    await page.keyboard.press("ArrowRight");
    const next = await focused(page);
    assert.ok(
      next.role === "tab" && next.name !== first.name && next.selected === "true",
      `${label}: ArrowRight does not choose the next provider: ${JSON.stringify({ first, next })}.`,
    );
    for (const [stops, role] of [
      [1, "option"],
      [3, "radio"],
    ] as const) {
      if ((await trigger.getAttribute("aria-expanded")) !== "true") {
        await page.keyboard.press("Enter");
        await waitExpanded(page, trigger, true);
      }
      for (let stop = 0; stop < stops; stop += 1) await page.keyboard.press("Tab");
      assert.equal((await focused(page)).role, role, `${label}: Tab does not go to the ${role} of the section.`);
      await page.keyboard.press("Escape");
      // The section closes, or the dialog with it.
      await page.waitForFunction(() => !document.querySelector("[role=dialog]")?.querySelector("[aria-expanded=true]"));
      await nextFrames(page);
      assert.equal(await dialog.isVisible(), true, `${label}: Escape on the ${role} closed the dialog.`);
      assert.equal(
        await trigger.evaluate((button) => document.activeElement === button),
        true,
        `${label}: Escape on the ${role} did not give the focus back to the row.`,
      );
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {
      throw new Error(`${label}: Escape on the closed row did not close the dialog.`);
    });
  } finally {
    await context.close();
  }
}

/** Makes the provider check of the `providers-answer-after-open` story answer. */
async function answerProviders(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("openbot-story:answer-providers")));
}

/**
 * The provider check answers after the section opened. While it checks, the section shows the
 * agent's provider only, with its state. The answer brings the cards, and the form scrolls so the
 * whole section shows.
 */
async function runLateAnswer(browser: Browser, size: WindowCase, locale: Locale, scheme: Scheme) {
  const label = `late-${size.name}-${locale}-${scheme}`;
  const { context, page } = await newWindow(browser, size, locale, scheme);
  try {
    const { trigger } = await openDialog(
      page,
      storyUrl("channels-member-dialog--providers-answer-after-open", locale, scheme),
      locale,
    );
    await trigger.click();
    await waitExpanded(page, trigger, true);
    const { providers } = sectionControls(page, locale);
    await providers.first().waitFor();
    await nextFrames(page);
    await shot(page, `${label}-checking`);
    assert.deepEqual(
      await providers.evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label"))),
      [TEXT[locale].checking],
      `${label}: while the check runs, the section does not show the agent's provider alone.`,
    );
    const checking = await sectionHeight(trigger);
    await answerProviders(page);
    await waitSectionTaller(page, trigger, checking);
    await checkSection(page, trigger, locale, label);
    await shot(page, `${label}-answered`);
  } finally {
    await context.close();
  }
}

/**
 * The provider check answers while the person is in the instructions, under the section. The
 * section grows out of sight, and the form stays where the person is.
 */
async function runLateAnswerAway(browser: Browser, size: WindowCase, locale: Locale, scheme: Scheme) {
  const label = `late-away-${size.name}-${locale}-${scheme}`;
  const { context, page } = await newWindow(browser, size, locale, scheme);
  try {
    const { dialog, trigger } = await openDialog(
      page,
      storyUrl("channels-member-dialog--providers-answer-after-open", locale, scheme),
      locale,
    );
    await trigger.click();
    await waitExpanded(page, trigger, true);
    await sectionControls(page, locale).providers.first().waitFor();
    await nextFrames(page);
    await trigger.evaluate((button) => {
      const form = button.closest("form");
      if (form) form.scrollTop = form.scrollHeight;
    });
    await nextFrames(page);
    const away = await trigger.evaluate((button) => {
      const form = button.closest("form");
      return Boolean(form && button.getBoundingClientRect().bottom <= form.getBoundingClientRect().top);
    });
    assert.ok(away, `${label}: the form is too short to scroll the row out of sight; choose a shorter window.`);
    const instructions = dialog.getByRole("textbox", { name: TEXT[locale].instructions });
    const before = (await instructions.boundingBox())?.y;
    const checking = await sectionHeight(trigger);
    await answerProviders(page);
    await waitSectionTaller(page, trigger, checking);
    await sectionControls(page, locale).models.first().waitFor({ timeout: 30_000 });
    await nextFrames(page);
    const after = (await instructions.boundingBox())?.y;
    await shot(page, `${label}-answered`);
    assert.ok(
      before !== undefined && after !== undefined && Math.abs(after - before) <= 1,
      `${label}: the form moved from the instructions (${before}px) to ${after}px when the section grew.`,
    );
  } finally {
    await context.close();
  }
}

const CHECK_DONE = "agent-model-picker-e2e:check-done";

/**
 * A provider with a long list, in the dialog with a name: the section shows the search. Enter in
 * the search chooses the first model found and does not send the form with the model from before.
 */
async function runSearchEnter(browser: Browser, size: WindowCase, locale: Locale, scheme: Scheme) {
  const label = `search-enter-${size.name}-${locale}-${scheme}`;
  const { context, page } = await newWindow(browser, size, locale, scheme);
  try {
    const { dialog, trigger } = await openDialog(
      page,
      storyUrl("channels-member-dialog--many-models", locale, scheme),
      locale,
    );
    // True when the form is sent before the script says that its check is done.
    const sent = trigger.evaluate(
      (button, done) =>
        new Promise<boolean>((answer) => {
          button.closest("form")?.addEventListener("submit", () => answer(true), { once: true });
          window.addEventListener(done, () => answer(false), { once: true });
        }),
      CHECK_DONE,
    );
    // A name: Create can send the form.
    await dialog.getByRole("textbox", { name: TEXT[locale].name }).fill("Research");
    const before = await trigger.getAttribute("aria-label");
    await trigger.click();
    await waitExpanded(page, trigger, true);
    const { providers, models } = sectionControls(page, locale);
    await providers.first().waitFor();
    await page.getByRole("tab", { name: TEXT[locale].openRouter }).click();
    const search = page.getByRole("textbox", { name: TEXT[locale].search });
    await search.click();
    await page.keyboard.type("model 3");
    await models.first().waitFor();
    const row = await trigger.elementHandle();
    await page.keyboard.press("Enter");
    // The form is sent, or the row names another model.
    const chosen = page
      .waitForFunction(
        ([button, previous]) => button?.getAttribute("aria-label") !== previous,
        [row, before] as const,
        {
          timeout: 10_000,
        },
      )
      .then(() => "chosen" as const)
      .catch(() => "nothing" as const);
    const outcome = await Promise.race([
      sent.then((value) => (value ? ("sent" as const) : ("nothing" as const))),
      chosen,
    ]);
    await nextFrames(page);
    await shot(page, `${label}-chosen`);
    assert.notEqual(outcome, "sent", `${label}: Enter in the search sent the form.`);
    assert.equal(outcome, "chosen", `${label}: Enter in the search did not choose a model.`);
    await page.evaluate((done) => window.dispatchEvent(new Event(done)), CHECK_DONE);
    assert.equal(await sent, false, `${label}: Enter in the search sent the form.`);
    assert.equal(await dialog.isVisible(), true, `${label}: Enter in the search closed the dialog.`);
    assert.match(
      (await trigger.getAttribute("aria-label")) ?? "",
      /: [A-Za-z]+: Model 3 · /u,
      `${label}: the row does not show the model that the search found.`,
    );
    assert.equal(
      await models.first().getAttribute("aria-selected"),
      "true",
      `${label}: the first model that the search found is not the chosen one.`,
    );
  } finally {
    await context.close();
  }
}

/**
 * Connect on a row of Other providers signs in, and the provider moves up to the ready ones. The
 * focus that was on Connect goes to the new tab of the provider, not to the page.
 */
async function runConnectFocus(browser: Browser, size: WindowCase, locale: Locale, scheme: Scheme) {
  const label = `connect-focus-${size.name}-${locale}-${scheme}`;
  const { context, page } = await newWindow(browser, size, locale, scheme);
  try {
    const { dialog, trigger } = await openDialog(
      page,
      storyUrl("channels-member-dialog--new-agent", locale, scheme),
      locale,
    );
    await trigger.click();
    await waitExpanded(page, trigger, true);
    await dialog.getByRole("button", { name: TEXT[locale].others }).click();
    const connect = dialog.getByRole("button", { name: TEXT[locale].connectGrok });
    await connect.focus();
    await page.keyboard.press("Enter");
    const tab = page
      .getByRole("tablist", { name: TEXT[locale].providers })
      .getByRole("tab", { name: TEXT[locale].grok });
    await tab.waitFor({ timeout: 10_000 });
    await page
      .waitForFunction((element) => document.activeElement === element, await tab.elementHandle(), {
        timeout: 10_000,
      })
      .catch(async () => {
        throw new Error(`${label}: the focus did not go to the new tab: ${JSON.stringify(await focused(page))}.`);
      });
    await shot(page, `${label}-ready`);
  } finally {
    await context.close();
  }
}

/** An agent to edit: the row and the section show its model and effort, chosen. */
async function runEditAgent(browser: Browser, size: WindowCase, locale: Locale, scheme: Scheme) {
  const label = `edit-${size.name}-${locale}-${scheme}`;
  const { context, page } = await newWindow(browser, size, locale, scheme);
  try {
    const { trigger } = await openDialog(page, storyUrl("channels-member-dialog--edit-agent", locale, scheme), locale);
    assert.ok(
      (await trigger.getAttribute("aria-label"))?.endsWith(`: ${TEXT[locale].sonnet} · ${TEXT[locale].high}`),
      `${label}: the row does not show the model and the effort of the agent.`,
    );
    await trigger.click();
    await waitExpanded(page, trigger, true);
    await sectionControls(page, locale).models.first().waitFor({ timeout: 30_000 });
    assert.equal(
      await page.getByRole("option", { name: TEXT[locale].sonnet, exact: true }).getAttribute("aria-selected"),
      "true",
      `${label}: the model of the agent is not chosen in the section.`,
    );
    assert.equal(
      await page.getByRole("radio", { name: TEXT[locale].high, exact: true }).isChecked(),
      true,
      `${label}: the effort of the agent is not chosen in the section.`,
    );
    await checkSection(page, trigger, locale, label);
    await shot(page, `${label}-open`);
  } finally {
    await context.close();
  }
}

/**
 * An agent whose model its provider no longer lists: the section shows that model, chosen, with a
 * note, on the tab of its provider. No model of the list is shown as the agent's.
 */
async function runEditNotListed(browser: Browser, size: WindowCase, locale: Locale, scheme: Scheme) {
  const label = `edit-not-listed-${size.name}-${locale}-${scheme}`;
  const { context, page } = await newWindow(browser, size, locale, scheme);
  try {
    const { trigger } = await openDialog(
      page,
      storyUrl("channels-member-dialog--edit-agent-model-not-listed", locale, scheme),
      locale,
    );
    await trigger.click();
    await waitExpanded(page, trigger, true);
    await sectionControls(page, locale).models.first().waitFor({ timeout: 30_000 });
    await nextFrames(page);
    await shot(page, `${label}-open`);
    assert.match(
      (await page.getByRole("tab", { selected: true }).getAttribute("aria-label")) ?? "",
      TEXT[locale].claude,
      `${label}: the section does not open on the tab of the agent's provider.`,
    );
    const panel = page.getByRole("tabpanel");
    const note = panel.getByText(TEXT[locale].notListed, { exact: true });
    assert.equal(await note.isVisible(), true, `${label}: the section does not say that the model is not listed.`);
    assert.equal(
      await panel.getByText("claude-sonnet-4-5", { exact: true }).isVisible(),
      true,
      `${label}: the section does not name the model of the agent.`,
    );
    assert.equal(
      await page.getByRole("option", { selected: true }).count(),
      0,
      `${label}: a model of the list shows as the agent's model.`,
    );
  } finally {
    await context.close();
  }
}

/** The section alone, in each of its stories: what it shows, and that each part can be seen and hit. */
const PICKER_STORIES = [
  { id: "inline-closed", open: false },
  { id: "inline-open", open: true },
  { id: "inline-checking", open: true },
  { id: "inline-provider-not-downloaded", open: true },
  { id: "inline-many-models", open: true },
  { id: "inline-narrow", open: true },
] as const;

async function runPickerStory(
  browser: Browser,
  story: (typeof PICKER_STORIES)[number],
  locale: Locale,
  scheme: Scheme,
): Promise<void> {
  const label = `story-${story.id}-${locale}-${scheme}`;
  const context = await browser.newContext({
    viewport: { width: 640, height: 900 },
    locale: locale === "pt" ? "pt-BR" : "en-US",
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await page.goto(storyUrl(`conversation-providermodelpicker--${story.id}`, locale, scheme), {
      waitUntil: "domcontentloaded",
      timeout: 300_000,
    });
    const trigger = page.getByRole("button", { name: /^Agent model: / });
    await trigger.waitFor({ timeout: 120_000 });
    assert.equal(await trigger.getAttribute("aria-expanded"), story.open ? "true" : "false", `${label}: open state.`);
    const box = page.locator(".channel-member-runtime");
    if (story.open) {
      const { providers, models } = sectionControls(page, locale);
      await providers.first().waitFor();
      const others = page.getByRole("button", { name: TEXT[locale].others });
      if (await others.count()) await others.click();
      assert.deepEqual(
        [
          ...(await hiddenParts(providers)),
          ...(await hiddenParts(models)),
          ...(await hiddenParts(page.getByRole("radiogroup").getByRole("radio"))),
          ...(await hiddenParts(others)),
          ...(await hiddenParts(page.getByRole("searchbox").or(page.getByRole("textbox")))),
        ],
        [],
        `${label}: a part of the section cannot be seen or hit.`,
      );
      if (story.id === "inline-many-models") {
        assert.equal(await page.getByRole("textbox").count(), 1, `${label}: a long list has no search.`);
      } else {
        assert.equal(await page.getByRole("textbox").count(), 0, `${label}: a short list shows a search.`);
      }
      if (story.id === "inline-provider-not-downloaded") {
        // The panel of the agent's provider and its row of Other providers say the same thing.
        const panel = (await page.getByRole("tabpanel").innerText()).replace(/\s+/gu, " ");
        assert.ok(panel.includes(TEXT[locale].notDownloaded), `${label}: the panel does not say "not downloaded".`);
        assert.ok(!panel.includes(TEXT[locale].notInstalled), `${label}: the panel says "not installed".`);
        assert.ok(panel.includes(TEXT[locale].downloadCline), `${label}: the panel does not say to download Cline.`);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    const path = resolve(OUT, `${label}.png`);
    await box.screenshot({ path, animations: "disabled" });
    screenshots.push(path);
  } finally {
    await context.close();
  }
}

/**
 * The other places that use the picker, which keep its popover: the composer, the agent settings,
 * the first agent of the setup. Each opens in the real app, and its panel shows in full there, with
 * at least one model.
 */
const CONSUMERS: { name: string; open: (page: Page) => Promise<Locator> }[] = [
  // The model pill of the composer header.
  { name: "composer-pill", open: async (page) => page.locator(".provider-model-trigger").first() },
  // The agent settings, from the header of the conversation.
  {
    name: "agent-settings",
    open: async (page) => {
      await page.getByRole("button", { name: "View agent settings" }).first().click();
      return page.locator(".agent-settings-runtime-rows .provider-model-trigger").first();
    },
  },
  // A new agent, from the sidebar: the setup of an agent.
  {
    name: "agent-setup",
    open: async (page) => {
      await page
        .getByRole("button", { name: /^New agent/u })
        .first()
        .click();
      await page.getByRole("menuitem", { name: "New agent" }).click();
      return page.locator(".provider-model-trigger-field").first();
    },
  },
];

async function runConsumer(browser: Browser, consumer: (typeof CONSUMERS)[number], size: WindowCase): Promise<void> {
  const label = `consumer-${consumer.name}-${size.name}`;
  const { context, page } = await newWindow(browser, size, "en", "dark");
  try {
    await page.goto(storyUrl("app--playground", "en", "dark"), { waitUntil: "domcontentloaded", timeout: 300_000 });
    await page.locator(".provider-model-trigger").first().waitFor({ timeout: 240_000 });
    const trigger = await consumer.open(page);
    await trigger.waitFor({ timeout: 30_000 });
    await trigger.scrollIntoViewIfNeeded();
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    const panel = page.locator(".provider-model-popover");
    await panel.getByRole("tab").first().waitFor({ timeout: 30_000 });
    await nextFrames(page);
    await shot(page, label);
    const options = panel.getByRole("option");
    assert.ok((await options.count()) >= 1, `${label}: the picker shows no model.`);
    // The popover is placed against its row: scrolling the page under it would test a stale place.
    assert.deepEqual(
      [...(await hiddenParts(panel.getByRole("tab"), false)), ...(await hiddenParts(options, false))],
      [],
      `${label}: a part of the picker cannot be seen or hit.`,
    );
  } finally {
    await context.close();
  }
}

async function record(name: string, run: () => Promise<void>): Promise<void> {
  if (only && !only.some((part) => name.includes(part))) return;
  try {
    await run();
    results.push({ name, ok: true, detail: "" });
    logger.info("Case passed.", { name });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    logger.warn("Case failed.", { name, detail });
    if (!keepGoing) throw error;
  }
}

const browser: Browser = await chromium.launch({ headless: true });
try {
  for (const size of WINDOWS) {
    await record(`${size.name}-en-dark`, () => runCase(browser, size, "en", "dark", true));
  }
  const report = WINDOWS[1];
  const short = WINDOWS[4];
  assert.ok(report && short);
  await record("pt-light", () => runCase(browser, report, "pt", "light", true));
  await record("pt-dark", () => runCase(browser, report, "pt", "dark", false));
  await record("en-light", () => runCase(browser, report, "en", "light", false));
  for (const size of [report, short]) {
    await record(`late-${size.name}`, () => runLateAnswer(browser, size, "en", "dark"));
  }
  await record(`late-away-${short.name}`, () => runLateAnswerAway(browser, short, "pt", "dark"));
  await record(`search-enter-${report.name}-pt`, () => runSearchEnter(browser, report, "pt", "dark"));
  await record(`search-enter-${short.name}-en`, () => runSearchEnter(browser, short, "en", "light"));
  await record(`connect-focus-${report.name}`, () => runConnectFocus(browser, report, "en", "dark"));
  await record(`edit-${report.name}-pt`, () => runEditAgent(browser, report, "pt", "dark"));
  await record(`edit-${short.name}-en`, () => runEditAgent(browser, short, "en", "light"));
  await record(`edit-not-listed-${report.name}`, () => runEditNotListed(browser, report, "pt", "light"));
  for (const story of PICKER_STORIES) {
    for (const [locale, scheme] of [
      ["en", "dark"],
      ["pt", "light"],
      ["en", "light"],
      ["pt", "dark"],
    ] as const) {
      await record(`story-${story.id}-${locale}-${scheme}`, () => runPickerStory(browser, story, locale, scheme));
    }
  }
  const wide: WindowCase = { name: "1440x900-100", width: 1440, height: 900, zoom: 1 };
  for (const consumer of CONSUMERS) {
    for (const size of [wide, report]) {
      await record(`consumer-${consumer.name}-${size.name}`, () => runConsumer(browser, consumer, size));
    }
  }
} finally {
  await browser.close();
  writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify({ storybook, results, screenshots }, null, 2)}\n`);
}

const failed = results.filter((result) => !result.ok);
assert.deepEqual(failed, [], `${failed.length} of ${results.length} cases failed.`);
logger.info("Agent model picker E2E passed.", { cases: results.length, report: resolve(OUT, "report.json") });
