// The WhatsApp accounts panel's service: it runs the pinned wazap CLI on this computer and runs one
// pairing per account. See docs/architecture/whatsapp-accounts.md.
//
// The service owns child processes and timers that outlive a request, so it uses plain promises and
// one serial queue for the CLI, not an Effect runtime. `dispose` ends every child it started.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
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
import { isDestructiveWhatsAppAction, WHATSAPP_PAIRING_CODE_PATTERN } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createBuildersBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { usableMcpServer } from "../backend/mcp-provider-shapes";
import {
  linkRefusal,
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

export interface WhatsAppAccountsOptions {
  platform: NodeJS.Platform;
  /** Tests only. The app leaves it out, so wazap uses `~/.wazap`, as the plugin's server does. */
  dataDir?: string | undefined;
  /** Finds `npx`. Absent: the provider lookup (`usableMcpServer`). */
  resolveLaunch?: (() => Promise<WazapLaunch | null>) | undefined;
  now?: (() => number) | undefined;
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

interface CommandResult {
  exit: number | "timeout" | "spawn-failed";
  stdout: string;
  stderr: string;
}

interface LinkSession {
  state: WhatsAppLinkState;
  /** Ends the child or the MCP client. A no-op once the session ended. */
  stop: () => Promise<void>;
  ended: boolean;
}

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

function tail(text: string): string {
  return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}

function failure(
  error: WhatsAppAccountsError,
  snapshot: WhatsAppAccountsSnapshot | null = null,
): WhatsAppAccountsResult {
  return { ok: false, error, snapshot };
}

/** Whether `get_status` of the account shows the number; null when the server did not answer. */
async function linkedThroughClient(client: Client, id: string, phoneDigits: string): Promise<boolean | null> {
  try {
    const result = await client.callTool({ name: "get_status", arguments: { account_id: id } }, undefined, {
      timeout: LINK_POLL_MS * 5,
    });
    const structured = isDynamicRecord(result.structuredContent) ? result.structuredContent : null;
    const account = structured && isDynamicRecord(structured.account) ? structured.account : null;
    return account?.number === phoneDigits;
  } catch {
    return null;
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
  const sessions = new Map<string, LinkSession>();
  let queue: Promise<unknown> = Promise.resolve();

  /** One CLI call at a time, so two account changes never write `accounts.json` together. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  function execute(launch: WazapLaunch, command: WazapCommand): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        launch.command,
        wazapArgs(command, options.dataDir),
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
      const result = await execute(launch, command);
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

  async function readStatus(): Promise<WazapStatus | WhatsAppAccountsError> {
    const result = await run({ kind: "status" });
    if (typeof result === "string") return result;
    if (result.exit === "timeout") return "timeout";
    if (result.exit === "spawn-failed") return "command-not-found";
    const status = parseWazapStatus(result.stdout);
    return status ?? wazapErrorCode(result.stderr);
  }

  /** The `writes` flag of each account. `accounts.json` is only read here; wazap writes it. */
  async function writesFlags(status: WazapStatus): Promise<ReadonlyMap<string, boolean>> {
    const dataDir = options.dataDir ?? status.dataDir;
    if (!dataDir || !isAbsolute(dataDir)) return new Map();
    try {
      return parseWritesFlags(await readFile(join(dataDir, "accounts.json"), "utf8"));
    } catch {
      return new Map();
    }
  }

  async function snapshotOf(status: WazapStatus): Promise<WhatsAppAccountsSnapshot> {
    const writes = await writesFlags(status);
    return {
      status: "ready",
      serverRunning: status.serverPid !== null,
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
    if (input.phone !== null) {
      const digits = input.phone.slice(1);
      if (status.accounts.some((row) => row.number === digits || row.ownerNumber === digits)) {
        return failure("number-in-use", await snapshotOf(status));
      }
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

  /** Whether `status --json` shows the account linked to the number; null when it cannot be read. */
  async function linkedInStatus(id: string, phoneDigits: string): Promise<boolean | null> {
    const status = await readStatus();
    if (typeof status === "string") return null;
    return status.accounts.find((account) => account.id === id)?.number === phoneDigits;
  }

  /**
   * Asks until the account has the number, or the code expired. The pairing itself runs in the
   * server that holds the data folder. `probe` asks that server over the open client, which starts no
   * process; when it cannot answer, `status --json` does.
   */
  function watchLink(id: string, session: LinkSession, phoneDigits: string, probe: () => Promise<boolean | null>) {
    const tick = async () => {
      if (session.ended || sessions.get(id) !== session) return;
      const linked = (await probe()) ?? (await linkedInStatus(id, phoneDigits));
      if (session.ended || sessions.get(id) !== session) return;
      if (linked) {
        finish(session, { phase: "linked" });
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

  /** `link_account` through a new stdio client, which joins the running server as a bridge. */
  async function linkThroughServer(launch: WazapLaunch, id: string, phone: string, session: LinkSession) {
    const transport = new StdioClientTransport({
      command: launch.command,
      args: [...WAZAP_NPX_ARGS, ...(options.dataDir === undefined ? [] : [`--data-dir=${options.dataDir}`])],
      env: wazapEnvironment(launch),
      stderr: "ignore",
    });
    const client = new Client({ name: "builders-bot-whatsapp-accounts", version: "1.0.0" });
    let closed = false;
    session.stop = async () => {
      if (closed) return;
      closed = true;
      await client.close().catch(() => undefined);
    };
    try {
      await client.connect(transport, { timeout: COMMAND_DEADLINE_MS });
      const result = await client.callTool({ name: "link_account", arguments: { phone, account_id: id } }, undefined, {
        timeout: COMMAND_DEADLINE_MS,
      });
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
      const digits = phone.slice(1);
      watchLink(id, session, digits, () => linkedThroughClient(client, id, digits));
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
    let child: ChildProcess;
    try {
      child = spawn(launch.command, wazapArgs(command, options.dataDir), {
        env: wazapEnvironment(launch),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      finish(session, { phase: "failed", error: "command-not-found" });
      return;
    }
    let output = "";
    let firstShownAt: number | null = null;
    const deadline = setTimeout(() => child.kill("SIGTERM"), LOGIN_DEADLINE_MS);
    deadline.unref?.();
    session.stop = async () => {
      clearTimeout(deadline);
      // SIGTERM lets wazap free the lock of the data folder.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    const read = (chunk: Buffer | string) => {
      output = tail(output + chunk.toString());
      if (session.ended) return;
      const progress = parseWazapLogin(output);
      if (progress.linked) {
        finish(session, { phase: "linked" });
        return;
      }
      firstShownAt ??= progress.code || progress.qr ? now() : null;
      const expiresAt = (firstShownAt ?? now()) + PAIRING_MS;
      if (progress.code) session.state = { phase: "code", code: progress.code, expiresAt };
      else if (progress.qr) session.state = { phase: "qr", rows: progress.qr, expiresAt };
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", () => {
      clearTimeout(deadline);
      finish(session, { phase: "failed", error: "command-not-found" });
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (session.ended || sessions.get(input.id) !== session) return;
      if (code === 0) return finish(session, { phase: "linked" });
      const error = wazapErrorCode(output);
      logger.warn("wazap login ended without a link.", {
        exit: String(code),
        output: redactWazapText(output).slice(-400),
      });
      // A server started after the status read: the running server pairs the code instead.
      if (error === "server-running" && input.method === "code") return retry();
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
    const target = status.accounts.find((row) => row.id === input.id);
    let refusal: WhatsAppAccountsError | null;
    if (input.method === "code") {
      refusal = input.phone === null ? "invalid-phone" : linkRefusal(status.accounts, input.id, input.phone.slice(1));
    } else {
      // A QR cannot say which number links, so an account that belonged to a number takes a code.
      refusal = linkRefusal(status.accounts, input.id, target?.ownerNumber ?? "");
      if (refusal === null && target?.ownerNumber) refusal = "owner-mismatch";
      if (refusal === null && status.serverPid !== null) refusal = "server-running";
    }
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
