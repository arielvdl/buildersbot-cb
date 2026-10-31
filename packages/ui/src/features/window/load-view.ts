import { attachmentReferences, expandAttachmentReferences } from "@openbot/contracts/attachment-references";
import {
  DEFAULT_TASK_WATCH_PREFERENCE,
  type LoadLanePreference,
  type LoadSnapshot,
  type RecoveryEvent,
  type StoppedWork,
  TASK_WATCH_MAX_MINUTES,
  TASK_WATCH_MIN_MINUTES,
  type TaskWatchEvent,
} from "@openbot/contracts/ipc";

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
  return snapshot.stopped.length;
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
