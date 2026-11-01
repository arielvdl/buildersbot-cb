import { attachmentReferences, expandAttachmentReferences } from "@openbot/contracts/attachment-references";
import {
  AGENT_TABS_MAX,
  AGENT_TABS_MIN,
  DEFAULT_AGENT_TABS,
  DEFAULT_TASK_WATCH_PREFERENCE,
  type LoadLanePreference,
  type LoadSnapshot,
  type RecoveryEvent,
  type StoppedWork,
  type StoppedWorkPlan,
  TASK_WATCH_MAX_MINUTES,
  TASK_WATCH_MIN_MINUTES,
  type TaskWatchEvent,
  type TaskWatchHold,
  type TaskWatchWait,
} from "@openbot/contracts/ipc";
import type { AppTextKey, AppTranslate } from "@openbot/i18n";

export type LoadTone = "ok" | "warning" | "critical";

/** The share of the computer's memory in use, 0 to 100, or null before the first sample. */
export function loadMemoryPercent(snapshot: LoadSnapshot): number | null {
  const { usedMb, totalMb } = snapshot.memory;
  if (usedMb === null || totalMb <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((usedMb / totalMb) * 100)));
}

/** The ring turns amber at 60% and red at 80%, where a computer with many agents starts to swap. */
export function loadTone(percent: number | null): LoadTone {
  if (percent === null || percent < 60) return "ok";
  return percent < 80 ? "warning" : "critical";
}

/**
 * The colour of the ring, from the memory: what macOS says when it is read, else the share in use.
 * The arc is the agents (`loadAgentArc`), so the memory shows as the tone.
 */
export function loadRingTone(snapshot: LoadSnapshot): LoadTone {
  const level = snapshot.memory.pressure?.level;
  if (level === "critical") return "critical";
  if (level === "low") return "warning";
  return loadTone(loadMemoryPercent(snapshot));
}

/** With no limit, ten agents that run close the circle. More can run; the arc stays full. */
export const LOAD_RING_FULL_AGENTS = 10;

/**
 * The arc of the ring, 0 to 100: the agents that run now, of ten, or of the limit when the person set
 * one. The number inside the ring is the count itself, which can be more than ten.
 */
export function loadAgentArc(agents: number, limit: number | null = null): number {
  const full = limit ?? LOAD_RING_FULL_AGENTS;
  if (full <= 0 || agents <= 0) return 0;
  return Math.round(Math.min(agents / full, 1) * 100);
}

/** Memory in GB with one decimal, or whole GB from ten up, so the label stays short. */
export function formatGigabytes(megabytes: number): string {
  const gigabytes = megabytes / 1024;
  return gigabytes >= 10 ? `${Math.round(gigabytes)} GB` : `${gigabytes.toFixed(1)} GB`;
}

export interface LoadLaneRow {
  id: string;
  status: "running" | "queued";
  /** The place in the queue, from 1. Absent for a channel that runs. */
  position?: number;
}

/** The channels that run, then the ones that wait, in the order they start. */
export function loadLaneRows(snapshot: LoadSnapshot): LoadLaneRow[] {
  const running = snapshot.lane.running.map((id): LoadLaneRow => ({ id, status: "running" }));
  const queued = snapshot.lane.queued.map((id, index): LoadLaneRow => ({ id, status: "queued", position: index + 1 }));
  return [...running, ...queued];
}

/** The preference with this channel first. The channels the user ordered before keep their order after it. */
export function withChannelFirst(snapshot: LoadSnapshot, channelId: string): LoadLanePreference {
  return {
    enabled: snapshot.lane.enabled,
    order: [channelId, ...snapshot.lane.order.filter((id) => id !== channelId)],
  };
}

/** The channel tabs of one agent that run at the same time: whole, from 1 to 4, and 2 for anything else. */
export function clampAgentTabs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AGENT_TABS;
  return Math.min(AGENT_TABS_MAX, Math.max(AGENT_TABS_MIN, Math.round(value)));
}

/** The cap on the agents that run: whole, from 1 to 64, and 10 for anything that is not a number. */
export function clampAgentLimit(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(64, Math.max(1, Math.round(value)));
}

/** The cap that the arc and the labels read, or null while it is off. */
export function activeAgentLimit(snapshot: LoadSnapshot): number | null {
  return snapshot.agentLimit.enabled ? snapshot.agentLimit.max : null;
}

/** The interval of the automatic recovery in minutes: whole, from 5 to 1440, and 30 for anything that is not a number. */
export function clampRecoveryMinutes(value: number): number {
  if (!Number.isFinite(value)) return 30;
  return Math.min(1440, Math.max(5, Math.round(value)));
}

/** The threshold of the task reviewer in minutes: whole, from 5 to 120, and 15 for anything that is not a number. */
export function clampWatchMinutes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TASK_WATCH_PREFERENCE.quietMinutes;
  return Math.min(TASK_WATCH_MAX_MINUTES, Math.max(TASK_WATCH_MIN_MINUTES, Math.round(value)));
}

/** The most lines of "Lately": the actions of the automatic recovery and of the task reviewer together. */
export const LOAD_RECENT_LIMIT = 6;

/** One line of "Lately": an action of the automatic recovery, or of the task reviewer. */
export type LoadRecentEvent = { by: "recovery"; event: RecoveryEvent } | { by: "reviewer"; event: TaskWatchEvent };

/** The actions of the automatic recovery and of the task reviewer in one list, the newest first. */
export function loadRecentEvents(snapshot: LoadSnapshot): LoadRecentEvent[] {
  const events: LoadRecentEvent[] = [
    ...snapshot.recovery.recent.map((event): LoadRecentEvent => ({ by: "recovery", event })),
    ...snapshot.taskWatch.recent.map((event): LoadRecentEvent => ({ by: "reviewer", event })),
  ];
  return events
    .sort((left, right) => (Date.parse(right.event.at) || 0) - (Date.parse(left.event.at) || 0))
    .slice(0, LOAD_RECENT_LIMIT);
}

/** Whole minutes since `startedAt`, never below zero, and zero for a date that does not parse. */
export function elapsedMinutes(startedAt: string, now: number): number {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 60_000));
}

/** How many stopped tasks the panel lists, which is the number of the alert on the ring. */
export function stoppedCount(snapshot: LoadSnapshot): number {
  // The list stops at `LOAD_WORK_LIST_LIMIT` rows; the total counts every stopped run.
  return snapshot.stoppedTotal ?? snapshot.stopped.length;
}

/** An attachment mark that the main process cut at the end of a clipped request: `@[name](attach…`. */
const CLIPPED_ATTACHMENT = /@\[[^\x5d\r\n]*(?:\](?:\([^)\r\n]*)?)?…$/u;

/**
 * A request as the panel shows it: with no attachment marks, and the number of marks it had. A
 * request is clipped with an ellipsis, so the last mark can be cut; that part goes too.
 */
export function requestText(request: string): { text: string; attachments: number } {
  let attachments = attachmentReferences(request).length;
  let text = expandAttachmentReferences(request, () => "");
  if (CLIPPED_ATTACHMENT.test(text)) {
    attachments += 1;
    text = text.replace(CLIPPED_ATTACHMENT, "…");
  }
  text = text.replace(/\s+/gu, " ").trim();
  return { text: text === "…" ? "" : text, attachments };
}

/** A failed task is an error; a paused one waits for the person, for example after a restart. */
export function stoppedTone(state: StoppedWork["state"]): "danger" | "warning" {
  return state === "failed" ? "danger" : "warning";
}

/** The set of expanded requests with `key` changed: added when it was not in the set, else removed. */
export function toggledKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** One action of the automatic recovery: "Resumed Payments". */
export function recoveryEventText(event: RecoveryEvent, t: AppTranslate): string {
  if (event.action === "resumed") return t("app.rail.load.eventResumed", { channel: event.channelName });
  if (event.action === "reassigned")
    return t("app.rail.load.eventReassigned", { channel: event.channelName, agent: event.agentName ?? "" });
  return t("app.rail.load.eventGaveUp", { channel: event.channelName });
}

/**
 * One action of the task reviewer, with why it acted: "Task reviewer: resumed Payments (no sign for 32
 * min)". The load panel and the page of the task reviewer in Settings show the same line.
 */
export function taskWatchEventText(event: TaskWatchEvent, t: AppTranslate): string {
  const minutes = event.minutes ?? 0;
  const why =
    event.reason === "start-failed"
      ? t("app.rail.load.watchWhyStartFailed")
      : event.reason === "queued"
        ? t("app.rail.load.watchWhyQueued", { minutes })
        : t("app.rail.load.watchWhyNoSign", { minutes });
  const channel = event.channelName;
  if (event.action === "waited") return t("app.rail.load.watchEventWaited", { channel, why });
  if (event.action === "resumed") return t("app.rail.load.watchEventResumed", { channel, why });
  if (event.action === "reassigned")
    return t("app.rail.load.watchEventReassigned", { channel, agent: event.agentName ?? "", why });
  if (event.action === "stopped") return t("app.rail.load.watchEventStopped", { channel, why });
  return t("app.rail.load.watchEventGaveUp", { channel, why });
}

const HOLD_TEXT = {
  person: "app.rail.load.hold.person",
  attention: "app.rail.load.hold.attention",
  memory: "app.rail.load.hold.memory",
  children: "app.rail.load.hold.children",
  plan: "app.rail.load.hold.plan",
  lane: "app.rail.load.hold.lane",
  slot: "app.rail.load.hold.slot",
  "agent-busy": "app.rail.load.hold.agent-busy",
  "waits-for-work": "app.rail.load.hold.waits-for-work",
  retrying: "app.rail.load.hold.retrying",
} as const satisfies Record<TaskWatchHold, AppTextKey>;

const WAIT_KIND_TEXT = {
  running: "app.rail.load.wait.kind.running",
  queued: "app.rail.load.wait.kind.queued",
  "start-failed": "app.rail.load.wait.kind.start-failed",
} as const satisfies Record<TaskWatchWait["kind"], AppTextKey>;

/** Why the task reviewer leaves a task alone: "the agent waits for you". */
export function holdText(hold: TaskWatchHold, t: AppTranslate): string {
  return t(HOLD_TEXT[hold]);
}

/** "in 12 min", or "within a minute" when the next look acts. */
function whenText(minutes: number | null, t: AppTranslate): string {
  return minutes !== null && minutes > 0
    ? t("app.rail.load.plan.inMinutes", { minutes })
    : t("app.rail.load.plan.nextLook");
}

/**
 * What the app does next with a stopped task, for its row: "The task reviewer resumes it in 12 min",
 * "Resume by itself waits: the agent waits for you", "Needs you: a resume does not fix this.", or
 * "The task reviewer gave up after 3 tries".
 */
export function stoppedPlanText(plan: StoppedWorkPlan, t: AppTranslate): string {
  const who = t(plan.by === "reviewer" ? "app.rail.load.plan.reviewer" : "app.rail.load.plan.recovery");
  if (plan.state === "needs-you") return t("app.rail.load.plan.needsYou");
  if (plan.state === "gave-up") return t("app.rail.load.plan.gaveUp", { who, count: plan.tries });
  if (plan.state === "held")
    return t("app.rail.load.plan.held", { who, reason: plan.hold ? holdText(plan.hold, t) : "" });
  const when = whenText(plan.minutes, t);
  if (plan.action === "reassign") return t("app.rail.load.plan.reassign", { who, when });
  if (plan.action === "give-up") return t("app.rail.load.plan.giveUp", { who, when });
  return t("app.rail.load.plan.resume", { who, when });
}

/** The kind of a task that the task reviewer watches: "Working", "Requested", "Did not start". */
export function taskWatchWaitKind(wait: TaskWatchWait, t: AppTranslate): string {
  return t(WAIT_KIND_TEXT[wait.kind]);
}

/** Why the task reviewer does not act on a task yet, and when it can: "Acts in 8 min if no sign comes". */
export function taskWatchWaitText(wait: TaskWatchWait, t: AppTranslate): string {
  const when = whenText(wait.minutes, t);
  switch (wait.state) {
    case "held":
      return t("app.rail.load.wait.held", { reason: wait.hold ? holdText(wait.hold, t) : "" });
    case "gave-up":
      return t("app.rail.load.wait.gaveUp");
    case "due":
      return t("app.rail.load.wait.due");
    case "cooldown":
      return t("app.rail.load.wait.cooldown", { when });
    case "watching":
      return wait.kind === "start-failed"
        ? t("app.rail.load.wait.startFailed", { when })
        : t("app.rail.load.wait.watching", { when });
  }
}
