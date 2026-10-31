// The WhatsApp accounts panel's service: it runs the pinned wazap CLI on this computer and runs one
// pairing per account. See docs/architecture/whatsapp-accounts.md.
//
// The service owns child processes and timers that outlive a request, so it uses plain promises and
// one serial queue for the CLI, not an Effect runtime. `dispose` ends every child it started.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  McpServerConfig,
  WhatsAppAccountActionInput,
  WhatsAppAccountAddInput,
  WhatsAppAccountsError,
  WhatsAppAccountsResult,
  WhatsAppAccountsSnapshot,
  WhatsAppLinkInput,
  WhatsAppLinkState,
} from "@openbot/contracts/ipc";
import { isDestructiveWhatsAppAction, sameWhatsAppNumber, WHATSAPP_PAIRING_CODE_PATTERN } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createBuildersBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { usableMcpServer } from "../backend/mcp-provider-shapes";
import {
  linkRefusal,
  numberInUse,
  ownerDigits,
  parseGlobalReadOnly,
  parseWazapAdd,
  parseWazapLogin,
  parseWazapStatus,
  parseWritesFlags,
  redactWazapText,
  toWhatsAppAccount,
  WAZAP_NPX_ARGS,
  type WazapCommand,
  type WazapStatus,
  wazapArgs,
  wazapErrorCode,
  wazapNotice,
} from "./wazap-cli";

const logger = createBuildersBotLogger("whatsapp-accounts");

/** The first `npx` run can download the package and its dependencies. */
const COMMAND_DEADLINE_MS = 60_000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
/** wazap's pairing code and QR last two minutes. */
const PAIRING_MS = 120_000;
/** A CLI pairing also waits up to 90 seconds for the history; past this, main ends it. */
const LOGIN_DEADLINE_MS = 5 * 60_000;
const LINK_POLL_MS = 3_000;
/** How long the status read waits after a code expires, for a link that WhatsApp accepted late. */
const EXPIRY_GRACE_MS = 10_000;

/** The listing's server, for the same `npx` lookup that a provider makes. */
const WAZAP_SERVER: McpServerConfig = {
  id: "",
  name: "whatsapp",
  transport: "stdio",
  enabled: true,
  command: "npx",
  args: [...WAZAP_NPX_ARGS],
  env: [],
  envPassthrough: [],
  workingDirectory: "",
  url: "",
  headers: [],
};

export interface WazapLaunch {
  command: string;
  path: string | null;
}

export interface CommandResult {
  exit: number | "timeout" | "spawn-failed";
  stdout: string;
  stderr: string;
}

/** A running `wazap login`. */
export interface LoginProcess {
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  onError(listener: () => void): void;
  /** Sends SIGTERM while it runs, so wazap frees the lock of the data folder. */
  stop(): void;
}

/** An MCP client of the wazap server that holds the data folder. */
export interface ServerClient {
  callTool(name: string, args: Record<string, string>, timeoutMs: number): Promise<unknown>;
  close(): Promise<void>;
}

export interface WhatsAppAccountsOptions {
  platform: NodeJS.Platform;
  /** Tests only. The app leaves it out, so wazap uses `~/.wazap`, as the plugin's server does. */
  dataDir?: string | undefined;
  /** Finds `npx`. Absent: the provider lookup (`usableMcpServer`). */
  resolveLaunch?: (() => Promise<WazapLaunch | null>) | undefined;
  now?: (() => number) | undefined;
  /** Tests only: runs one CLI command. Absent: `execFile`. */
  execute?: ((launch: WazapLaunch, args: string[]) => Promise<CommandResult>) | undefined;
  /** Tests only: starts `wazap login`. Absent: `spawn`. */
  startLogin?: ((launch: WazapLaunch, args: string[]) => LoginProcess) | undefined;
  /** Tests only: connects to the running server. Absent: a stdio MCP client of a new `npx` wazap. */
  openServerClient?: ((launch: WazapLaunch, args: string[]) => Promise<ServerClient>) | undefined;
  /** Tests only: the `owner` of an account database. Absent: a read-only `node:sqlite` read. */
  readDatabaseOwner?: ((file: string) => string | null) | undefined;
}

export interface WhatsAppAccounts {
  list(): Promise<WhatsAppAccountsSnapshot>;
  add(input: WhatsAppAccountAddInput): Promise<WhatsAppAccountsResult>;
  act(input: WhatsAppAccountActionInput): Promise<WhatsAppAccountsResult>;
  startLink(input: WhatsAppLinkInput): Promise<WhatsAppLinkState>;
  linkState(id: string): WhatsAppLinkState | null;
  cancelLink(id: string): Promise<void>;
  dispose(): Promise<void>;
}

interface LinkSession {
  state: WhatsAppLinkState;
  /** Ends the child or the MCP client. A no-op once the session ended. */
  stop: () => Promise<void>;
  ended: boolean;
}

/** The number that the account has: digits, null when it is not linked, undefined without an answer. */
type NumberProbe = () => Promise<string | null | undefined>;

async function defaultLaunch(): Promise<WazapLaunch | null> {
  const server = await Effect.runPromise(usableMcpServer(WAZAP_SERVER));
  return server.error === undefined ? { command: server.command, path: server.path } : null;
}

/** The MCP SDK's default environment and the resolved `PATH`. No `WAZAP_*` value of the app passes. */
function wazapEnvironment(launch: WazapLaunch): Record<string, string> {
  const environment: Record<string, string> = { ...getDefaultEnvironment() };
  if (launch.path) environment.PATH = launch.path;
  environment.NO_COLOR = "1";
  environment.WAZAP_NO_UPDATE_CHECK = "1";
  return environment;
}

function defaultExecute(launch: WazapLaunch, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      launch.command,
      args,
      {
        env: wazapEnvironment(launch),
        timeout: COMMAND_DEADLINE_MS,
        maxBuffer: OUTPUT_LIMIT,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ exit: 0, stdout, stderr });
        const exit =
          error.killed || error.signal === "SIGTERM"
            ? "timeout"
            : typeof error.code === "number"
              ? error.code
              : "spawn-failed";
        resolve({ exit, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function defaultStartLogin(launch: WazapLaunch, args: string[]): LoginProcess {
  const child = spawn(launch.command, args, {
    env: wazapEnvironment(launch),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    onOutput: (listener) => {
      child.stdout?.on("data", (chunk: Buffer | string) => listener(chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer | string) => listener(chunk.toString()));
    },
    onExit: (listener) => child.on("close", (code) => listener(code)),
    onError: (listener) => child.on("error", () => listener()),
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

async function defaultOpenServerClient(launch: WazapLaunch, args: string[]): Promise<ServerClient> {
  const transport = new StdioClientTransport({
    command: launch.command,
    args,
    env: wazapEnvironment(launch),
    stderr: "ignore",
  });
  const client = new Client({ name: "builders-bot-whatsapp-accounts", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: COMMAND_DEADLINE_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return {
    callTool: (name, toolArgs, timeout) => client.callTool({ name, arguments: toolArgs }, undefined, { timeout }),
    close: () => client.close(),
  };
}

/**
 * The `owner` meta of an account database, or null. The database is opened read only. Without a
 * write-ahead log it opens immutable, as wazap's own readers do, so no `-wal` or `-shm` file appears
 * beside a closed database. A database that is busy, locked or of another shape gives null.
 */
function readDatabaseOwnerFile(file: string): string | null {
  if (!existsSync(file)) return null;
  const location = existsSync(`${file}-wal`) ? file : new URL(`${pathToFileURL(file).href}?immutable=1`);
  try {
    const database = new DatabaseSync(location, { readOnly: true });
    try {
      const row = database.prepare("SELECT value FROM meta WHERE key = 'owner'").get();
      return typeof row?.value === "string" ? row.value : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

function tail(text: string): string {
  return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}

function failure(
  error: WhatsAppAccountsError,
  snapshot: WhatsAppAccountsSnapshot | null = null,
): WhatsAppAccountsResult {
  return { ok: false, error, snapshot };
}

/** The number that `get_status` of the account shows; undefined when the server did not answer. */
async function numberThroughClient(client: ServerClient, id: string): Promise<string | null | undefined> {
  try {
    const result = await client.callTool("get_status", { account_id: id }, LINK_POLL_MS * 5);
    const structured =
      isDynamicRecord(result) && isDynamicRecord(result.structuredContent) ? result.structuredContent : null;
    if (structured === null) return undefined;
    const account = isDynamicRecord(structured.account) ? structured.account : null;
    return typeof account?.number === "string" && /^\d{6,15}$/.test(account.number) ? account.number : null;
  } catch {
    return undefined;
  }
}

/** The code and expiry that `link_account` returns, from its structured content. */
function pairingFromTool(result: unknown, now: number): WhatsAppLinkState {
  if (!isDynamicRecord(result)) return { phase: "failed", error: "failed" };
  if (result.isError === true) {
    const text = Array.isArray(result.content)
      ? result.content
          .map((part) => (isDynamicRecord(part) && typeof part.text === "string" ? part.text : ""))
          .join("\n")
      : "";
    return { phase: "failed", error: wazapErrorCode(text) };
  }
  const structured = isDynamicRecord(result.structuredContent) ? result.structuredContent : null;
  const code = typeof structured?.code === "string" ? structured.code.toUpperCase() : "";
  if (!WHATSAPP_PAIRING_CODE_PATTERN.test(code)) return { phase: "failed", error: "failed" };
  const expires = typeof structured?.expires_at === "string" ? Date.parse(structured.expires_at) : Number.NaN;
  return { phase: "code", code, expiresAt: Number.isFinite(expires) ? expires : now + PAIRING_MS };
}

export function createWhatsAppAccounts(options: WhatsAppAccountsOptions): WhatsAppAccounts {
  const now = options.now ?? Date.now;
  const resolveLaunch = options.resolveLaunch ?? defaultLaunch;
  const execute = options.execute ?? defaultExecute;
  const startLogin = options.startLogin ?? defaultStartLogin;
  const openServerClient = options.openServerClient ?? defaultOpenServerClient;
  const readDatabaseOwner = options.readDatabaseOwner ?? readDatabaseOwnerFile;
  const dataDirArgs = options.dataDir === undefined ? [] : [`--data-dir=${options.dataDir}`];
  const sessions = new Map<string, LinkSession>();
  let queue: Promise<unknown> = Promise.resolve();

  /** One CLI call at a time, so two account changes never write `accounts.json` together. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  /** The launch, or why the panel cannot run wazap on this computer. */
  async function launchOrError(): Promise<WazapLaunch | WhatsAppAccountsError> {
    // `npx` is a `.cmd` file on Windows, which `spawn` cannot start without a shell.
    if (options.platform === "win32") return "unsupported-platform";
    try {
      return (await resolveLaunch()) ?? "command-not-found";
    } catch {
      return "command-not-found";
    }
  }

  function run(command: WazapCommand): Promise<CommandResult | WhatsAppAccountsError> {
    return serial(async () => {
      const launch = await launchOrError();
      if (typeof launch === "string") return launch;
      const result = await execute(launch, wazapArgs(command, options.dataDir));
      if (result.exit !== 0) {
        logger.warn("A wazap command failed.", {
          command: command.kind,
          exit: String(result.exit),
          output: redactWazapText(`${result.stderr}\n${result.stdout}`).slice(-400),
        });
      }
      return result;
    });
  }

  /** The data folder that wazap reads, when it is a full path. */
  function dataDirOf(status: WazapStatus): string | null {
    const dataDir = options.dataDir ?? status.dataDir;
    return dataDir && isAbsolute(dataDir) ? dataDir : null;
  }

  /**
   * The `owner` of each database that an account keeps with no `owner` in `accounts.json`, as after
   * an unlink. Only main reads it: the status report does not give it.
   */
  function withDatabaseOwners(status: WazapStatus): WazapStatus {
    const dataDir = dataDirOf(status);
    if (dataDir === null) return status;
    const accounts = status.accounts.map((row) => {
      if (row.number !== null || row.ownerNumber !== null || status.storage.get(row.id)?.state === "absent") return row;
      const owner = readDatabaseOwner(join(dataDir, "accounts", row.id, "wazap.sqlite"));
      return { ...row, databaseOwner: owner === null ? null : ownerDigits(owner) };
    });
    return { ...status, accounts };
  }

  async function readStatus(): Promise<WazapStatus | WhatsAppAccountsError> {
    const result = await run({ kind: "status" });
    if (typeof result === "string") return result;
    if (result.exit === "timeout") return "timeout";
    if (result.exit === "spawn-failed") return "command-not-found";
    const status = parseWazapStatus(result.stdout);
    return status === null ? wazapErrorCode(result.stderr) : withDatabaseOwners(status);
  }

  /** A text file of the data folder, read only, or null. wazap writes these files. */
  async function readDataFile(status: WazapStatus, name: string): Promise<string | null> {
    const dataDir = dataDirOf(status);
    if (dataDir === null) return null;
    try {
      return await readFile(join(dataDir, name), "utf8");
    } catch {
      return null;
    }
  }

  async function snapshotOf(status: WazapStatus): Promise<WhatsAppAccountsSnapshot> {
    const [registry, environment] = await Promise.all([
      readDataFile(status, "accounts.json"),
      readDataFile(status, ".env"),
    ]);
    const writes = registry === null ? new Map<string, boolean>() : parseWritesFlags(registry);
    return {
      status: "ready",
      serverRunning: status.serverPid !== null,
      globalReadOnly: environment !== null && parseGlobalReadOnly(environment),
      accounts: status.accounts.map((row) =>
        toWhatsAppAccount(row, status.storage.get(row.id), writes.get(row.id), linking(row.id)),
      ),
    };
  }

  function linking(id: string): boolean {
    const session = sessions.get(id);
    return session !== undefined && !session.ended && ["starting", "code", "qr"].includes(session.state.phase);
  }

  async function list(): Promise<WhatsAppAccountsSnapshot> {
    const status = await readStatus();
    return typeof status === "string" ? { status: "unavailable", error: status } : snapshotOf(status);
  }

  async function settle(result: CommandResult | WhatsAppAccountsError): Promise<WhatsAppAccountsResult> {
    if (typeof result === "string") return failure(result);
    const snapshot = await list();
    if (result.exit === "timeout") return failure("timeout", snapshot);
    if (result.exit === "spawn-failed") return failure("command-not-found", snapshot);
    if (result.exit !== 0) return failure(wazapErrorCode(`${result.stderr}\n${result.stdout}`), snapshot);
    return { ok: true, snapshot, notice: wazapNotice(`${result.stderr}\n${result.stdout}`) };
  }

  async function add(input: WhatsAppAccountAddInput): Promise<WhatsAppAccountsResult> {
    const status = await readStatus();
    if (typeof status === "string") return failure(status);
    if (status.accounts.some((row) => row.id === input.id)) return failure("id-taken", await snapshotOf(status));
    if (input.phone !== null && numberInUse(status.accounts, null, input.phone.slice(1))) {
      return failure("number-in-use", await snapshotOf(status));
    }
    const result = await run({ kind: "add", id: input.id, name: input.name });
    if (typeof result !== "string" && result.exit === 0 && parseWazapAdd(result.stdout)?.created === false) {
      return failure("id-taken", await list());
    }
    return settle(result);
  }

  function commandFor(input: WhatsAppAccountActionInput): WazapCommand {
    switch (input.action) {
      case "enable":
      case "disable":
      case "default":
      case "remove":
        return { kind: "account", verb: input.action, id: input.id };
      case "read-only":
        return { kind: "writes", id: input.id, on: false };
      case "writable":
        return { kind: "writes", id: input.id, on: true };
      case "unlink":
        return { kind: "logout", id: input.id };
    }
  }

  async function act(input: WhatsAppAccountActionInput): Promise<WhatsAppAccountsResult> {
    // The decoder already refuses this; a second check keeps a future caller from skipping it.
    if (isDestructiveWhatsAppAction(input.action) && input.confirm !== input.id) return failure("failed");
    const status = await readStatus();
    if (typeof status === "string") return failure(status);
    if (!status.accounts.some((row) => row.id === input.id))
      return failure("account-not-found", await snapshotOf(status));
    if (input.action === "unlink" || input.action === "remove") await cancelLink(input.id, true);
    return settle(await run(commandFor(input)));
  }

  function linkState(id: string): WhatsAppLinkState | null {
    return sessions.get(id)?.state ?? null;
  }

  async function cancelLink(id: string, force = false): Promise<void> {
    const session = sessions.get(id);
    if (!session) return;
    // A linked CLI pairing still syncs the history; it ends by itself.
    if (session.state.phase === "linked" && !force) {
      sessions.delete(id);
      return;
    }
    sessions.delete(id);
    await session.stop();
  }

  function begin(id: string): LinkSession {
    const session: LinkSession = { state: { phase: "starting" }, stop: async () => {}, ended: false };
    sessions.set(id, session);
    return session;
  }

  /** Sets the end state of a session that the user did not cancel. */
  function finish(session: LinkSession, state: WhatsAppLinkState) {
    if (session.ended) return;
    session.ended = true;
    session.state = state;
  }

  /** The number that `status --json` shows for the account; undefined when it cannot be read. */
  async function numberInStatus(id: string): Promise<string | null | undefined> {
    const status = await readStatus();
    if (typeof status === "string") return undefined;
    return status.accounts.find((account) => account.id === id)?.number ?? null;
  }

  /**
   * Asks until the account has a number, or the code expired. The pairing itself runs in the server
   * that holds the data folder. `probe` asks that server over the open client, which starts no
   * process; when it cannot answer, `status --json` does. Any number ends the wait: the WhatsApp id
   * of a number can differ from the typed one (a Brazilian mobile number without its ninth digit),
   * and a number that is not the same one is shown as a warning, not as an expired code.
   */
  function watchLink(id: string, session: LinkSession, phoneDigits: string, probe: NumberProbe) {
    const current = () => !session.ended && sessions.get(id) === session;
    const tick = async () => {
      if (!current()) return;
      const answer = await probe();
      const number = answer === undefined ? await numberInStatus(id) : answer;
      if (!current()) return;
      if (typeof number === "string") {
        finish(session, { phase: "linked", otherNumber: !sameWhatsAppNumber(number, phoneDigits) });
        await session.stop();
        return;
      }
      const expiresAt = session.state.phase === "code" ? session.state.expiresAt : now() + PAIRING_MS;
      if (now() > expiresAt + EXPIRY_GRACE_MS) {
        finish(session, { phase: "expired" });
        await session.stop();
        return;
      }
      setTimeout(() => void tick(), LINK_POLL_MS).unref?.();
    };
    setTimeout(() => void tick(), LINK_POLL_MS).unref?.();
  }

  /** `link_account` through a new MCP client, which joins the running server as a bridge. */
  async function linkThroughServer(launch: WazapLaunch, id: string, phone: string, session: LinkSession) {
    let client: ServerClient | null = null;
    let closed = false;
    session.stop = async () => {
      if (closed) return;
      closed = true;
      await client?.close().catch(() => undefined);
    };
    try {
      client = await openServerClient(launch, [...WAZAP_NPX_ARGS, ...dataDirArgs]);
      if (closed) {
        await client.close().catch(() => undefined);
        return;
      }
      const open = client;
      const result = await open.callTool("link_account", { phone, account_id: id }, COMMAND_DEADLINE_MS);
      if (session.ended || sessions.get(id) !== session) return;
      const state = pairingFromTool(result, now());
      if (state.phase === "failed") {
        finish(session, state);
        await session.stop();
        return;
      }
      session.state = state;
      // The client stays open until the link ends: if this process became the server that holds
      // the folder, closing it would stop the pairing.
      watchLink(id, session, phone.slice(1), () => numberThroughClient(open, id));
    } catch {
      logger.warn("WhatsApp pairing through the running server failed.");
      finish(session, { phase: "failed", error: "failed" });
      await session.stop();
    }
  }

  /** `wazap login`: it pairs, syncs the history and exits. Only when no server holds the folder. */
  function linkThroughCli(launch: WazapLaunch, input: WhatsAppLinkInput, session: LinkSession, retry: () => void) {
    const command: WazapCommand =
      input.method === "code" && input.phone !== null
        ? { kind: "login-code", id: input.id, phone: input.phone }
        : { kind: "login-qr", id: input.id };
    let login: LoginProcess;
    try {
      login = startLogin(launch, wazapArgs(command, options.dataDir));
    } catch {
      finish(session, { phase: "failed", error: "command-not-found" });
      return;
    }
    let output = "";
    let firstShownAt: number | null = null;
    const deadline = setTimeout(() => login.stop(), LOGIN_DEADLINE_MS);
    deadline.unref?.();
    session.stop = async () => {
      clearTimeout(deadline);
      login.stop();
    };
    login.onOutput((chunk) => {
      output = tail(output + chunk);
      if (session.ended) return;
      const progress = parseWazapLogin(output);
      if (progress.linked) {
        finish(session, { phase: "linked", otherNumber: false });
        return;
      }
      firstShownAt ??= progress.code || progress.qr ? now() : null;
      const expiresAt = (firstShownAt ?? now()) + PAIRING_MS;
      if (progress.code) session.state = { phase: "code", code: progress.code, expiresAt };
      else if (progress.qr) session.state = { phase: "qr", rows: progress.qr, expiresAt };
    });
    login.onError(() => {
      clearTimeout(deadline);
      finish(session, { phase: "failed", error: "command-not-found" });
    });
    login.onExit((code) => {
      clearTimeout(deadline);
      if (session.ended || sessions.get(input.id) !== session) return;
      if (code === 0) return finish(session, { phase: "linked", otherNumber: false });
      const error = wazapErrorCode(output);
      logger.warn("wazap login ended without a link.", {
        exit: String(code),
        output: redactWazapText(output).slice(-400),
      });
      // A server started after the status read: the running server pairs the code instead.
      if (error === "server-busy" && input.method === "code") return retry();
      const shown = session.state.phase === "code" || session.state.phase === "qr";
      if (shown && "expiresAt" in session.state && now() >= session.state.expiresAt - 5_000) {
        return finish(session, { phase: "expired" });
      }
      finish(session, { phase: "failed", error });
    });
  }

  async function startLink(input: WhatsAppLinkInput): Promise<WhatsAppLinkState> {
    await cancelLink(input.id, true);
    const launch = await launchOrError();
    if (typeof launch === "string") return { phase: "failed", error: launch };
    const status = await readStatus();
    if (typeof status === "string") return { phase: "failed", error: status };
    if (input.method === "code" && input.phone === null) return { phase: "failed", error: "invalid-phone" };
    // A QR code cannot say which number links, so an account that belonged to a number, or that keeps
    // the history of one, takes a code. A number that came with a QR request says nothing.
    const phoneDigits = input.method === "code" ? (input.phone?.slice(1) ?? null) : null;
    let refusal = linkRefusal(status.accounts, status.storage, input.id, phoneDigits);
    if (refusal === null && input.method === "qr" && status.serverPid !== null) refusal = "qr-needs-free-folder";
    if (refusal !== null) return { phase: "failed", error: refusal };
    const session = begin(input.id);
    const phone = input.phone;
    const throughServer = () => {
      if (phone === null || session.ended || sessions.get(input.id) !== session) return;
      void linkThroughServer(launch, input.id, phone, session);
    };
    if (input.method === "code" && status.serverPid !== null) throughServer();
    else linkThroughCli(launch, input, session, throughServer);
    return session.state;
  }

  async function dispose(): Promise<void> {
    const open = [...sessions.values()];
    sessions.clear();
    await Promise.all(
      open.map(async (session) => {
        session.ended = true;
        await session.stop();
      }),
    );
  }

  return { list, add, act, startLink, linkState, cancelLink: (id) => cancelLink(id), dispose };
}
