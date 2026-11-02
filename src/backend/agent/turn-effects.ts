/**
 * The effect journal of a running turn: what each tool step of the turn can change, and whether it
 * ended with a result. After a brief provider failure in the middle of a channel task, the safe
 * resume (`docs/architecture/agents.md#safe-turn-resume`) reads it to decide whether the turn can
 * continue by itself without doing an action twice.
 *
 * The journal only observes. It keeps no text of a message or of a tool result: a step keeps a short
 * name (`git push`, `openbot.channel_result`), its redacted command for the provider, and, for the
 * app's own tools, a digest of the arguments.
 */
import { createHash } from "node:crypto";
import { COMPUTER_USE_MCP_SERVER_NAME } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { redactText } from "@openbot/logging";
import { OPENBOT_BROWSER_NAMESPACE } from "../browser-tools";
import { HUB_CONNECTIONS_NAMESPACE } from "../hub-connections/hub-connection-tool-definitions";
import { bridgedToolName, getRecord, getString, type ThreadItem } from "../protocol";
import { classifyCommand, type EffectReach, strongerReach } from "./command-effects";

export type { EffectReach } from "./command-effects";

/**
 * `done`: it ended with a result. `failed`: it ended with a failure that the tool reported, so it did
 * not happen. `uncertain`: it started and has no result, or it ended in a way that does not say whether
 * the action reached the other side (a timeout, a lost connection, an interrupt).
 */
export type EffectState = "done" | "failed" | "uncertain";

export interface TurnEffect {
  /** The provider's id of the step. */
  id: string;
  reach: EffectReach;
  state: EffectState;
  /** A short name with no arguments, safe to show to a person and to store: `git push`, `openbot.channel_result`. */
  label: string;
  /** The redacted command of a shell step, for the provider only. Never stored outside the delivery. */
  detail: string | null;
  /** A read-only command that shows whether the step already ran, or null. */
  check: string | null;
  /** The app's own tool, as `namespace.tool`, or null. */
  ownTool: string | null;
}

/** The app's own tools, by what they change. A tool that is not listed is `external`. */
const OWN_READ: ReadonlySet<string> = new Set(
  (
    "list_agents read_agent list_models list_routines list_sections list_sites list_api_keys list_capture_sources " +
    "capture_screen search_memories list_memories history_search history_read channel_history channel_list_routines " +
    "messaging_history messaging_list_places list_tables query_data list_local_skills read_local_skill " +
    "list_mcp_servers test_mcp_server list_routine_flows html_preview tool_search tool_describe"
  ).split(" "),
);
const OWN_LOCAL: ReadonlySet<string> = new Set(
  (
    "remember forget_memory set_memory_inclusion channel_remember channel_forget_memory messaging_remember " +
    "messaging_forget_memory create_section rename_section delete_section assign_agent_section update_profile " +
    "html_render attach_files_to_response react_to_user_message acknowledge_request ask_user ask_ui " +
    "suggest_marketplace_app request_api_key remove_api_key create_skill revise_skill install_local_skill " +
    "set_skill_enabled uninstall_skill save_mcp_server set_mcp_server_enabled remove_mcp_server execute_data " +
    "delete_table create_routine update_routine delete_routine connect_routine_agents disconnect_routine_agents " +
    "channel_set_instructions channel_add_member channel_remove_member channel_create_routine " +
    "channel_update_routine channel_delete_routine start_new_chat routine_no_update routine_report_failure"
  ).split(" "),
);
const BROWSER_READ: ReadonlySet<string> = new Set(
  "snapshot screenshot status list_tabs wait_for list_logins list_vault_items hover scroll open navigate".split(" "),
);
const BROWSER_LOCAL: ReadonlySet<string> = new Set(
  "recording_start recording_stop close_tab set_environment use_site_session save_vault_item delete_vault_item request_takeover".split(
    " ",
  ),
);

const CLAUDE_READ: ReadonlySet<string> = new Set(
  "Read Glob Grep LS NotebookRead WebSearch WebFetch BashOutput Skill ToolSearch ListMcpResourcesTool ReadMcpResourceTool".split(
    " ",
  ),
);
const CLAUDE_LOCAL: ReadonlySet<string> = new Set(
  "Edit MultiEdit Write NotebookEdit TodoWrite KillShell KillBash ExitPlanMode EnterPlanMode AskUserQuestion".split(
    " ",
  ),
);

const PI_READ: ReadonlySet<string> = new Set(["read", "ls", "grep", "find"]);
const PI_LOCAL: ReadonlySet<string> = new Set(["edit", "write"]);

// An ACP `fetch` is the agent's own word for its tool, which can send data: it is not a read.
const ACP_READ: ReadonlySet<string> = new Set(["read", "search", "think"]);
const ACP_LOCAL: ReadonlySet<string> = new Set(["edit", "delete", "move", "switch_mode"]);

interface Kind {
  reach: EffectReach;
  label: string;
  detail: string | null;
  check: string | null;
  ownTool: string | null;
}

const DETAIL_LIMIT = 240;
const LABEL_LIMIT = 80;

function own(namespace: string, tool: string): Kind {
  const name = `${namespace}.${tool}`.slice(0, LABEL_LIMIT);
  const kind = (reach: EffectReach, check: string | null = null): Kind => ({
    reach,
    label: name,
    detail: null,
    check,
    ownTool: name,
  });
  if (namespace === "openbot") {
    if (OWN_READ.has(tool)) return kind("read");
    if (OWN_LOCAL.has(tool)) return kind("local");
    return kind("external");
  }
  if (namespace === OPENBOT_BROWSER_NAMESPACE) {
    if (BROWSER_READ.has(tool)) return kind("read");
    if (BROWSER_LOCAL.has(tool)) return kind("local");
    // A click or typed text can send a form, a message or a payment.
    return kind("external", `${OPENBOT_BROWSER_NAMESPACE}.snapshot`);
  }
  if (namespace === HUB_CONNECTIONS_NAMESPACE) return kind(tool === "list" ? "read" : "external");
  return kind("external");
}

function command(text: string): Kind {
  const effect = classifyCommand(text);
  return {
    reach: effect.reach,
    label: effect.label.slice(0, LABEL_LIMIT),
    detail: redactText(text.trim()).slice(0, DETAIL_LIMIT),
    check: effect.check,
    ownTool: null,
  };
}

const external = (label: string): Kind => ({
  reach: "external",
  label: label.slice(0, LABEL_LIMIT),
  detail: null,
  check: null,
  ownTool: null,
});
const plain = (reach: EffectReach, label: string): Kind => ({ reach, label, detail: null, check: null, ownTool: null });

/** The reach of an MCP tool of `server`. Only the app's own servers are known; every other one is `external`. */
function mcpTool(server: string, tool: string): Kind {
  if (server === "openbot" || server === OPENBOT_BROWSER_NAMESPACE || server === HUB_CONNECTIONS_NAMESPACE)
    return own(server, tool);
  if (server === COMPUTER_USE_MCP_SERVER_NAME) return external(`${server}.${tool}`);
  return external(`MCP ${server}.${tool}`);
}

/**
 * The items that are not a tool step: text, thinking, the person's message, a compaction and the review
 * mode marks. Every other item, also of a kind that the app does not know, is a step.
 */
const PASSIVE_ITEMS: ReadonlySet<string> = new Set([
  "agentMessage",
  "userMessage",
  "reasoning",
  "contextCompaction",
  "enteredReviewMode",
  "exitedReviewMode",
]);

/**
 * What a tool step of any provider can change, or null for an item that is not a tool step. An item
 * of a kind that the app does not know is `external`. A command is read by this app's own reader only:
 * Codex's `commandActions` is another reader, and a difference between two readers must not make a
 * step safe.
 */
export function classifyToolItem(item: ThreadItem): Kind | null {
  if (PASSIVE_ITEMS.has(item.type)) return null;
  const bridged = bridgedToolName(item);
  if (bridged) {
    const dot = bridged.indexOf(".");
    return dot > 0 ? own(bridged.slice(0, dot), bridged.slice(dot + 1)) : external(bridged);
  }
  switch (item.type) {
    case "commandExecution": {
      const text = getString(item, "command") ?? "";
      return text ? command(text) : external("command");
    }
    case "fileChange":
      return plain("local", "file change");
    case "webSearch":
      return plain("read", "web search");
    case "imageView":
      return plain("read", "image view");
    case "imageGeneration":
    case "image_generation_call":
      return plain("local", "image generation");
    case "collabAgentToolCall":
      // A subagent runs tools that this journal does not see.
      return external("subagent");
    case "mcpToolCall":
      return mcpTool(getString(item, "server") ?? "", getString(item, "tool") ?? "");
    case "dynamicToolCall": {
      const tool = getString(item, "tool") ?? "";
      const namespace = getString(item, "namespace");
      if (namespace) return own(namespace, tool);
      // Pi names its built-in tools with no namespace; the app's own tools keep theirs.
      if (PI_READ.has(tool)) return plain("read", tool);
      if (PI_LOCAL.has(tool)) return plain("local", tool);
      if (tool === "bash") {
        const text = getString(getRecord(item, "arguments"), "command");
        return text ? command(text) : external("bash");
      }
      return own("openbot", tool);
    }
    case "toolCall":
      return toolCall(item);
    default:
      // A computer action, or an item of a kind that the app does not know.
      return external(item.type || "step");
  }
}

/** A Claude or ACP tool step. */
function toolCall(item: ThreadItem): Kind {
  const name = getString(item, "name") ?? "";
  const acpKind = getString(item, "toolKind");
  if (acpKind !== null) {
    if (ACP_READ.has(acpKind)) return plain("read", acpKind);
    if (ACP_LOCAL.has(acpKind)) return plain("local", acpKind);
    if (acpKind === "execute") {
      const input = getRecord(item, "arguments");
      const text = getString(input, "command") ?? getString(item, "command");
      return text ? command(text) : external("command");
    }
    return external(acpKind);
  }
  if (name === "Bash") {
    const text = getString(item, "command");
    return text ? command(text) : external("Bash");
  }
  if (CLAUDE_READ.has(name)) return plain("read", name);
  if (CLAUDE_LOCAL.has(name)) return plain("local", name);
  if (name === "Task" || name === "Agent") return external("subagent");
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(name);
  // A server name can contain `__`; such a name is a user's server, never one of the app's.
  if (mcp?.[1] && mcp[2]) return mcp[2].includes("__") ? external(`MCP ${name}`) : mcpTool(mcp[1], mcp[2]);
  return external(name || "tool");
}

/** Statuses of a step that has no result yet, or whose run stopped part way. */
const OPEN_STATUSES: ReadonlySet<string> = new Set([
  "inProgress",
  "in_progress",
  "pending",
  "running",
  "interrupted",
  "cancelled",
  "canceled",
]);

/**
 * The state of a step from its last event. It fails closed: an outside step is `failed` only when it
 * did not run (`declined`). An outside step that ended with an error or an exit code other than 0 is
 * `uncertain`, because the error does not prove that nothing happened: `curl … && false` posted, a push
 * can land before the connection drops, and a tool can fail after part of a post. Only a read or a local
 * change that failed is `failed`.
 */
function stateOf(item: ThreadItem, completed: boolean, reach: EffectReach): EffectState {
  // Claude ends a call with no result as completed when the turn ends (`unanswered`).
  if (!completed || item.unanswered === true) return "uncertain";
  const status = getString(item, "status");
  if (status === "declined") return "failed";
  if (status !== null && OPEN_STATUSES.has(status)) return "uncertain";
  const exitCode = item.exitCode;
  const failed = (status !== null && status !== "completed") || (typeof exitCode === "number" && exitCode !== 0);
  if (!failed) return "done";
  return reach === "external" ? "uncertain" : "failed";
}

/** The steps of each running turn, in the order they started. */
export class TurnEffects {
  readonly #turns = new Map<string, Map<string, TurnEffect>>();

  begin(turnId: string): void {
    this.#turns.set(turnId, new Map());
  }

  /** Records an item event of a running turn. Only tool steps count. */
  observe(turnId: string, item: ThreadItem, completed: boolean): void {
    const steps = this.#turns.get(turnId);
    if (!steps) return;
    const kind = classifyToolItem(item);
    if (!kind) return;
    // A step with no id cannot be matched to its end, so each of its events counts on its own.
    const id = isString(item.id) && item.id ? item.id : `step-without-id-${steps.size}`;
    const previous = steps.get(id);
    // A later event can name what an earlier one did not, as the command of a Claude Bash step.
    const reach = previous ? strongerReach(previous.reach, kind.reach) : kind.reach;
    const known = previous && previous.label !== "command" && previous.label !== "Bash" ? previous : null;
    // A step that ended keeps its end: a late "started" event does not open it again.
    const state =
      previous && previous.state !== "uncertain" && !completed ? previous.state : stateOf(item, completed, reach);
    if (!previous && steps.size >= JOURNAL_LIMIT) return;
    steps.set(id, {
      id,
      reach,
      state,
      label: known?.label ?? kind.label,
      detail: known?.detail ?? kind.detail,
      check: known?.check ?? kind.check,
      ownTool: kind.ownTool ?? previous?.ownTool ?? null,
    });
  }

  /** The steps of a running turn so far. */
  peek(turnId: string): TurnEffect[] {
    return [...(this.#turns.get(turnId)?.values() ?? [])];
  }

  /** The steps of a turn that ends now. It removes the turn. */
  take(turnId: string): TurnEffect[] {
    const steps = this.peek(turnId);
    this.#turns.delete(turnId);
    return steps;
  }

  drop(turnId: string): void {
    this.#turns.delete(turnId);
  }

  clear(): void {
    this.#turns.clear();
  }
}

/** The most steps that one turn keeps. A turn with more is not resumed by itself. */
export const JOURNAL_LIMIT = 500;

/**
 * One call to an app's own outside tool (`OWN_EXTERNAL_TOOLS`), as the app's tool router saw it. The
 * router is the only place that runs these tools for every provider, so this record, and not the
 * provider's item, says whether the action ran: a call that the provider announced and never sent has
 * no record, and a call whose handler returned is `done` or `failed`. `started` is a call whose handler
 * did not return before the turn ended.
 */
export interface OwnToolCall {
  tool: string;
  digest: string;
  state: "started" | "done" | "failed";
}

/** The calls to the app's own outside tools of each running turn. */
export class OwnToolCalls {
  readonly #turns = new Map<string, Map<string, OwnToolCall>>();

  started(turnId: string, callId: string, tool: string, digest: string): void {
    let calls = this.#turns.get(turnId);
    if (!calls) {
      // A turn that never ends here, such as one of a stopped client, must not keep its calls for good.
      if (this.#turns.size >= OWN_CALL_TURN_LIMIT) {
        const oldest = this.#turns.keys().next().value;
        if (oldest !== undefined) this.#turns.delete(oldest);
      }
      calls = new Map();
      this.#turns.set(turnId, calls);
    }
    if (calls.size < JOURNAL_LIMIT) calls.set(callId, { tool, digest, state: "started" });
  }

  ended(turnId: string, callId: string, ok: boolean): void {
    const call = this.#turns.get(turnId)?.get(callId);
    if (call) call.state = ok ? "done" : "failed";
  }

  /** The calls of a turn that ends now. It removes the turn. */
  take(turnId: string): OwnToolCall[] {
    const calls = [...(this.#turns.get(turnId)?.values() ?? [])];
    this.#turns.delete(turnId);
    return calls;
  }

  clear(): void {
    this.#turns.clear();
  }
}

const OWN_CALL_TURN_LIMIT = 200;

/**
 * The digest of the arguments of one call to the app's own tool. Keys are sorted, so the same
 * arguments in another order are the same call. It holds no text of the arguments.
 */
export function ownCallDigest(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(`${tool}\u0000${canonicalJson(args)}`)
    .digest("hex")
    .slice(0, 32);
}

/** JSON with the keys of each object sorted and each string trimmed. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isDynamicRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(isString(value) ? value.trim() : value) ?? "null";
}
