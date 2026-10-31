// Drives the WhatsApp accounts service of main against the real pinned wazap CLI, in a temporary
// data folder. The pure parts (account ids, E.164, argument lists, output readers, states and link
// refusals) have their checks in src/main/wazap-cli.test.ts and src/main/whatsapp-accounts.test.ts.
//
// It never runs `login`, `logout` or `link_account`, never asks WhatsApp for a code, and never reads
// or writes `~/.wazap`: every command gets `--data-dir=<temporary folder>`. Only commands that do not
// contact WhatsApp run: `status`, `account add|list|enable|disable|default|remove`, `config writes`.
//
// It needs `npx` and, on a cold cache, the network to fetch the pinned package.
// `bun scripts/whatsapp-accounts-e2e.ts`. Writes .openbot-build/whatsapp-accounts-e2e/report.json.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WAZAP_PACKAGE, type WhatsAppAccountsSnapshot, whatsAppAccountSlug } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createBuildersBotLogger } from "@openbot/logging";
import { createWhatsAppAccounts } from "../src/main/whatsapp-accounts";

const OUT = resolve(import.meta.dirname, "../.openbot-build/whatsapp-accounts-e2e");
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
      ["disable", { action: "disable", id, confirm: id }, (s) => rows(s).find((a) => a.id === id)?.state, "disabled"],
      ["enable", { action: "enable", id }, (s) => rows(s).find((a) => a.id === id)?.state, "not-linked"],
    ];
    for (const [name, input, read, expected] of steps) {
      const result = await service.act(input);
      check(`cli: ${name}`, result.ok, result.ok ? undefined : result.error);
      if (result.ok) same(`cli: ${name} shows`, read(result.snapshot), expected);
    }

    // The state after `wazap logout`: no owner in accounts.json, and a database that still names its
    // number. A fake database with only that meta stands for it; no login or logout runs.
    const folder = join(dataDir, "accounts", id);
    await mkdir(folder, { recursive: true });
    const database = new DatabaseSync(join(folder, "wazap.sqlite"));
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    database.prepare("INSERT INTO meta (key, value) VALUES ('owner', ?)").run("15550100@s.whatsapp.net");
    database.close();
    const unlinked = rows(await service.list()).find((account) => account.id === id);
    same("cli: an unlinked account shows its former number", unlinked?.formerNumber, "•••• 0100");
    same("cli: an unlinked account keeps its history", unlinked?.unlinkedHistory, true);
    same(
      "cli: another number cannot link into it",
      await service.startLink({ id, method: "code", phone: "+15550111" }),
      { phase: "failed", error: "has-history" },
    );
    same("cli: a QR code cannot link into it", await service.startLink({ id, method: "qr", phone: null }), {
      phase: "failed",
      error: "has-history",
    });
    same("cli: main read the database without a side file", await readdir(folder), ["wazap.sqlite"]);

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
    const missing = await service.act({ action: "enable", id: "raquel" });
    same("cli: an account that does not exist", missing.ok ? "ok" : missing.error, "account-not-found");
  } finally {
    await service.dispose();
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
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
