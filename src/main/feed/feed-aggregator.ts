/**
 * The cards of the feed, built from the agent events that the main process already forwards and from
 * the load of this computer. Plain TypeScript with no Electron and no file access, so an E2E script
 * runs it with Bun. `FeedService` adds the batch timer and the windows.
 *
 * What a card can hold is decided here, and only here: the step summaries that a turn shows already,
 * the program name of an approval, the first question of a prompt, the names of the agent, its
 * section and its channel, and a stop reason. Every text is cleaned, redacted and clipped. The events
 * that carry the text of a conversation (`conversation*`, `agent-task-conversation*`) and the browser
 * events are not read at all.
 */

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AgentApproval,
  type AgentEvent,
  type AgentRuntimeSnapshot,
  FEED_CONTRACT_VERSION,
  FEED_LABEL_LIMIT,
  FEED_SNAPSHOT_LIMIT,
  FEED_STEP_LIMIT,
  FEED_TEXT_LIMIT,
  FEED_TITLE_LIMIT,
  type FeedItem,
  type FeedItemState,
  type FeedStep,
  type RunningWork,
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarLayoutSnapshot,
  type StoppedWork,
} from "@openbot/contracts/ipc";
import { cleanAgentMessageText } from "@openbot/team-client/agent-message-text";

/** How long an ended card stays. */
export const FEED_RETAIN_MS = 24 * 60 * 60 * 1_000;
/** The most text read from one value before it is cleaned: the card shows at most `FEED_TEXT_LIMIT`. */
const RAW_TEXT_LIMIT = 2_000;
/** The most task titles kept for cards that do not exist yet. */
const TASK_TITLE_LIMIT = 2_000;
const PROJECT_NAME_LIMIT = INPUT_LIMITS.sidebarSectionName;
/** Control and format characters, such as bidirectional overrides and zero-width spaces. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
const SPACES = /\s+/gu;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const PROGRAM_NAME = /^[A-Za-z0-9._+-]{1,40}$/u;
/** The words before the program of a command that are not the program. */
const COMMAND_PREFIXES = new Set(["env", "exec", "command", "builtin", "nohup", "time"]);

export interface FeedLoadWork {
  running: readonly RunningWork[];
  stopped: readonly StoppedWork[];
}

export interface FeedAggregatorOptions {
  /** Masks the secrets of a text. It runs on every text before the text is clipped. */
  redact: (text: string) => string;
  /** The name of an agent that no event has named yet, such as an agent of this computer. */
  resolveName?: ((serverId: string, agentId: string) => string | null) | undefined;
  now?: (() => number) | undefined;
  /** The most cards. `FEED_SNAPSHOT_LIMIT` by default. */
  limit?: number | undefined;
  retainMs?: number | undefined;
}

interface ServerDirectory {
  names: Map<string, string>;
  /** The section of each agent. */
  sectionOf: Map<string, string>;
  sectionNames: Map<string, string>;
  /** The task titles of each thread, by `agentId:threadId`. */
  taskTitles: Map<string, string>;
  /** What each agent waits for outside a turn: queued messages, waits, a plan limit. */
  queues: Map<string, { queued: number; waits: number; limitResetsAt: number | null | undefined }>;
}

const OPEN_STATES: ReadonlySet<FeedItemState> = new Set(["working", "needs-you"]);
const ENDED_STATES: ReadonlySet<FeedItemState> = new Set(["done", "failed"]);

function key(...parts: Array<string | number>): string {
  return parts.join("\u0000");
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  // Do not split a surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * The program of a shell command, with no path, argument or variable: `GITHUB_TOKEN=x /usr/bin/git push`
 * is `git`. Empty when the first word does not look like a program name.
 */
export function commandProgram(command: string | null): string {
  if (!command) return "";
  for (const word of command.slice(0, RAW_TEXT_LIMIT).trim().split(SPACES)) {
    if (ENVIRONMENT_ASSIGNMENT.test(word) || COMMAND_PREFIXES.has(word)) continue;
    const name =
      word
        .replace(/^["']+|["']+$/gu, "")
        .split("/")
        .at(-1) ?? "";
    return PROGRAM_NAME.test(name) ? name : "";
  }
  return "";
}

export class FeedAggregator {
  readonly #redact: (text: string) => string;
  readonly #resolveName: FeedAggregatorOptions["resolveName"];
  readonly #now: () => number;
  readonly #limit: number;
  readonly #retainMs: number;
  /** In timeline order: the order in which each run started, the newest last. */
  readonly #cards = new Map<string, FeedItem>();
  readonly #servers = new Map<string, ServerDirectory>();
  /** The card of each running turn, by `server:turn`. */
  readonly #turns = new Map<string, string>();
  readonly #turnOfCard = new Map<string, string>();
  /** The card that each pending request is on, by `server:kind:request`. */
  readonly #requests = new Map<string, string>();
  /** The open thread cards of each agent, by `server:agent`. */
  readonly #openByAgent = new Map<string, Set<string>>();
  /** Cards of routine runs: a quiet end removes them, as it is not news. */
  readonly #routineCards = new Set<string>();
  #tracking = false;
  readonly #changed = new Set<string>();
  readonly #removed = new Set<string>();

  constructor(options: FeedAggregatorOptions) {
    this.#redact = options.redact;
    this.#resolveName = options.resolveName;
    this.#now = options.now ?? Date.now;
    this.#limit = Math.min(options.limit ?? FEED_SNAPSHOT_LIMIT, FEED_SNAPSHOT_LIMIT);
    this.#retainMs = options.retainMs ?? FEED_RETAIN_MS;
  }

  get size(): number {
    return this.#cards.size;
  }

  /**
   * Whether changes are kept for the next delta. Off while no window watches: a window reads the
   * whole feed when it starts to watch, so nothing has to wait for it.
   */
  setTracking(tracking: boolean): void {
    this.#tracking = tracking;
    if (!tracking) {
      this.#changed.clear();
      this.#removed.clear();
    }
  }

  hasChanges(): boolean {
    return this.#changed.size > 0 || this.#removed.size > 0;
  }

  /** The changed cards, at most `max`, and every removed id. The rest stay for the next call. */
  takeChanges(max: number): { upserts: FeedItem[]; removes: string[] } {
    const upserts: FeedItem[] = [];
    for (const id of this.#changed) {
      if (upserts.length >= max) break;
      this.#changed.delete(id);
      const card = this.#cards.get(id);
      if (card) upserts.push(card);
    }
    const removes = [...this.#removed].slice(0, FEED_SNAPSHOT_LIMIT);
    for (const id of removes) this.#removed.delete(id);
    return { upserts, removes };
  }

  /** The cards in timeline order, the newest last. With a limit, the newest `limit` cards. */
  items(limit = this.#limit): { items: FeedItem[]; truncated: boolean } {
    const all = [...this.#cards.values()];
    return all.length > limit
      ? { items: all.slice(all.length - limit), truncated: true }
      : { items: all, truncated: false };
  }

  ingest(serverId: string, event: AgentEvent): void {
    switch (event.type) {
      case "turn-started":
        this.#turnStarted(serverId, event.agentId, event.threadId, event.turnId, event.origin === "routine");
        return;
      case "turn-progress":
        this.#turnProgress(serverId, event.agentId, event.threadId, event.turnId, event.detail);
        return;
      case "turn-completed":
        this.#turnCompleted(serverId, event);
        return;
      case "approval":
        this.#approval(serverId, event.approval);
        return;
      case "prompt":
        this.#prompt(serverId, event.agentId, event.threadId, event.turnId, event.requestId, event.questions);
        return;
      case "agent-input-resolved":
        this.#inputResolved(serverId, event.kind, event.requestId);
        return;
      case "error":
        if (event.agentId) this.#error(serverId, event.agentId, event.message);
        return;
      case "usage-limit-reached":
        this.#queue(serverId, event.agentId).limitResetsAt = event.resetsAt;
        this.#syncQueueCard(serverId, event.agentId);
        return;
      case "runtime-snapshot":
        this.#runtimeSnapshot(serverId, event.snapshot);
        return;
      case "queue-changed":
        this.#queue(serverId, event.snapshot.agentId).queued = event.snapshot.deliveries.filter(
          (delivery) => delivery.status === "queued",
        ).length;
        this.#syncQueueCard(serverId, event.snapshot.agentId);
        return;
      case "waits-changed":
        this.#queue(serverId, event.snapshot.agentId).waits = event.snapshot.waits.length;
        this.#syncQueueCard(serverId, event.snapshot.agentId);
        return;
      case "agent-tasks-changed":
        this.#tasks(serverId, event.snapshot.agentId, event.snapshot.tasks);
        return;
      case "agents-changed":
        this.#names(
          serverId,
          event.agents.map((agent) => [agent.id, agent.name] as const),
        );
        return;
      case "sidebar-layout-changed":
        this.#layout(serverId, event.layout);
        return;
      default:
        // The text of a conversation, the browser and the settings are not news for the feed.
        return;
    }
  }

  /** The running work and the stopped channel tasks of this computer, from the load panel. */
  ingestLoad(serverId: string, work: FeedLoadWork): void {
    for (const running of work.running) {
      const id = this.#turns.get(key(serverId, running.turnId));
      const card = id ? this.#cards.get(id) : undefined;
      if (!card) continue;
      let changed = false;
      if (card.channelId !== running.channelId || card.taskId !== running.taskId) {
        card.channelId = running.channelId;
        card.taskId = running.taskId;
        changed = true;
      }
      if (running.channelName && !card.title) {
        card.title = this.#text(this.#channelTitle(running.channelName, running.topicName), FEED_TITLE_LIMIT);
        changed = card.title.length > 0 || changed;
      }
      const quiet = running.quiet ? { state: running.quiet.state, minutes: running.quiet.minutes } : undefined;
      if (card.quiet?.state !== quiet?.state || card.quiet?.minutes !== quiet?.minutes) {
        if (quiet) card.quiet = quiet;
        else delete card.quiet;
        changed = true;
      }
      if (changed) this.#touch(card);
    }
    const stoppedIds = new Set<string>();
    for (const stopped of work.stopped) {
      const id = `${serverId}:task:${stopped.taskId}`;
      stoppedIds.add(id);
      const reason = this.#text(stopped.reason, FEED_TEXT_LIMIT);
      const source = stopped.plan?.by === "reviewer" ? "task-watch" : "stopped-work";
      const existing = this.#cards.get(id);
      if (existing?.state === "stopped" && existing.stop?.reason === reason && existing.stop.source === source)
        continue;
      const card = existing ?? this.#newCard(id, serverId, stopped.agentId ?? stopped.channelId, null);
      if (!stopped.agentId)
        card.agentName = this.#text(stopped.agentName ?? stopped.channelName, INPUT_LIMITS.agentName);
      card.channelId = stopped.channelId;
      card.taskId = stopped.taskId;
      card.title = this.#text(this.#channelTitle(stopped.channelName, stopped.topicName), FEED_TITLE_LIMIT);
      card.endedAt ??= this.#iso();
      card.stop = { reason, source };
      this.#setState(card, "stopped");
      this.#touch(card);
    }
    for (const [id, card] of this.#cards) {
      if (card.serverId === serverId && id.startsWith(`${serverId}:task:`) && !stoppedIds.has(id)) this.#remove(id);
    }
  }

  /**
   * Removes the runs that ended longer than the retention ago. The cards of stopped channel tasks and
   * of queues follow the load and the queue instead.
   */
  sweep(): void {
    const cutoff = this.#now() - this.#retainMs;
    for (const [id, card] of this.#cards) {
      if (card.threadId && card.endedAt && !OPEN_STATES.has(card.state) && Date.parse(card.endedAt) < cutoff)
        this.#remove(id);
    }
  }

  #turnStarted(serverId: string, agentId: string, threadId: string, turnId: string, routine: boolean): void {
    const card = this.#threadCard(serverId, agentId, threadId);
    if (card.state !== "working" && card.state !== "needs-you") this.#reopen(card);
    if (routine) this.#routineCards.add(card.id);
    else this.#routineCards.delete(card.id);
    this.#indexTurn(serverId, card.id, turnId);
    this.#setState(card, card.need ? "needs-you" : "working");
    this.#touch(card);
    const queue = this.#servers.get(serverId)?.queues.get(agentId);
    if (queue) queue.limitResetsAt = undefined;
    this.#syncQueueCard(serverId, agentId);
  }

  #turnProgress(serverId: string, agentId: string, threadId: string, turnId: string, detail: string): void {
    const id = this.#threadId(serverId, agentId, threadId);
    let card = this.#cards.get(id);
    // A late step of a turn that ended does not open its card again.
    if (card && !OPEN_STATES.has(card.state) && this.#turnOfCard.get(id) === key(serverId, turnId)) return;
    if (!card || !OPEN_STATES.has(card.state)) {
      this.#turnStarted(serverId, agentId, threadId, turnId, false);
      card = this.#cards.get(id);
      if (!card) return;
    }
    const text = this.#text(detail, FEED_TEXT_LIMIT);
    if (!text || card.lastStep?.text === text) return;
    this.#addStep(card, { at: this.#iso(), kind: "progress", text });
    this.#touch(card);
  }

  #turnCompleted(serverId: string, event: Extract<AgentEvent, { type: "turn-completed" }>): void {
    const id = this.#threadId(serverId, event.agentId, event.threadId);
    const card = this.#cards.get(id);
    if (!card) return;
    // A newer turn of the same chat started already.
    const current = this.#turnOfCard.get(id);
    if (current !== undefined && current !== key(serverId, event.turnId)) return;
    if (event.continues) return;
    if (event.quiet && this.#routineCards.has(id)) {
      this.#remove(id);
      this.#syncQueueCard(serverId, event.agentId);
      return;
    }
    this.#clearNeed(card);
    card.endedAt = this.#iso();
    if (event.status === "failed") this.#setState(card, "failed");
    else if (event.status === "interrupted") {
      card.stop = { reason: "", source: "interrupted" };
      this.#setState(card, "stopped");
    } else this.#setState(card, "done");
    this.#touch(card);
    this.#syncQueueCard(serverId, event.agentId);
  }

  #approval(serverId: string, approval: AgentApproval): void {
    const card = this.#threadCard(serverId, approval.agentId, approval.threadId);
    if (!OPEN_STATES.has(card.state)) this.#reopen(card);
    this.#indexTurn(serverId, card.id, approval.turnId);
    this.#clearNeed(card);
    card.need = {
      kind: "approval",
      requestId: approval.requestId,
      approvalKind: approval.kind,
      label: approval.kind === "command" ? this.#text(commandProgram(approval.command), FEED_LABEL_LIMIT) : "",
      ...(approval.guard ? { guard: true as const } : {}),
      since: this.#iso(),
    };
    this.#requests.set(key(serverId, "approval", approval.requestId), card.id);
    this.#setState(card, "needs-you");
    this.#touch(card);
  }

  #prompt(
    serverId: string,
    agentId: string,
    threadId: string,
    turnId: string,
    requestId: string | number,
    questions: ReadonlyArray<{ header: string; question: string }>,
  ): void {
    const card = this.#threadCard(serverId, agentId, threadId);
    if (!OPEN_STATES.has(card.state)) this.#reopen(card);
    this.#indexTurn(serverId, card.id, turnId);
    this.#clearNeed(card);
    const first = questions[0];
    card.need = {
      kind: "prompt",
      requestId,
      label: this.#text(first ? first.question || first.header : "", FEED_LABEL_LIMIT),
      questionCount: questions.length,
      since: this.#iso(),
    };
    this.#requests.set(key(serverId, "prompt", requestId), card.id);
    this.#setState(card, "needs-you");
    this.#touch(card);
  }

  #inputResolved(serverId: string, kind: "prompt" | "approval", requestId: string | number): void {
    const requestKey = key(serverId, kind, requestId);
    const id = this.#requests.get(requestKey);
    this.#requests.delete(requestKey);
    const card = id ? this.#cards.get(id) : undefined;
    if (!card?.need || card.need.kind !== kind || String(card.need.requestId) !== String(requestId)) return;
    card.need = null;
    if (card.state === "needs-you") this.#setState(card, "working");
    this.#touch(card);
  }

  #error(serverId: string, agentId: string, message: string): void {
    const open = this.#openByAgent.get(key(serverId, agentId));
    const latest = open ? [...open].at(-1) : undefined;
    const card = latest ? this.#cards.get(latest) : undefined;
    if (!card) return;
    this.#clearNeed(card);
    card.stop = { reason: this.#text(message, FEED_TEXT_LIMIT), source: "error" };
    card.endedAt = this.#iso();
    this.#setState(card, "failed");
    this.#touch(card);
  }

  #runtimeSnapshot(serverId: string, snapshot: AgentRuntimeSnapshot): void {
    this.#names(
      serverId,
      snapshot.agents.map((agent) => [agent.id, agent.name] as const),
    );
    const active = new Set<string>();
    for (const turn of snapshot.activeTurns) {
      const card = this.#threadCard(serverId, turn.agentId, turn.threadId);
      active.add(card.id);
      if (OPEN_STATES.has(card.state) && this.#turnOfCard.get(card.id) === key(serverId, turn.turnId)) continue;
      this.#turnStarted(serverId, turn.agentId, turn.threadId, turn.turnId, false);
    }
    const pending = new Set<string>();
    for (const approval of snapshot.pendingApprovals) {
      pending.add(this.#threadId(serverId, approval.agentId, approval.threadId));
      const card = this.#cards.get(this.#threadId(serverId, approval.agentId, approval.threadId));
      if (card?.need?.kind === "approval" && String(card.need.requestId) === String(approval.requestId)) continue;
      this.#approval(serverId, approval);
    }
    for (const prompt of snapshot.pendingPrompts) {
      pending.add(this.#threadId(serverId, prompt.agentId, prompt.threadId));
      const card = this.#cards.get(this.#threadId(serverId, prompt.agentId, prompt.threadId));
      if (card?.need?.kind === "prompt" && String(card.need.requestId) === String(prompt.requestId)) continue;
      this.#prompt(serverId, prompt.agentId, prompt.threadId, prompt.turnId, prompt.requestId, prompt.questions);
    }
    // The snapshot is the truth of this server: a run that it does not list ended while no event came.
    for (const card of [...this.#cards.values()]) {
      if (card.serverId !== serverId || !card.threadId || !OPEN_STATES.has(card.state)) continue;
      if (snapshot.attentionComplete && card.need && !pending.has(card.id)) {
        this.#clearNeed(card);
        if (active.has(card.id)) this.#setState(card, "working");
        this.#touch(card);
      }
      if (!active.has(card.id) && !pending.has(card.id)) {
        this.#clearNeed(card);
        card.endedAt = this.#iso();
        this.#setState(card, "done");
        this.#touch(card);
      }
    }
    for (const failed of snapshot.failedTurns) {
      const id = this.#turns.get(key(serverId, failed.turnId));
      const card = id ? this.#cards.get(id) : undefined;
      if (card?.state !== "done") continue;
      this.#setState(card, "failed");
      this.#touch(card);
    }
    if (snapshot.usageLimits) {
      const limited = new Map(snapshot.usageLimits.map((limit) => [limit.agentId, limit.resetsAt]));
      const directory = this.#directory(serverId);
      for (const agentId of new Set([...limited.keys(), ...directory.queues.keys()])) {
        this.#queue(serverId, agentId).limitResetsAt = limited.has(agentId) ? limited.get(agentId) : undefined;
        this.#syncQueueCard(serverId, agentId);
      }
    }
  }

  #tasks(serverId: string, agentId: string, tasks: ReadonlyArray<{ threadId: string; title: string }>): void {
    const titles = this.#directory(serverId).taskTitles;
    for (const task of tasks) {
      const title = this.#text(task.title, FEED_TITLE_LIMIT);
      const threadKey = key(agentId, task.threadId);
      titles.delete(threadKey);
      titles.set(threadKey, title);
      if (titles.size > TASK_TITLE_LIMIT) {
        const oldest = titles.keys().next().value;
        if (oldest !== undefined) titles.delete(oldest);
      }
      const card = this.#cards.get(this.#threadId(serverId, agentId, task.threadId));
      if (card && title && card.title !== title) {
        card.title = title;
        this.#touch(card);
      }
    }
  }

  #names(serverId: string, agents: ReadonlyArray<readonly [string, string]>): void {
    const names = this.#directory(serverId).names;
    let changed = false;
    for (const [agentId, name] of agents) {
      const clean = this.#text(name, INPUT_LIMITS.agentName);
      if (names.get(agentId) === clean) continue;
      names.set(agentId, clean);
      changed = true;
    }
    if (!changed) return;
    for (const card of this.#cards.values()) {
      if (card.serverId !== serverId) continue;
      const name = names.get(card.agentId);
      if (name === undefined || name === card.agentName) continue;
      card.agentName = name;
      this.#touch(card);
    }
  }

  #layout(serverId: string, layout: SidebarLayoutSnapshot): void {
    const directory = this.#directory(serverId);
    directory.sectionNames = new Map(
      layout.sections.map((section) => [section.id, this.#text(section.name, PROJECT_NAME_LIMIT)]),
    );
    directory.sectionOf = new Map(Object.entries(layout.agentAssignments));
    for (const card of this.#cards.values()) {
      if (card.serverId !== serverId) continue;
      const project = this.#project(serverId, card.agentId);
      if (project.projectId === card.projectId && project.projectName === card.projectName) continue;
      card.projectId = project.projectId;
      card.projectName = project.projectName;
      this.#touch(card);
    }
  }

  /**
   * The card of an agent that does not run but has queued messages, waits, or waits for a plan limit.
   * It goes while the agent runs: the card of the run shows the agent then.
   */
  #syncQueueCard(serverId: string, agentId: string): void {
    const queue = this.#servers.get(serverId)?.queues.get(agentId);
    const id = `${serverId}:q:${agentId}`;
    const limited = queue?.limitResetsAt !== undefined;
    const busy = (this.#openByAgent.get(key(serverId, agentId))?.size ?? 0) > 0;
    if (!queue || (!limited && (busy || (queue.queued === 0 && queue.waits === 0)))) {
      if (this.#cards.has(id)) this.#remove(id);
      return;
    }
    const state: FeedItemState = limited ? "stopped" : "waiting";
    const resetsAt =
      typeof queue.limitResetsAt === "number" ? new Date(queue.limitResetsAt * 1_000).toISOString() : null;
    const existing = this.#cards.get(id);
    if (existing?.state === state && existing.queued === queue.queued && (existing.stop?.resetsAt ?? null) === resetsAt)
      return;
    const card = existing ?? this.#newCard(id, serverId, agentId, null);
    card.queued = queue.queued;
    card.stop = limited ? { reason: "", source: "usage-limit", ...(resetsAt ? { resetsAt } : {}) } : null;
    this.#setState(card, state);
    this.#touch(card);
  }

  #queue(serverId: string, agentId: string) {
    const queues = this.#directory(serverId).queues;
    let queue = queues.get(agentId);
    if (!queue) {
      queue = { queued: 0, waits: 0, limitResetsAt: undefined };
      queues.set(agentId, queue);
    }
    return queue;
  }

  #directory(serverId: string): ServerDirectory {
    let directory = this.#servers.get(serverId);
    if (!directory) {
      directory = {
        names: new Map(),
        sectionOf: new Map(),
        sectionNames: new Map(),
        taskTitles: new Map(),
        queues: new Map(),
      };
      this.#servers.set(serverId, directory);
    }
    return directory;
  }

  #project(serverId: string, agentId: string): { projectId: string | null; projectName: string | null } {
    const directory = this.#servers.get(serverId);
    const sectionId = directory?.sectionOf.get(agentId);
    if (!sectionId || sectionId === SIDEBAR_UNASSIGNED_SECTION_ID || sectionId === SIDEBAR_PEOPLE_SECTION_ID)
      return { projectId: null, projectName: null };
    const name = directory?.sectionNames.get(sectionId);
    return name === undefined ? { projectId: null, projectName: null } : { projectId: sectionId, projectName: name };
  }

  #channelTitle(channelName: string, topicName: string | null): string {
    return topicName ? `${channelName} · ${topicName}` : channelName;
  }

  #threadId(serverId: string, agentId: string, threadId: string): string {
    return `${serverId}:t:${agentId}:${threadId}`;
  }

  #threadCard(serverId: string, agentId: string, threadId: string): FeedItem {
    const id = this.#threadId(serverId, agentId, threadId);
    const existing = this.#cards.get(id);
    if (existing) return existing;
    const card = this.#newCard(id, serverId, agentId, threadId);
    card.title = this.#servers.get(serverId)?.taskTitles.get(key(agentId, threadId)) ?? "";
    return card;
  }

  #newCard(id: string, serverId: string, agentId: string, threadId: string | null): FeedItem {
    const now = this.#iso();
    const name =
      this.#servers.get(serverId)?.names.get(agentId) ??
      this.#text(this.#resolveName?.(serverId, agentId) ?? "", INPUT_LIMITS.agentName);
    const card: FeedItem = {
      v: FEED_CONTRACT_VERSION,
      id,
      serverId,
      agentId,
      agentName: name,
      ...this.#project(serverId, agentId),
      threadId,
      channelId: null,
      taskId: null,
      title: "",
      state: "working",
      startedAt: now,
      updatedAt: now,
      endedAt: null,
      lastStep: null,
      steps: [],
      stepCount: 0,
      need: null,
      stop: null,
      actions: ["open"],
      revision: 0,
    };
    this.#cards.set(id, card);
    this.#removed.delete(id);
    this.#evict();
    return card;
  }

  /** A new run of a card that ended: it starts again, at the end of the timeline. */
  #reopen(card: FeedItem): void {
    this.#cards.delete(card.id);
    this.#cards.set(card.id, card);
    card.startedAt = this.#iso();
    card.endedAt = null;
    card.steps = [];
    card.stepCount = 0;
    card.lastStep = null;
    card.stop = null;
    delete card.quiet;
    this.#clearNeed(card);
  }

  #addStep(card: FeedItem, step: FeedStep): void {
    card.steps.push(step);
    if (card.steps.length > FEED_STEP_LIMIT) card.steps.splice(0, card.steps.length - FEED_STEP_LIMIT);
    card.stepCount += 1;
    card.lastStep = step;
  }

  #clearNeed(card: FeedItem): void {
    if (!card.need) return;
    this.#requests.delete(key(card.serverId, card.need.kind, card.need.requestId));
    card.need = null;
  }

  #setState(card: FeedItem, state: FeedItemState): void {
    card.state = state;
    if (!card.threadId) return;
    const agentKey = key(card.serverId, card.agentId);
    let open = this.#openByAgent.get(agentKey);
    if (OPEN_STATES.has(state)) {
      if (!open) {
        open = new Set();
        this.#openByAgent.set(agentKey, open);
      }
      open.delete(card.id);
      open.add(card.id);
      card.endedAt = null;
    } else if (open) {
      open.delete(card.id);
      if (open.size === 0) this.#openByAgent.delete(agentKey);
    }
  }

  #indexTurn(serverId: string, cardId: string, turnId: string): void {
    const previous = this.#turnOfCard.get(cardId);
    if (previous !== undefined) this.#turns.delete(previous);
    const turnKey = key(serverId, turnId);
    this.#turns.set(turnKey, cardId);
    this.#turnOfCard.set(cardId, turnKey);
  }

  #touch(card: FeedItem): void {
    card.revision += 1;
    card.updatedAt = this.#iso();
    if (this.#tracking) this.#changed.add(card.id);
  }

  #remove(id: string): void {
    const card = this.#cards.get(id);
    if (!card) return;
    this.#setState(card, "done");
    this.#clearNeed(card);
    this.#cards.delete(id);
    this.#routineCards.delete(id);
    const turnKey = this.#turnOfCard.get(id);
    if (turnKey !== undefined && this.#turns.get(turnKey) === id) this.#turns.delete(turnKey);
    this.#turnOfCard.delete(id);
    this.#changed.delete(id);
    if (this.#tracking) this.#removed.add(id);
  }

  /** Over the limit, the oldest ended card goes first, then the oldest card of any state. */
  #evict(): void {
    let excess = this.#cards.size - this.#limit;
    if (excess <= 0) return;
    for (const [id, card] of this.#cards) {
      if (excess <= 0) return;
      if (!ENDED_STATES.has(card.state)) continue;
      this.#remove(id);
      excess -= 1;
    }
    for (const id of this.#cards.keys()) {
      if (excess <= 0) return;
      this.#remove(id);
      excess -= 1;
    }
  }

  /** Cleaned, redacted and clipped: the only way a text gets into a card. */
  #text(value: string, limit: number): string {
    if (!value) return "";
    const cleaned = cleanAgentMessageText(value.slice(0, RAW_TEXT_LIMIT))
      .replace(INVISIBLE, " ")
      .replace(SPACES, " ")
      .trim();
    return cleaned ? clip(this.#redact(cleaned), limit) : "";
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }
}
