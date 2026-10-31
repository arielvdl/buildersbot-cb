// Drives the WhatsApp accounts service of main against the real pinned wazap CLI, in a temporary
// data folder, and checks the pure parts it relies on: account ids from nicknames, E.164 by country,
// the CLI argument lists (with injection attempts), the readers of wazap's output (fixtures and real
// output), the state of each row, the link refusals and the masking of numbers.
//
// It never runs `login`, `logout` or `link_account`, never asks WhatsApp for a code, and never reads
// or writes `~/.wazap`: every command gets `--data-dir=<temporary folder>`. Only commands that do not
// contact WhatsApp run: `status`, `account add|list|enable|disable|default|remove`, `config writes`.
//
// It needs `npx` and, on a cold cache, the network to fetch the pinned package.
// `bun scripts/whatsapp-accounts-e2e.ts`. Writes .openbot-build/whatsapp-accounts-e2e/report.json.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  maskWhatsAppNumber,
  normalizeWhatsAppPhone,
  WAZAP_PACKAGE,
  type WhatsAppAccountsSnapshot,
  whatsAppAccountSlug,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createBuildersBotLogger } from "@openbot/logging";
import QRCode from "qrcode";
import {
  accountState,
  linkRefusal,
  parseQrDrawing,
  parseWazapAccountList,
  parseWazapAdd,
  parseWazapLogin,
  parseWazapStatus,
  redactWazapText,
  WAZAP_NPX_ARGS,
  WazapArgumentError,
  type WazapStatusAccount,
  wazapArgs,
  wazapErrorCode,
  wazapNotice,
} from "../src/main/wazap-cli";
import { createWhatsAppAccounts } from "../src/main/whatsapp-accounts";

const OUT = resolve(import.meta.dirname, "../.openbot-build/whatsapp-accounts-e2e");
const PLUGIN = resolve(import.meta.dirname, "../marketplace/plugin-catalog/plugins/whatsapp/plugin.json");
const logger = createBuildersBotLogger("whatsapp-accounts-e2e");

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail?: string) {
  checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
}

function same(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function throwsArgumentError(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof WazapArgumentError;
  }
}

/** The half-block drawing of `qrcode-terminal` (small mode), from the same modules. */
function drawSmall(size: number, dark: (row: number, column: number) => boolean): string[] {
  const rows: boolean[][] = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => dark(row, column)),
  );
  const odd = size % 2 === 1;
  if (odd) rows.push(Array.from({ length: size }, () => false));
  const lines = ["▄".repeat(size + 2)];
  for (let row = 0; row < size; row += 2) {
    let line = "█";
    for (let column = 0; column < size; column++) {
      const top = rows[row]?.[column] ?? false;
      const bottom = rows[row + 1]?.[column] ?? false;
      line += !top && !bottom ? "█" : !top && bottom ? "▀" : top && !bottom ? "▄" : " ";
    }
    lines.push(`${line}█`);
  }
  if (!odd) lines.push("▀".repeat(size + 2));
  return lines;
}

/** The `args` of the listing's one app. */
function listingArgs(listing: unknown): string[] | null {
  if (!isDynamicRecord(listing) || !Array.isArray(listing.apps)) return null;
  const app = listing.apps[0];
  if (!isDynamicRecord(app) || !isDynamicRecord(app.server) || !Array.isArray(app.server.args)) return null;
  return app.server.args.filter((arg): arg is string => typeof arg === "string");
}

function pureChecks() {
  // The pinned version: main and the listing must run the same wazap.
  return readFile(PLUGIN, "utf8").then((text) => {
    same("listing and main pin the same wazap", listingArgs(JSON.parse(text)), [...WAZAP_NPX_ARGS]);
    same("the pinned package", WAZAP_NPX_ARGS, ["-y", WAZAP_PACKAGE]);

    // Account ids from nicknames.
    same("slug: words", whatsAppAccountSlug("WhatsApp do Ariel"), "whatsapp-do-ariel");
    same("slug: accents", whatsAppAccountSlug("Sofia Conceição"), "sofia-conceicao");
    same("slug: unicode only", whatsAppAccountSlug("😀 ☎️"), "account");
    same("slug: leading dashes", whatsAppAccountSlug("--yes; rm -rf ~"), "yes-rm-rf");
    same("slug: quotes", whatsAppAccountSlug('"Oliver"'), "oliver");
    same("slug: at most 32", whatsAppAccountSlug("a".repeat(80)).length, 32);
    same("slug: unique", whatsAppAccountSlug("Empresa", ["empresa", "empresa-2"]), "empresa-3");
    same("slug: unique and still 32", whatsAppAccountSlug("b".repeat(40), ["b".repeat(32)]), `${"b".repeat(30)}-2`);
    check(
      "slug: always a wazap id",
      ["Raquel", "  ", "-", "Ñandú", "ÅÄÖ", "x".repeat(99)].every((name) =>
        /^[a-z0-9][a-z0-9-]{0,31}$/.test(whatsAppAccountSlug(name)),
      ),
    );

    // E.164 by country. Every number is a fake one.
    same("e164: Brazil with area code", normalizeWhatsAppPhone("(11) 5550-0100", "BR"), "+551155500100");
    same("e164: Brazil with trunk zero", normalizeWhatsAppPhone("011 95550-0100", "BR"), "+5511955500100");
    same("e164: Brazil typed with dial code", normalizeWhatsAppPhone("55 11 95550 0100", "BR"), "+5511955500100");
    same("e164: Portugal", normalizeWhatsAppPhone("912 345 670", "PT"), "+351912345670");
    same("e164: USA", normalizeWhatsAppPhone("(201) 555-0100", "US"), "+12015550100");
    same("e164: USA with leading 1", normalizeWhatsAppPhone("1 201 555 0100", "US"), "+12015550100");
    same("e164: full number ignores the country", normalizeWhatsAppPhone("+1 555 0100", "BR"), "+15550100");
    same("e164: too short", normalizeWhatsAppPhone("5550100", "BR"), null);
    same("e164: letters", normalizeWhatsAppPhone("11 9555O-0100", "BR"), null);
    same("e164: leading zero after plus", normalizeWhatsAppPhone("+0 555 0100", "BR"), null);
    same("e164: unknown country", normalizeWhatsAppPhone("2015550100", "ZZ"), null);
    same("e164: injection", normalizeWhatsAppPhone("+15550100; rm -rf ~", "US"), null);

    // Masking.
    same("mask: last four", maskWhatsAppNumber("15550100"), "•••• 0100");
    same("mask: short", maskWhatsAppNumber("12"), "••••");
    check(
      "redact: number and code",
      !/5550100|ABCD-EF12/.test(redactWazapText('pairing code: ABCD-EF12 for "+15550100" (+15 5xx xxx x)')),
    );

    // Argument lists: one value per element, typed values joined to their flag.
    same("args: status", wazapArgs({ kind: "status" }), [...WAZAP_NPX_ARGS, "status", "--json"]);
    same(
      "args: add with an injection in the nickname",
      wazapArgs({ kind: "add", id: "oliver", name: '--yes "Oliver"; rm -rf ~' }),
      [...WAZAP_NPX_ARGS, "account", "add", "oliver", '--name=--yes "Oliver"; rm -rf ~', "--json"],
    );
    same("args: add with unicode", wazapArgs({ kind: "add", id: "sofia", name: "Sofía 😀" }).at(-2), "--name=Sofía 😀");
    same("args: remove asks no question", wazapArgs({ kind: "account", verb: "remove", id: "sofia" }).slice(2), [
      "account",
      "remove",
      "sofia",
      "--yes",
    ]);
    same("args: read only", wazapArgs({ kind: "writes", id: "sofia", on: false }).slice(2), [
      "config",
      "writes",
      "off",
      "--account=sofia",
    ]);
    same("args: code", wazapArgs({ kind: "login-code", id: "sofia", phone: "+15550100" }).slice(2), [
      "login",
      "--account=sofia",
      "--phone=+15550100",
      "--code",
    ]);
    same("args: data folder", wazapArgs({ kind: "list" }, "/tmp/w").at(-1), "--data-dir=/tmp/w");
    check(
      "args: refuses an id that is a flag",
      throwsArgumentError(() => wazapArgs({ kind: "logout", id: "--all" })),
    );
    check(
      "args: refuses an id with a shell word",
      throwsArgumentError(() => wazapArgs({ kind: "account", verb: "remove", id: "a;rm" })),
    );
    check(
      "args: refuses a nickname with a line break",
      throwsArgumentError(() => wazapArgs({ kind: "add", id: "ana", name: "Ana\n--yes" })),
    );
    check(
      "args: refuses a long nickname",
      throwsArgumentError(() => wazapArgs({ kind: "add", id: "ana", name: "a".repeat(65) })),
    );
    check(
      "args: refuses a number that is not E.164",
      throwsArgumentError(() => wazapArgs({ kind: "login-code", id: "ana", phone: "15550100" })),
    );

    // Readers, with fixtures shaped as wazap 1.6.0 prints them.
    const status = parseWazapStatus(
      `npm warn exec The following package was not found and will be installed\n${JSON.stringify({
        data_dir: "/tmp/fixture",
        linked: true,
        account: { id: "15550100@s.whatsapp.net", name: "Ana", number: "15550100" },
        accounts: [
          {
            id: "default",
            name: "default",
            enabled: true,
            default: true,
            account: { id: "15550100@s.whatsapp.net", name: "Ana", number: "15550100" },
            owner: "15550100:12@s.whatsapp.net",
          },
          {
            id: "empresa",
            name: "Empresa",
            enabled: true,
            default: false,
            account: null,
            owner: "15550199:3@s.whatsapp.net",
          },
          { id: "sofia", name: "Sofia", enabled: false, default: false, account: null, owner: null },
          { id: "BAD ID", name: "x", enabled: true, default: false, account: null, owner: null },
        ],
        server_pid: 4242,
        storage: {
          accounts: [
            { account: "default", state: "ready", counts: { messages: 1280, chats: 40 } },
            { account: "empresa", state: "error", counts: null },
          ],
        },
      })}`,
    );
    check("status: read", status !== null);
    same("status: server", status?.serverPid, 4242);
    same(
      "status: rows",
      status?.accounts.map((row) => [row.id, row.number, row.ownerNumber, row.enabled, row.isDefault]),
      [
        ["default", "15550100", "15550100", true, true],
        ["empresa", null, "15550199", true, false],
        ["sofia", null, null, false, false],
      ],
    );
    same("status: messages", status?.storage.get("default")?.messages, 1280);
    same("status: not a report", parseWazapStatus("wazap is running (pid 1)."), null);

    same(
      "list: rows",
      parseWazapAccountList(
        [
          "default  enabled  Ana (+15 5xx xxx x)  (default)",
          "empresa  enabled  was +15 5xx xxx x",
          "sofia  disabled  not linked",
          "! warning line",
        ].join("\n"),
      ),
      [
        { id: "default", enabled: true, isDefault: true, linked: true, name: "Ana" },
        { id: "empresa", enabled: true, isDefault: false, linked: false, name: null },
        { id: "sofia", enabled: false, isDefault: false, linked: false, name: null },
      ],
    );
    same("add: created", parseWazapAdd('{"account_id":"sofia","created":true,"enabled":true}\n'), {
      id: "sofia",
      created: true,
    });
    same("add: existed", parseWazapAdd('{"account_id":"sofia","created":false,"enabled":true}'), {
      id: "sofia",
      created: false,
    });
    same("add: not json", parseWazapAdd('Account "sofia" added.'), null);

    const login = parseWazapLogin(
      [
        "wazap 1.6.0",
        "✓ +15 5xx xxx x",
        "pairing code: ABCD-EF12",
        "  On your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead",
      ].join("\n"),
    );
    same("login: code", login, { code: "ABCD-EF12", qr: null, linked: false });
    same("login: linked", parseWazapLogin("pairing code: ABCD-EF12\n✓ Linked as Ana (+15 5xx xxx x)").linked, true);

    const code = QRCode.create("2@fixture-reference-not-a-real-pairing,AAAA,BBBB,CCCC", { errorCorrectionLevel: "L" });
    const size = code.modules.size;
    const modules = Array.from({ length: size }, (_, row) =>
      Array.from({ length: size }, (_, column) => (code.modules.get(row, column) ? "1" : "0")).join(""),
    );
    const drawing = drawSmall(size, (row, column) => Boolean(code.modules.get(row, column)));
    same("qr: drawing back to modules", parseQrDrawing(drawing), modules);
    same(
      "qr: latest drawing in login output",
      parseWazapLogin(
        ["Scan it with WhatsApp", ...drawing, "  Scan it with WhatsApp → Settings → Linked devices"].join("\n"),
      ).qr,
      modules,
    );
    same("qr: cut drawing", parseQrDrawing(drawing.slice(0, 5)), null);

    same("error: server", wazapErrorCode("✗ wazap is running (pid 4242). stop it first: kill 4242"), "server-running");
    same("error: phone", wazapErrorCode('✗ "123" is not a phone number in international format.'), "invalid-phone");
    same("error: last", wazapErrorCode("✗ Cannot remove the last account."), "last-account");
    same("error: taken", wazapErrorCode('✗ Account "sofia" already exists.'), "id-taken");
    same("error: unknown", wazapErrorCode("something else"), "failed");
    same(
      "notice: restart",
      wazapNotice("! A server is running (pid 9); restart it for this to apply."),
      "restart-needed",
    );
    same(
      "notice: kept",
      wazapNotice("! The running server keeps serving default: it has no other enabled account."),
      "kept-running",
    );

    // States and link refusals.
    const row = (patch: Partial<WazapStatusAccount>): WazapStatusAccount => ({
      id: "sofia",
      name: "Sofia",
      enabled: true,
      isDefault: false,
      number: null,
      ownerNumber: null,
      ...patch,
    });
    same("state: disabled", accountState(row({ enabled: false, number: "15550100" }), undefined, false), "disabled");
    same("state: linked", accountState(row({ number: "15550100" }), { state: "ready", messages: 1 }, false), "linked");
    same("state: linking", accountState(row({}), undefined, true), "linking");
    same("state: not linked", accountState(row({}), { state: "absent", messages: null }, false), "not-linked");
    same("state: error", accountState(row({}), { state: "error", messages: null }, false), "error");
    const accounts = [
      row({ id: "default", number: "15550100", ownerNumber: "15550100" }),
      row({ id: "empresa", ownerNumber: "15550199" }),
      row({ id: "sofia" }),
      row({ id: "off", enabled: false }),
    ];
    same("refusal: free account and new number", linkRefusal(accounts, "sofia", "15550111"), null);
    same("refusal: number of another account", linkRefusal(accounts, "sofia", "15550100"), "number-in-use");
    same("refusal: number that another account had", linkRefusal(accounts, "sofia", "15550199"), "number-in-use");
    same("refusal: account of another number", linkRefusal(accounts, "empresa", "15550111"), "owner-mismatch");
    same("refusal: same number again", linkRefusal(accounts, "empresa", "15550199"), null);
    same("refusal: linked", linkRefusal(accounts, "default", "15550100"), "already-linked");
    same("refusal: off", linkRefusal(accounts, "off", "15550111"), "account-disabled");
    same("refusal: missing", linkRefusal(accounts, "raquel", "15550111"), "account-not-found");
  });
}

/** The `name` of one account in `accounts.json`. */
function registryName(registry: unknown, id: string): string | null {
  if (!isDynamicRecord(registry) || !Array.isArray(registry.accounts)) return null;
  const entry = registry.accounts.find((candidate) => isDynamicRecord(candidate) && candidate.id === id);
  return isDynamicRecord(entry) && typeof entry.name === "string" ? entry.name : null;
}

function rows(snapshot: WhatsAppAccountsSnapshot) {
  return snapshot.status === "ready" ? snapshot.accounts : [];
}

async function cliChecks(dataDir: string) {
  const service = createWhatsAppAccounts({ platform: process.platform, dataDir });
  try {
    const first = await service.list();
    same(
      "cli: a fresh folder has one default account",
      rows(first).map((account) => [account.id, account.isDefault, account.state]),
      [["default", true, "not-linked"]],
    );
    check("cli: no server holds the temporary folder", first.status === "ready" && !first.serverRunning);

    const nickname = '--yes "Oliver"; rm -rf ~ 😀';
    const id = whatsAppAccountSlug(
      nickname,
      rows(first).map((account) => account.id),
    );
    const added = await service.add({ id, name: nickname, phone: "+15550100" });
    check("cli: add", added.ok, added.ok ? undefined : added.error);
    const oliver = added.ok ? rows(added.snapshot).find((account) => account.id === id) : undefined;
    same("cli: the nickname arrives as one value", oliver?.name, nickname);
    same("cli: the new account is not linked", oliver?.state, "not-linked");
    const again = await service.add({ id, name: "Other", phone: null });
    same("cli: the same id twice", again.ok ? "ok" : again.error, "id-taken");

    same(
      "cli: accounts.json holds the nickname",
      registryName(JSON.parse(await readFile(join(dataDir, "accounts.json"), "utf8")), id),
      nickname,
    );

    const steps: Array<
      [string, Parameters<typeof service.act>[0], (snapshot: WhatsAppAccountsSnapshot) => unknown, unknown]
    > = [
      ["default", { action: "default", id }, (s) => rows(s).find((a) => a.isDefault)?.id, id],
      ["read only", { action: "read-only", id }, (s) => rows(s).find((a) => a.id === id)?.readOnly, true],
      ["writable", { action: "writable", id }, (s) => rows(s).find((a) => a.id === id)?.readOnly, false],
      ["disable", { action: "disable", id }, (s) => rows(s).find((a) => a.id === id)?.state, "disabled"],
      ["enable", { action: "enable", id }, (s) => rows(s).find((a) => a.id === id)?.state, "not-linked"],
    ];
    for (const [name, input, read, expected] of steps) {
      const result = await service.act(input);
      check(`cli: ${name}`, result.ok, result.ok ? undefined : result.error);
      if (result.ok) same(`cli: ${name} shows`, read(result.snapshot), expected);
    }

    const unconfirmed = await service.act({ action: "remove", id });
    same("cli: remove without its confirmation", unconfirmed.ok ? "ok" : unconfirmed.error, "failed");
    same(
      "cli: the account is still there",
      rows(await service.list()).some((account) => account.id === id),
      true,
    );
    const removed = await service.act({ action: "remove", id, confirm: id });
    check("cli: remove", removed.ok, removed.ok ? undefined : removed.error);
    same("cli: only default is left", removed.ok ? rows(removed.snapshot).map((account) => account.id) : null, [
      "default",
    ]);
    const last = await service.act({ action: "remove", id: "default", confirm: "default" });
    same("cli: the last account stays", last.ok ? "ok" : last.error, "last-account");
    const missing = await service.act({ action: "disable", id: "raquel" });
    same("cli: an account that does not exist", missing.ok ? "ok" : missing.error, "account-not-found");
  } finally {
    await service.dispose();
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await pureChecks();
  const dataDir = await mkdtemp(join(tmpdir(), "wazap-e2e-"));
  // A guard of its own: this script must never reach the folder that holds a real link.
  if (resolve(dataDir) === resolve(homedir(), ".wazap") || !resolve(dataDir).startsWith(resolve(tmpdir()))) {
    throw new Error("The temporary data folder is not temporary.");
  }
  try {
    await cliChecks(dataDir);
  } finally {
    // Only the folder that this run made, under the system temporary folder.
    await rm(dataDir, { recursive: true, force: true });
  }
  const failed = checks.filter((entry) => !entry.ok);
  const report = {
    at: new Date().toISOString(),
    wazap: WAZAP_PACKAGE,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
  };
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  logger.info("WhatsApp accounts E2E finished.", {
    path: ".openbot-build/whatsapp-accounts-e2e/report.json",
    passed: report.passed,
    failed: report.failed,
  });
  for (const entry of failed) logger.error("Check failed.", { name: entry.name, detail: entry.detail ?? "" });
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  logger.error("WhatsApp accounts E2E could not run.", {
    cause: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
