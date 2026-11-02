// Checks the actions on the cards of the feed page in the stories, with the real components, the real
// store and the preview mock of `feed.act` (each action takes 0.6 s), in a headless browser (Edge or
// Chromium). It checks that:
// - "Approve" on a command changes the card at once ("Approving…"), and main's change keeps it;
// - a question of the Guard shows its reason and waits for a second step: "A" only opens the
//   confirmation, Escape closes it, and the confirmation approves;
// - more access shows "High risk" and what it asks for, with no path;
// - a card that main refuses goes back as it was, with the reason on the card and in the live region;
// - a question takes a choice, and another a typed answer; two questions open the conversation;
// - a card of a joined server offers no action;
// - "Stop" asks first; J and K move between the cards; "N" only opens the confirmation of a denial;
// - "R" resumes a stopped task; a selection of stopped tasks goes to one agent at once;
// - in the whole app of the preview, a card of the Feed page approves;
// - the light and the dark palette render, axe-core finds no violation, and no error halts the page.
// Pass the URL that `bun run storybook` reports:
//
//   bun scripts/feed-actions-ui-e2e.ts --storybook=http://localhost:6006 [--browser-executable=<path>] [--prints=<folder>]
//
// Writes .openbot-build/feed-actions-ui-e2e/report.json and screenshots; `--prints` copies the screenshots there.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";

declare global {
  interface Window {
    /** axe-core, added to the page by the accessibility check (the same type as `feed-ui-e2e.ts`). */
    axe?: { run: () => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> };
  }
}

const OUT = resolve(import.meta.dirname, "../.openbot-build/feed-actions-ui-e2e");
const AXE = resolve(import.meta.dirname, "../node_modules/axe-core/axe.min.js");
const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const storybook = argument("storybook")?.replace(/\/$/, "");
assert.ok(storybook, "Pass --storybook=<url> with the URL that `bun run storybook` reports.");
const browserExecutable = argument("browser-executable");
const prints = argument("prints");

const report: {
  storybook: string;
  browser: string;
  accessibility: Record<string, string[]>;
  steps: string[];
  screenshots: string[];
  errors: string[];
  failures: string[];
  passed: boolean;
} = {
  storybook,
  browser: browserExecutable ?? "chromium",
  accessibility: {},
  steps: [],
  screenshots: [],
  errors: [],
  failures: [],
  passed: false,
};

function storyUrl(id: string, locale: "en" | "pt", scheme: "dark" | "light"): string {
  const story = id.includes("--") ? id : `features-feed--${id}`;
  return `${storybook}/iframe.html?id=${story}&viewMode=story&globals=locale:${locale};colorScheme:${scheme}`;
}

async function open(browser: Browser, id: string, locale: "en" | "pt", scheme: "dark" | "light") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 }, reducedMotion: "reduce" });
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

async function accessibility(page: Page, name: string): Promise<void> {
  await page.addScriptTag({ path: AXE });
  // The accessibility addon of Storybook can run axe on the story at the same time: wait for it.
  const violations = await page.evaluate(async () => {
    if (!document.querySelector(".feed-page") || !window.axe) return ["no feed page or no axe"];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await window.axe.run();
        return result.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(" ") ?? ""}`);
      } catch (error) {
        if (attempt >= 20 || !String(error).includes("already running")) throw error;
        await new Promise((done) => setTimeout(done, 250));
      }
    }
  });
  report.accessibility[name] = violations;
  assert.deepEqual(violations, [], `${name}: axe found accessibility violations.`);
}

/** The card whose title is this text. */
const cardOf = (page: Page, title: string): Locator =>
  page.locator(".feed-card").filter({ has: page.locator(".feed-card-title", { hasText: title }) });

const liveRegion = (page: Page) => page.locator(".feed-page-main [role='status'][aria-live='polite']");

/** Focuses a card itself, not a button in it, as a keyboard user who moved to it does. */
async function focusCard(card: Locator): Promise<void> {
  await card.evaluate((element: HTMLElement) => element.focus());
}

async function focusedTitle(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.closest(".feed-card")?.querySelector(".feed-card-title")?.textContent ?? null,
  );
}

/** Every action of the actions story, in Portuguese and dark. */
async function checkActions(browser: Browser): Promise<void> {
  const { context, page } = await open(browser, "actions", "pt", "dark");
  try {
    await page.locator(".feed-card").first().waitFor({ timeout: 240_000 });
    await shot(page, "feed-acoes-escuro");
    await accessibility(page, "actions-dark");

    // A command: the card changes at once, then main's change keeps it.
    const command = cardOf(page, "Roteiro do episódio de terça");
    await command.getByRole("button", { name: "Aprovar", exact: true }).click();
    await command.getByText("Aprovando…").waitFor({ timeout: 2_000 });
    assert.equal(await command.locator(".feed-card-need").count(), 0, "The approval leaves the card at once.");
    await command.getByText("Aprovando…").waitFor({ state: "detached", timeout: 10_000 });
    assert.equal(await command.getAttribute("data-state"), "working", "Main's change keeps the card working.");
    assert.equal(await command.getByRole("button", { name: "Aprovar", exact: true }).count(), 0);
    await liveRegion(page).getByText("Feito em Roteiro do episódio de terça").waitFor({ timeout: 5_000 });
    report.steps.push("approve: the card changes at once, the live region says it is done");

    // A question of the Guard: the reason shows, "A" only opens the second step.
    const guard = cardOf(page, "Revisão do Worker de login");
    await guard.getByText("Risco alto").waitFor();
    await guard.locator(".feed-card-reason").waitFor();
    await focusCard(guard);
    await page.keyboard.press("a");
    const confirm = guard.getByRole("button", { name: "Confirmar aprovação" });
    await confirm.waitFor({ timeout: 2_000 });
    await page.waitForFunction(() => document.activeElement?.textContent?.includes("Confirmar aprovação") ?? false);
    await page.keyboard.press("a");
    await page.waitForTimeout(800);
    assert.equal(await guard.getAttribute("data-state"), "needs-you", "A second A does not approve.");
    assert.equal(await guard.getAttribute("data-pending"), null, "Nothing runs before the confirmation.");
    await shot(page, "feed-acoes-confirmacao-guard");
    await accessibility(page, "actions-guard-confirmation");
    await page.keyboard.press("Escape");
    await confirm.waitFor({ state: "detached", timeout: 2_000 });
    assert.equal(await focusedTitle(page), "Revisão do Worker de login", "Escape gives the focus back to the card.");
    await guard.getByRole("button", { name: "Aprovar", exact: true }).click();
    await guard.getByRole("button", { name: "Confirmar aprovação" }).click();
    await guard.getByText("Aprovando…").waitFor({ timeout: 2_000 });
    await guard.getByText("Aprovando…").waitFor({ state: "detached", timeout: 10_000 });
    assert.equal(await guard.getAttribute("data-state"), "working");
    report.steps.push("Guard: reason shown, A opens the confirmation only, Escape closes it, confirm approves");

    // More access: high risk and what it asks for, with no path.
    const access = cardOf(page, "Citações da marca");
    await access.getByText("Risco alto").waitFor();
    await access.getByText("Rede", { exact: true }).waitFor();
    await access.getByText("Gravar 1 pasta").waitFor();
    report.steps.push("more access: high risk, network, one folder to write");

    // A card that main refuses: back as it was, with the reason.
    const refused = cardOf(page, "Publicar o especial");
    await refused.getByRole("button", { name: "Aprovar", exact: true }).click();
    await refused.getByText("Aprovando…").waitFor({ timeout: 2_000 });
    await refused.getByText("O cartão mudou. Nada foi feito.").waitFor({ timeout: 10_000 });
    assert.equal(await refused.getAttribute("data-state"), "needs-you", "The refused card is as it was.");
    await refused.getByRole("button", { name: "Aprovar", exact: true }).waitFor();
    await liveRegion(page).getByText("Não feito em Publicar o especial").waitFor({ timeout: 5_000 });
    await shot(page, "feed-acoes-recusada");
    report.steps.push("refused: the card goes back, the notice and the live region say why");

    // A question with choices, and one with a typed answer.
    const choice = cardOf(page, "Thumbnail em inglês do especial");
    await choice.getByRole("button", { name: /Vermelha/u }).click();
    await choice.getByText("Enviando a resposta…").waitFor({ timeout: 2_000 });
    await choice.getByText("Enviando a resposta…").waitFor({ state: "detached", timeout: 10_000 });
    assert.equal(await choice.getAttribute("data-state"), "working");
    const typed = cardOf(page, "Roteiro do especial");
    await typed.getByRole("textbox", { name: "Sua resposta" }).fill("Feed de ações");
    await typed.getByRole("textbox", { name: "Sua resposta" }).press("Enter");
    await typed.getByText("Enviando a resposta…").waitFor({ timeout: 2_000 });
    await typed.getByText("Enviando a resposta…").waitFor({ state: "detached", timeout: 10_000 });
    assert.equal(await typed.getAttribute("data-state"), "working");
    report.steps.push("questions: a choice and a typed answer");

    // Two questions and a joined server: no action on the card.
    const two = cardOf(page, "Pesquisa de concorrentes");
    await two.getByText("Abra a conversa para responder.").waitFor();
    assert.equal(await two.locator(".feed-card-answer").count(), 0, "Two questions open the conversation.");
    const remote = cardOf(page, "Atendimento do Hub");
    assert.equal(await remote.locator(".feed-card-actions").count(), 0, "A joined server's card offers no action.");
    await remote.getByRole("button", { name: "Abrir conversa" }).waitFor();
    report.steps.push("two questions and a joined server: open only");

    // Stop asks first.
    const running = cardOf(page, "Página de preços nova").filter({ hasText: "Trabalhando" });
    await running.getByRole("button", { name: "Parar" }).click();
    await running.getByRole("button", { name: "Confirmar parada" }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".feed-card")].some(
        (card) =>
          card.querySelector(".feed-card-title")?.textContent === "Página de preços nova" &&
          card.getAttribute("data-state") === "stopped",
      ),
    );
    report.steps.push("stop: a second step, then the run stops");

    // J and K move between the cards; N only opens the confirmation of a denial.
    const deny = cardOf(page, "Publicar o especial");
    await focusCard(deny);
    const at = await deny.getAttribute("aria-posinset");
    await page.keyboard.press("k");
    await page.waitForFunction(
      (position) => Number(document.activeElement?.getAttribute("aria-posinset")) === Number(position) - 1,
      at,
    );
    await page.keyboard.press("j");
    await page.waitForFunction((position) => document.activeElement?.getAttribute("aria-posinset") === position, at);
    await page.keyboard.press("n");
    await deny.getByRole("button", { name: "Confirmar negação" }).waitFor({ timeout: 2_000 });
    await page.waitForTimeout(800);
    assert.equal(await deny.getAttribute("data-state"), "needs-you", "N does not deny by itself.");
    await page.keyboard.press("Escape");
    report.steps.push("J and K move; N opens the confirmation of a denial");

    // R resumes a stopped task; the others go to one agent at once.
    const first = cardOf(page, "ops · Deploy do Hub");
    await focusCard(first);
    await page.keyboard.press("r");
    await first.waitFor({ state: "detached", timeout: 10_000 });
    report.steps.push("R resumes a stopped task");
    await page.getByRole("button", { name: "Selecionar 2 paradas" }).click();
    await page.getByText("2 selecionadas").waitFor();
    const bar = page.locator(".feed-bulk");
    await bar.getByRole("combobox", { name: "Passar a tarefa para" }).selectOption({ label: "Validador iMasters" });
    await shot(page, "feed-acoes-selecao");
    await accessibility(page, "actions-selection");
    await bar.getByRole("button", { name: "Passar para" }).click();
    await liveRegion(page).getByText("2 feitas, 0 não feitas").waitFor({ timeout: 10_000 });
    assert.equal(await page.locator(".feed-card[data-state='stopped'] .feed-card-select").count(), 0);
    report.steps.push("a selection of two stopped tasks goes to one agent");
  } finally {
    await context.close();
  }
}

async function checkLight(browser: Browser): Promise<void> {
  const { context, page } = await open(browser, "actions-light", "en", "light");
  try {
    await page.locator(".feed-card").first().waitFor({ timeout: 240_000 });
    const guard = cardOf(page, "Revisão do Worker de login");
    await guard.getByRole("button", { name: "Approve", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm approval" }).waitFor();
    await shot(page, "feed-acoes-claro");
    await accessibility(page, "actions-light");
    report.steps.push("light palette, English");
  } finally {
    await context.close();
  }
}

/** The whole app of the preview: the Feed page approves a card, as the main window would. */
async function checkInApp(browser: Browser): Promise<void> {
  const { context, page } = await open(browser, "app--playground", "pt", "dark");
  try {
    const rail = page.getByRole("navigation", { name: "Páginas" });
    await rail.getByRole("button", { name: "Feed", exact: true }).click({ timeout: 240_000 });
    const card = page.locator(".feed-card").filter({ has: page.getByRole("button", { name: "Aprovar", exact: true }) });
    await card.first().waitFor({ timeout: 30_000 });
    const target = page.locator(`[data-feed-id="${await card.first().getAttribute("data-feed-id")}"]`);
    const id = await target.getAttribute("data-feed-id");
    await target.getByRole("button", { name: "Aprovar", exact: true }).click();
    // The approval of this preview is a question of the Guard: it asks for the second step.
    const confirm = target.getByRole("button", { name: "Confirmar aprovação" });
    if (await target.locator(".feed-chip-risk").count()) await confirm.click();
    await page.waitForFunction(
      (feedId) => document.querySelector(`[data-feed-id="${feedId}"]`)?.getAttribute("data-state") === "working",
      id,
      { timeout: 10_000 },
    );
    await shot(page, "feed-acoes-app");
    report.steps.push("in the app: the Feed page approves a card");
  } finally {
    await context.close();
  }
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  browserExecutable ? { executablePath: resolve(browserExecutable), headless: true } : { headless: true },
);
try {
  for (const check of [checkActions, checkLight, checkInApp]) {
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
  /REACTIVITY_HALTED|PRIMITIVE_IN_EFFECT|STRICT_READ|not a valid selector/u.test(error),
);
if (halted.length > 0) report.failures.push(`An error halted the page: ${halted[0]}`);
report.passed = report.failures.length === 0;
if (prints) {
  mkdirSync(prints, { recursive: true });
  for (const path of report.screenshots) copyFileSync(path, join(prints, path.split("/").at(-1) ?? "feed.png"));
}
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.deepEqual(report.failures, [], "The feed actions UI check found failures.");
