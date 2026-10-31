// @vitest-environment node

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WhatsAppLinkState } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CommandResult,
  createWhatsAppAccounts,
  type LoginProcess,
  type ServerClient,
  type WhatsAppAccountsOptions,
} from "./whatsapp-accounts";

// The service with every process boundary replaced. Every number here is a fake one.

interface StatusRow {
  id: string;
  name?: string;
  enabled?: boolean;
  default?: boolean;
  number?: string | null;
  owner?: string | null;
  storage?: { state: string; messages: number | null };
}

function statusJson(dataDir: string, rows: StatusRow[], serverPid: number | null): string {
  return JSON.stringify({
    data_dir: dataDir,
    accounts: rows.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      enabled: entry.enabled ?? true,
      default: entry.default ?? false,
      account: entry.number ? { id: `${entry.number}@s.whatsapp.net`, name: "", number: entry.number } : null,
      owner: entry.owner ?? null,
    })),
    server_pid: serverPid,
    storage: {
      accounts: rows.map((entry) => ({
        account: entry.id,
        state: entry.storage?.state ?? "absent",
        counts: entry.storage ? { messages: entry.storage.messages } : null,
      })),
    },
  });
}

function fakeLogin() {
  const output: Array<(chunk: string) => void> = [];
  const exits: Array<(code: number | null) => void> = [];
  const process = {
    stopped: 0,
    onOutput: (listener: (chunk: string) => void) => void output.push(listener),
    onExit: (listener: (code: number | null) => void) => void exits.push(listener),
    onError: () => undefined,
    stop() {
      this.stopped += 1;
    },
  } satisfies LoginProcess & { stopped: number };
  return {
    process,
    print: (text: string) => {
      for (const listener of output) listener(text);
    },
    exit: (code: number) => {
      for (const listener of exits) listener(code);
    },
  };
}

function fakeServer(numbers: Array<string | null>, expiresAt: number) {
  const calls: Array<{ name: string; args: Record<string, string> }> = [];
  const client = {
    closed: 0,
    async callTool(name: string, args: Record<string, string>) {
      calls.push({ name, args });
      if (name === "link_account") {
        return { structuredContent: { code: "ABCD-EFGH", expires_at: new Date(expiresAt).toISOString() } };
      }
      const number = numbers.length > 1 ? numbers.shift() : numbers[0];
      return { structuredContent: { account: number ? { id: `${number}@s.whatsapp.net`, number } : null } };
    },
    async close() {
      this.closed += 1;
    },
  } satisfies ServerClient & { closed: number };
  return { client, calls };
}

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "wazap-service-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

function service(rows: StatusRow[], serverPid: number | null, patch: Partial<WhatsAppAccountsOptions> = {}) {
  const commands: string[][] = [];
  const logins: string[][] = [];
  const login = fakeLogin();
  const options: WhatsAppAccountsOptions = {
    platform: "darwin",
    dataDir,
    resolveLaunch: async () => ({ command: "npx", path: null }),
    execute: async (_launch, args): Promise<CommandResult> => {
      commands.push(args);
      if (args.includes("status")) return { exit: 0, stdout: statusJson(dataDir, rows, serverPid), stderr: "" };
      return { exit: 0, stdout: "", stderr: "" };
    },
    startLogin: (_launch, args) => {
      logins.push(args);
      return login.process;
    },
    openServerClient: async () => {
      throw new Error("No server client in this test.");
    },
    ...patch,
  };
  return { accounts: createWhatsAppAccounts(options), commands, logins, login };
}

/** A wazap account database with only the `owner` meta, as wazap leaves it after `wazap logout`. */
function writeDatabase(id: string, owner: string) {
  const folder = join(dataDir, "accounts", id);
  mkdirSync(folder, { recursive: true });
  const database = new DatabaseSync(join(folder, "wazap.sqlite"));
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  database.prepare("INSERT INTO meta (key, value) VALUES ('owner', ?)").run(owner);
  database.close();
  return folder;
}

const AFTER_LOGOUT: StatusRow[] = [
  { id: "default", default: true, storage: { state: "ready", messages: 12000 } },
  { id: "sofia", name: "Sofia" },
];

describe("WhatsApp accounts service", () => {
  it("refuses another number, by code and by QR, into an account that keeps an unlinked number's history", async () => {
    const { accounts, logins } = service(AFTER_LOGOUT, null);
    expect(await accounts.startLink({ id: "default", method: "code", phone: "+15550111" })).toEqual({
      phase: "failed",
      error: "has-history",
    });
    expect(await accounts.startLink({ id: "default", method: "qr", phone: null })).toEqual({
      phase: "failed",
      error: "has-history",
    });
    expect(await accounts.startLink({ id: "default", method: "qr", phone: "+15550111" })).toEqual({
      phase: "failed",
      error: "has-history",
    });
    expect(logins).toEqual([]);
    const snapshot = await accounts.list();
    expect(snapshot.status === "ready" ? snapshot.accounts[0] : null).toMatchObject({
      id: "default",
      state: "not-linked",
      unlinkedHistory: true,
      formerNumber: null,
    });
  });

  it("reads the owner of the database read only, and lets only that number link again", async () => {
    const folder = writeDatabase("default", "554799990100@s.whatsapp.net");
    const { accounts, logins } = service(AFTER_LOGOUT, null);
    const snapshot = await accounts.list();
    expect(snapshot.status === "ready" ? snapshot.accounts[0]?.formerNumber : null).toBe("•••• 0100");
    expect(readdirSync(folder)).toEqual(["wazap.sqlite"]);
    expect(await accounts.startLink({ id: "default", method: "code", phone: "+15550111" })).toEqual({
      phase: "failed",
      error: "has-history",
    });
    expect(await accounts.startLink({ id: "sofia", method: "code", phone: "+5547999990100" })).toEqual({
      phase: "failed",
      error: "number-in-use",
    });
    expect(await accounts.startLink({ id: "default", method: "code", phone: "+5547999990100" })).toEqual({
      phase: "starting",
    });
    expect(logins).toEqual([
      [
        "-y",
        "wazap-mcp@1.6.0",
        "login",
        "--account=default",
        "--phone=+5547999990100",
        "--code",
        `--data-dir=${dataDir}`,
      ],
    ]);
    await accounts.dispose();
  });

  it("links by wazap login when no server holds the folder, and cancel stops it", async () => {
    const { accounts, logins, login } = service([{ id: "sofia" }], null);
    expect(await accounts.startLink({ id: "sofia", method: "code", phone: "+15550100" })).toEqual({
      phase: "starting",
    });
    expect(logins[0]?.slice(2, 6)).toEqual(["login", "--account=sofia", "--phone=+15550100", "--code"]);
    login.print("wazap 1.6.0\npairing code: ABCD-EFGH\n");
    expect(accounts.linkState("sofia")).toMatchObject({ phase: "code", code: "ABCD-EFGH" });
    await accounts.cancelLink("sofia");
    expect(login.process.stopped).toBe(1);
    expect(accounts.linkState("sofia")).toBeNull();
  });

  it("ends a wazap login pairing as linked when the CLI exits well", async () => {
    const { accounts, login } = service([{ id: "sofia" }], null);
    await accounts.startLink({ id: "sofia", method: "code", phone: "+15550100" });
    login.print("pairing code: ABCD-EFGH\n");
    login.exit(0);
    expect(accounts.linkState("sofia")).toEqual({ phase: "linked", otherNumber: false });
  });

  it("refuses a QR code while a server holds the folder", async () => {
    const { accounts, logins } = service([{ id: "sofia" }], 4242);
    expect(await accounts.startLink({ id: "sofia", method: "qr", phone: null })).toEqual({
      phase: "failed",
      error: "qr-needs-free-folder",
    });
    expect(logins).toEqual([]);
  });

  it("pairs a code through the running server and sees a Brazilian id without its ninth digit as linked", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const server = fakeServer([null, "554799990100"], 1_000_000 + 120_000);
    const { accounts, logins } = service([{ id: "loja" }], 4242, { openServerClient: async () => server.client });
    expect(await accounts.startLink({ id: "loja", method: "code", phone: "+5547999990100" })).toEqual({
      phase: "starting",
    });
    await vi.waitFor(() =>
      expect(accounts.linkState("loja")).toEqual({ phase: "code", code: "ABCD-EFGH", expiresAt: 1_120_000 }),
    );
    expect(server.calls[0]).toEqual({ name: "link_account", args: { phone: "+5547999990100", account_id: "loja" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(accounts.linkState("loja")?.phase).toBe("code");
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(accounts.linkState("loja")).toEqual({ phase: "linked", otherNumber: false }));
    expect(server.client.closed).toBe(1);
    expect(logins).toEqual([]);
  });

  it("says when the running server linked a number other than the typed one", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const server = fakeServer(["15550199"], 1_000_000 + 120_000);
    const { accounts } = service([{ id: "loja" }], 4242, { openServerClient: async () => server.client });
    await accounts.startLink({ id: "loja", method: "code", phone: "+15550100" });
    await vi.waitFor(() => expect(accounts.linkState("loja")?.phase).toBe("code"));
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(accounts.linkState("loja")).toEqual({ phase: "linked", otherNumber: true }));
  });

  it("ends a code that the phone did not use as expired", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const server = fakeServer([null], 1_000_000 + 120_000);
    const { accounts } = service([{ id: "loja" }], 4242, { openServerClient: async () => server.client });
    await accounts.startLink({ id: "loja", method: "code", phone: "+15550100" });
    await vi.waitFor(() => expect(accounts.linkState("loja")?.phase).toBe("code"));
    const states: Array<WhatsAppLinkState["phase"] | undefined> = [];
    for (let elapsed = 0; elapsed <= 140_000; elapsed += 3_000) {
      await vi.advanceTimersByTimeAsync(3_000);
      states.push(accounts.linkState("loja")?.phase);
    }
    expect(states).toContain("code");
    expect(accounts.linkState("loja")).toEqual({ phase: "expired" });
    expect(server.client.closed).toBe(1);
  });

  it("closes the client of each pairing on dispose", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const server = fakeServer([null], 1_000_000 + 120_000);
    const { accounts } = service([{ id: "loja" }], 4242, { openServerClient: async () => server.client });
    await accounts.startLink({ id: "loja", method: "code", phone: "+15550100" });
    await vi.waitFor(() => expect(accounts.linkState("loja")?.phase).toBe("code"));
    await accounts.dispose();
    expect(server.client.closed).toBe(1);
    expect(accounts.linkState("loja")).toBeNull();
  });

  it("refuses to add an account for a number that another account has", async () => {
    const { accounts, commands } = service(
      [{ id: "default", number: "554799990100", owner: "554799990100@s.whatsapp.net" }],
      null,
    );
    const result = await accounts.add({ id: "loja", name: "Loja", phone: "+5547999990100" });
    expect(result.ok ? null : result.error).toBe("number-in-use");
    expect(commands.some((args) => args.includes("add"))).toBe(false);
  });

  it("turns an account off only with its confirmation", async () => {
    const { accounts, commands } = service([{ id: "default", default: true }, { id: "sofia" }], null);
    const refused = await accounts.act({ action: "disable", id: "sofia" });
    expect(refused.ok ? null : refused.error).toBe("failed");
    expect(commands).toEqual([]);
    const done = await accounts.act({ action: "disable", id: "sofia", confirm: "sofia" });
    expect(done.ok).toBe(true);
    expect(commands.some((args) => args.join(" ").includes("account disable sofia"))).toBe(true);
  });

  it("shows the global read only switch of the data folder", async () => {
    writeFileSync(join(dataDir, ".env"), "WAZAP_READ_ONLY=1\n");
    const { accounts } = service([{ id: "default", default: true }], null);
    const snapshot = await accounts.list();
    expect(snapshot.status === "ready" && snapshot.globalReadOnly).toBe(true);
    expect(existsSync(join(dataDir, "accounts"))).toBe(false);
  });
});
