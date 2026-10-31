// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanWhatsAppAccountName,
  maskWhatsAppNumber,
  normalizeWhatsAppPhone,
  sameWhatsAppNumber,
  WAZAP_PACKAGE,
  whatsAppAccountSlug,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import {
  accountState,
  linkRefusal,
  parseGlobalReadOnly,
  parseQrDrawing,
  parseWazapAccountList,
  parseWazapAdd,
  parseWazapLogin,
  parseWazapStatus,
  redactWazapText,
  toWhatsAppAccount,
  WAZAP_NPX_ARGS,
  WazapArgumentError,
  type WazapStatusAccount,
  type WazapStorage,
  wazapArgs,
  wazapErrorCode,
  wazapNotice,
} from "./wazap-cli";

// Every number here is a fake one.

function row(patch: Partial<WazapStatusAccount>): WazapStatusAccount {
  return {
    id: "sofia",
    name: "Sofia",
    enabled: true,
    isDefault: false,
    number: null,
    ownerNumber: null,
    databaseOwner: null,
    ...patch,
  };
}

/** The `args` of the server of the listing's one app. */
function listingServerArgs(listing: unknown): string[] | null {
  const app = isDynamicRecord(listing) && Array.isArray(listing.apps) ? listing.apps[0] : null;
  const args = isDynamicRecord(app) && isDynamicRecord(app.server) ? app.server.args : null;
  return Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : null;
}

/** The half-block drawing of `qrcode-terminal` (small mode), from the same modules. */
function drawSmall(size: number, dark: (row: number, column: number) => boolean): string[] {
  const rows: boolean[][] = Array.from({ length: size }, (_, line) =>
    Array.from({ length: size }, (_, column) => dark(line, column)),
  );
  const odd = size % 2 === 1;
  if (odd) rows.push(Array.from({ length: size }, () => false));
  const lines = ["▄".repeat(size + 2)];
  for (let line = 0; line < size; line += 2) {
    let text = "█";
    for (let column = 0; column < size; column++) {
      const top = rows[line]?.[column] ?? false;
      const bottom = rows[line + 1]?.[column] ?? false;
      text += !top && !bottom ? "█" : !top && bottom ? "▀" : top && !bottom ? "▄" : " ";
    }
    lines.push(`${text}█`);
  }
  if (!odd) lines.push("▀".repeat(size + 2));
  return lines;
}

/** `wazap status --json` of a data folder after `wazap logout` of `default`: no owner, no account. */
const AFTER_LOGOUT = JSON.stringify({
  data_dir: "/tmp/fixture",
  linked: false,
  account: null,
  accounts: [
    { id: "default", name: "default", enabled: true, default: true, account: null, owner: null },
    { id: "sofia", name: "Sofia", enabled: true, default: false, account: null, owner: null },
  ],
  server_pid: null,
  storage: {
    accounts: [
      { account: "default", state: "ready", counts: { messages: 12000, chats: 40 } },
      { account: "sofia", state: "absent", counts: null },
    ],
  },
});

describe("wazap log redaction", () => {
  it("removes phone numbers in every form that wazap prints", () => {
    const lines = [
      '"+15550100" is not a phone number in international format.',
      "linked as Ana (+15 5xx xxx x)",
      "was +44 7xx xxx xxx",
      "owner 15550100:12@s.whatsapp.net",
      "phone 1 555 0100 refused",
      "number +1-555-0100",
    ];
    for (const line of lines) {
      const redacted = redactWazapText(line);
      expect(redacted).not.toMatch(/\d{4,}/);
      expect(redacted).not.toMatch(/5550100|555 0100|555-0100|5xx/);
    }
  });

  it("removes pairing codes, quoted ids and names, and colour codes", () => {
    const redacted = redactWazapText(
      '\u001b[32mpairing code: ABCD-EF12\u001b[0m\nNo account "sofia". Account "Ana Souza" added.',
    );
    expect(redacted).not.toContain("ABCD-EF12");
    expect(redacted).not.toContain("sofia");
    expect(redacted).not.toContain("Ana Souza");
    expect(redacted).not.toContain("\u001b[");
    expect(redacted).toContain("[code]");
  });

  it("keeps the words that say what failed", () => {
    expect(redactWazapText("wazap is running (pid 4242).")).toBe("wazap is running (pid 4242).");
    expect(redactWazapText("Cannot remove the last account.")).toBe("Cannot remove the last account.");
  });
});

describe("WhatsApp account values", () => {
  it("runs the same wazap as the listing", () => {
    const listing = readFileSync(
      resolve(import.meta.dirname, "../../marketplace/plugin-catalog/plugins/whatsapp/plugin.json"),
      "utf8",
    );
    expect(listingServerArgs(JSON.parse(listing))).toEqual([...WAZAP_NPX_ARGS]);
    expect(WAZAP_NPX_ARGS).toEqual(["-y", WAZAP_PACKAGE]);
  });

  it("makes a wazap account id from a nickname", () => {
    expect(whatsAppAccountSlug("WhatsApp do Ariel")).toBe("whatsapp-do-ariel");
    expect(whatsAppAccountSlug("Sofia Conceição")).toBe("sofia-conceicao");
    expect(whatsAppAccountSlug("😀 ☎️")).toBe("account");
    expect(whatsAppAccountSlug("--yes; rm -rf ~")).toBe("yes-rm-rf");
    expect(whatsAppAccountSlug('"Oliver"')).toBe("oliver");
    expect(whatsAppAccountSlug("a".repeat(80))).toHaveLength(32);
    expect(whatsAppAccountSlug("Empresa", ["empresa", "empresa-2"])).toBe("empresa-3");
    expect(whatsAppAccountSlug("b".repeat(40), ["b".repeat(32)])).toBe(`${"b".repeat(30)}-2`);
    for (const name of ["Raquel", "  ", "-", "Ñandú", "ÅÄÖ", "x".repeat(99)]) {
      expect(whatsAppAccountSlug(name)).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
    }
  });

  it("refuses a nickname that the shell of npx would change", () => {
    for (const name of ["Loja{1,2}", "Loja[12]", "{a}", "x]"]) expect(cleanWhatsAppAccountName(name)).toBeNull();
    expect(cleanWhatsAppAccountName('  --yes "Oliver"; rm -rf ~ 😀 ')).toBe('--yes "Oliver"; rm -rf ~ 😀');
  });

  it("writes a number in E.164 for its country", () => {
    expect(normalizeWhatsAppPhone("(11) 5550-0100", "BR")).toBe("+551155500100");
    expect(normalizeWhatsAppPhone("011 95550-0100", "BR")).toBe("+5511955500100");
    expect(normalizeWhatsAppPhone("55 11 95550 0100", "BR")).toBe("+5511955500100");
    expect(normalizeWhatsAppPhone("912 345 670", "PT")).toBe("+351912345670");
    expect(normalizeWhatsAppPhone("(201) 555-0100", "US")).toBe("+12015550100");
    expect(normalizeWhatsAppPhone("1 201 555 0100", "US")).toBe("+12015550100");
    expect(normalizeWhatsAppPhone("+1 555 0100", "BR")).toBe("+15550100");
    for (const [text, region] of [
      ["5550100", "BR"],
      ["11 9555O-0100", "BR"],
      ["+0 555 0100", "BR"],
      ["2015550100", "ZZ"],
      ["+15550100; rm -rf ~", "US"],
    ] as const) {
      expect(normalizeWhatsAppPhone(text, region)).toBeNull();
    }
  });

  it("compares a Brazilian mobile number with and without its ninth digit", () => {
    expect(sameWhatsAppNumber("+5547999990100", "554799990100")).toBe(true);
    expect(sameWhatsAppNumber("554799990100", "+5547999990100")).toBe(true);
    expect(sameWhatsAppNumber("+15550100", "15550100")).toBe(true);
    expect(sameWhatsAppNumber("+5547999990100", "554799990199")).toBe(false);
    expect(sameWhatsAppNumber("+5547999990100", "5548999990100")).toBe(false);
    expect(sameWhatsAppNumber("+3519999990100", "35199990100")).toBe(false);
    expect(sameWhatsAppNumber("", "")).toBe(false);
  });

  it("masks a number to its last four digits", () => {
    expect(maskWhatsAppNumber("15550100")).toBe("•••• 0100");
    expect(maskWhatsAppNumber("12")).toBe("••••");
  });
});

describe("wazap arguments", () => {
  it("keeps each typed value in one argument, joined to its flag", () => {
    expect(wazapArgs({ kind: "status" })).toEqual([...WAZAP_NPX_ARGS, "status", "--json"]);
    expect(wazapArgs({ kind: "add", id: "oliver", name: '--yes "Oliver"; rm -rf ~' })).toEqual([
      ...WAZAP_NPX_ARGS,
      "account",
      "add",
      "oliver",
      '--name=--yes "Oliver"; rm -rf ~',
      "--json",
    ]);
    expect(wazapArgs({ kind: "account", verb: "remove", id: "sofia" }).slice(2)).toEqual([
      "account",
      "remove",
      "sofia",
      "--yes",
    ]);
    expect(wazapArgs({ kind: "writes", id: "sofia", on: false }).slice(2)).toEqual([
      "config",
      "writes",
      "off",
      "--account=sofia",
    ]);
    expect(wazapArgs({ kind: "login-code", id: "sofia", phone: "+15550100" }).slice(2)).toEqual([
      "login",
      "--account=sofia",
      "--phone=+15550100",
      "--code",
    ]);
    expect(wazapArgs({ kind: "list" }, "/tmp/w").at(-1)).toBe("--data-dir=/tmp/w");
  });

  it("refuses a value that could change the command", () => {
    const refused = [
      () => wazapArgs({ kind: "logout", id: "--all" }),
      () => wazapArgs({ kind: "account", verb: "remove", id: "a;rm" }),
      () => wazapArgs({ kind: "add", id: "ana", name: "Ana\n--yes" }),
      () => wazapArgs({ kind: "add", id: "ana", name: "Loja{1,2}" }),
      () => wazapArgs({ kind: "add", id: "ana", name: "a".repeat(65) }),
      () => wazapArgs({ kind: "login-code", id: "ana", phone: "15550100" }),
    ];
    for (const build of refused) expect(build).toThrow(WazapArgumentError);
  });
});

describe("wazap output", () => {
  it("reads the status report after a notice of npx", () => {
    const status = parseWazapStatus(
      `npm warn exec The following package was not found and will be installed\n${JSON.stringify({
        data_dir: "/tmp/fixture",
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
    expect(status?.serverPid).toBe(4242);
    expect(
      status?.accounts.map((entry) => [entry.id, entry.number, entry.ownerNumber, entry.enabled, entry.isDefault]),
    ).toEqual([
      ["default", "15550100", "15550100", true, true],
      ["empresa", null, "15550199", true, false],
      ["sofia", null, null, false, false],
    ]);
    expect(status?.storage.get("default")?.messages).toBe(1280);
    expect(parseWazapStatus("wazap is running (pid 1).")).toBeNull();
  });

  it("reads the account list, the add answer and the login lines", () => {
    expect(
      parseWazapAccountList(
        [
          "default  enabled  Ana (+15 5xx xxx x)  (default)",
          "empresa  enabled  was +15 5xx xxx x",
          "sofia  disabled  not linked",
          "! warning line",
        ].join("\n"),
      ),
    ).toEqual([
      { id: "default", enabled: true, isDefault: true, linked: true, name: "Ana" },
      { id: "empresa", enabled: true, isDefault: false, linked: false, name: null },
      { id: "sofia", enabled: false, isDefault: false, linked: false, name: null },
    ]);
    expect(parseWazapAdd('{"account_id":"sofia","created":true,"enabled":true}\n')).toEqual({
      id: "sofia",
      created: true,
    });
    expect(parseWazapAdd('{"account_id":"sofia","created":false,"enabled":true}')).toEqual({
      id: "sofia",
      created: false,
    });
    expect(parseWazapAdd('Account "sofia" added.')).toBeNull();
    expect(parseWazapLogin("wazap 1.6.0\n✓ +15 5xx xxx x\npairing code: ABCD-EF12\n  On your phone: …")).toEqual({
      code: "ABCD-EF12",
      qr: null,
      linked: false,
    });
    expect(parseWazapLogin("pairing code: ABCD-EF12\n✓ Linked as Ana (+15 5xx xxx x)").linked).toBe(true);
  });

  it("reads back the QR that the CLI draws", () => {
    const code = QRCode.create("2@fixture-reference-not-a-real-pairing,AAAA,BBBB,CCCC", { errorCorrectionLevel: "L" });
    const size = code.modules.size;
    const modules = Array.from({ length: size }, (_, line) =>
      Array.from({ length: size }, (_, column) => (code.modules.get(line, column) ? "1" : "0")).join(""),
    );
    const drawing = drawSmall(size, (line, column) => Boolean(code.modules.get(line, column)));
    expect(parseQrDrawing(drawing)).toEqual(modules);
    expect(parseWazapLogin(["Scan it with WhatsApp", ...drawing, "  Scan it"].join("\n")).qr).toEqual(modules);
    expect(parseQrDrawing(drawing.slice(0, 5))).toBeNull();
  });

  it("maps a failure to an error code with its own text", () => {
    expect(wazapErrorCode("✗ wazap is running (pid 4242). stop it first: kill 4242")).toBe("server-busy");
    expect(
      wazapErrorCode('✗ Cannot remove "default" while the server runs: it is the only account being served.'),
    ).toBe("only-served");
    expect(wazapErrorCode('✗ "123" is not a phone number in international format.')).toBe("invalid-phone");
    expect(wazapErrorCode("✗ Cannot remove the last account.")).toBe("last-account");
    expect(wazapErrorCode('✗ Account "sofia" already exists.')).toBe("id-taken");
    expect(wazapErrorCode("something else")).toBe("failed");
    expect(wazapNotice("! A server is running (pid 9); restart it for this to apply.")).toBe("restart-needed");
    expect(wazapNotice("! The running server keeps serving default: it has no other enabled account.")).toBe(
      "kept-running",
    );
  });

  it("reads the global read only switch of the data folder", () => {
    expect(parseGlobalReadOnly("WAZAP_READ_ONLY=1\n")).toBe(true);
    expect(parseGlobalReadOnly('# writes\nexport WAZAP_READ_ONLY="yes" # off\n')).toBe(true);
    expect(parseGlobalReadOnly("WAZAP_READ_ONLY=0")).toBe(false);
    expect(parseGlobalReadOnly("WAZAP_READ_ONLY=1\nWAZAP_READ_ONLY=off")).toBe(false);
    expect(parseGlobalReadOnly("WAZAP_TRANSPORT=http")).toBe(false);
  });
});

describe("account state and link refusals", () => {
  const none = new Map<string, WazapStorage>();

  it("gives the state of each row", () => {
    expect(accountState(row({ enabled: false, number: "15550100" }), undefined, false)).toBe("disabled");
    expect(accountState(row({ number: "15550100" }), { state: "ready", messages: 1 }, false)).toBe("linked");
    expect(accountState(row({}), undefined, true)).toBe("linking");
    expect(accountState(row({}), { state: "absent", messages: null }, false)).toBe("not-linked");
    expect(accountState(row({}), { state: "error", messages: null }, false)).toBe("error");
  });

  it("refuses a number into an account of another number, and a number of another account", () => {
    const accounts = [
      row({ id: "default", number: "15550100", ownerNumber: "15550100" }),
      row({ id: "empresa", ownerNumber: "15550199" }),
      row({ id: "sofia" }),
      row({ id: "off", enabled: false }),
    ];
    expect(linkRefusal(accounts, none, "sofia", "15550111")).toBeNull();
    expect(linkRefusal(accounts, none, "sofia", "15550100")).toBe("number-in-use");
    expect(linkRefusal(accounts, none, "sofia", "15550199")).toBe("number-in-use");
    expect(linkRefusal(accounts, none, "empresa", "15550111")).toBe("owner-mismatch");
    expect(linkRefusal(accounts, none, "empresa", null)).toBe("owner-mismatch");
    expect(linkRefusal(accounts, none, "empresa", "15550199")).toBeNull();
    expect(linkRefusal(accounts, none, "default", "15550100")).toBe("already-linked");
    expect(linkRefusal(accounts, none, "off", "15550111")).toBe("account-disabled");
    expect(linkRefusal(accounts, none, "raquel", "15550111")).toBe("account-not-found");
    expect(linkRefusal(accounts, none, "sofia", null)).toBeNull();
  });

  it("keeps the history of an unlinked number to that number", () => {
    const status = parseWazapStatus(AFTER_LOGOUT);
    if (!status) throw new Error("The fixture did not parse.");
    const target = status.accounts.find((entry) => entry.id === "default");
    if (!target) throw new Error("The fixture has no default account.");
    const shown = toWhatsAppAccount(target, status.storage.get("default"), undefined, false);
    expect(shown).toMatchObject({ state: "not-linked", number: null, unlinkedHistory: true, messages: 12000 });

    // The database owner could not be read: no number can link, by code or by QR.
    expect(linkRefusal(status.accounts, status.storage, "default", "15550111")).toBe("has-history");
    expect(linkRefusal(status.accounts, status.storage, "default", null)).toBe("has-history");

    // Main read the owner of the database: the same number links again, another one does not.
    const owned = status.accounts.map((entry) =>
      entry.id === "default" ? { ...entry, databaseOwner: "554799990100" } : entry,
    );
    expect(linkRefusal(owned, status.storage, "default", "5547999990100")).toBeNull();
    expect(linkRefusal(owned, status.storage, "default", "15550111")).toBe("has-history");
    expect(linkRefusal(owned, status.storage, "default", null)).toBe("has-history");
    // That number has its history in `default`, so another account does not take it.
    expect(linkRefusal(owned, status.storage, "sofia", "5547999990100")).toBe("number-in-use");
    expect(toWhatsAppAccount(owned[0] ?? target, status.storage.get("default"), undefined, false).formerNumber).toBe(
      "•••• 0100",
    );

    // A new account with an empty database keeps no history.
    const fresh = new Map<string, WazapStorage>([["sofia", { state: "ready", messages: 0 }]]);
    expect(linkRefusal(status.accounts, fresh, "sofia", "15550111")).toBeNull();
  });

  it("treats a Brazilian number without its ninth digit as the same number", () => {
    const accounts = [
      row({ id: "default", number: "554799990100", ownerNumber: "554799990100" }),
      row({ id: "empresa", ownerNumber: "554799990199" }),
      row({ id: "sofia" }),
    ];
    expect(linkRefusal(accounts, none, "sofia", "5547999990100")).toBe("number-in-use");
    expect(linkRefusal(accounts, none, "empresa", "5547999990199")).toBeNull();
    expect(linkRefusal(accounts, none, "empresa", "5547999990111")).toBe("owner-mismatch");
  });
});
