/**
 * The automatic recovery of stopped channel work, and the rules that keep it from running away.
 *
 * Every minute it looks at the stopped tasks. A task that stays stopped for the interval is started again;
 * one that stops again is started again once more; then, if the person allows it, it goes to another agent of
 * the same channel, the same model first. After two of each it is left alone, and the panel says so. It
 * never loops: each task has a fixed number of tries, a look acts on a few tasks at most, and what it
 * learned about a task stays for hours, so a task that runs and fails again is not counted anew. The
 * task reviewer (`task-watch.ts`) uses the same tries (`RecoveryLedger`), so the two cannot loop either.
 */

import type { StoppedWorkPlan } from "@openbot/contracts/ipc";
import { matchingSourceKeys, sourceText } from "@openbot/i18n/source";
import { createBuildersBotLogger } from "@openbot/logging";

/** Tries for one task before it is left alone. A reassignment is the try of the new owner. */
export const MAX_RESUMES = 2;
export const MAX_REASSIGNS = 2;
/** The most tasks one look acts on. */
const MAX_ACTIONS_PER_TICK = 3;
/** A task that has not been stopped for this long is forgotten, with its count of tries. */
const RECORD_RETENTION_MS = 6 * 60 * 60_000;
const RECENT_LIMIT = 5;
const CANDIDATE_LIMIT = 8;

/**
 * The reasons that a resume does not fix: the same request on the same agent stops again in the same way.
 * Each one asks the person to choose a member, or the agent that had the task cannot take it. A resume
 * of such a task only spends a try, and on 1 November 2026 it spent the three actions of each look on
 * routine requests that the lead could not route, for hours. Stored errors are source text.
 */
const NOT_RESUMABLE: ReadonlySet<string> = new Set([
  sourceText("error.backend.channelRoutingTooLong"),
  sourceText("error.backend.channelRoutingUnreadable"),
  sourceText("error.backend.channelLeadRequired"),
  sourceText("error.backend.channelLeadModelUnavailable"),
  sourceText("error.backend.channelTaskMemberRequired"),
  sourceText("error.backend.channelRequestMemberRequired"),
  sourceText("error.backend.channelMemberRequired"),
  sourceText("error.backend.channelAssigneeUnavailable"),
  sourceText("error.backend.channelAssigneeRemoved"),
  sourceText("error.backend.channelAssigneeReassign"),
  sourceText("error.backend.channelHistoryLeadRequired"),
  sourceText("error.backend.channelContextTooLong"),
]);

/**
 * A reason that only the person settles: a short provider failure stopped the task after an outside
 * action, such as a post or a push, that may already have happened (`backend/agent/turn-resume.ts`).
 * A resume or another agent could do it a second time, so neither the automatic recovery nor the task
 * reviewer acts on it.
 */
export function needsPerson(reason: string): boolean {
  return matchingSourceKeys(reason).includes("error.backend.channelTaskMayBeDone");
}

/**
 * Whether a resume can fix a stopped task: its reason is not one that asks for a member or for the
 * person, and the agent that had it still exists.
 */
export function resumable(reason: string, ownerMissing: boolean): boolean {
  return !ownerMissing && !NOT_RESUMABLE.has(reason) && !needsPerson(reason);
}

export interface MemberInfo {
  agentId: string;
  name: string;
  provider: string;
  model: string;
  /** A member that exists, is not hidden, and is not held by a spent plan. */
  available: boolean;
}

export interface ReassignCandidate {
  agentId: string;
  name: string;
  sameModel: boolean;
  sameProvider: boolean;
}

/**
 * The agents that can take a task from `owner`: available, not the owner, not tried already. The same
 * model comes first, then the same provider, then the rest, each group by name.
 */
export function reassignCandidates(
  owner: { agentId: string; provider: string; model: string } | null,
  members: readonly MemberInfo[],
  exclude: ReadonlySet<string>,
): ReassignCandidate[] {
  return members
    .filter((member) => member.available && member.agentId !== owner?.agentId && !exclude.has(member.agentId))
    .map((member): ReassignCandidate => {
      const sameProvider = owner !== null && member.provider === owner.provider;
      return {
        agentId: member.agentId,
        name: member.name,
        sameProvider,
        sameModel: sameProvider && member.model === owner?.model,
      };
    })
    .sort(
      (left, right) =>
        Number(right.sameModel) - Number(left.sameModel) ||
        Number(right.sameProvider) - Number(left.sameProvider) ||
        left.name.localeCompare(right.name),
    )
    .slice(0, CANDIDATE_LIMIT);
}

/** The agent that the automatic recovery gives a task to: the same model, else the same provider, never another provider. */
export function autoReassignee(candidates: readonly ReassignCandidate[]): string | null {
  return candidates.find((candidate) => candidate.sameModel || candidate.sameProvider)?.agentId ?? null;
}

export interface RecoveryRecord {
  seenAt: number;
  lastActionAt: number | null;
  resumes: number;
  reassigns: number;
  /** The agents the task was given to. */
  tried: string[];
  gaveUp: boolean;
  /** It gave up at once: a resume cannot fix the task and no agent can take it. */
  needsYou?: boolean;
  /** When the task reviewer acted on a failed start: one time for each action, until the record is forgotten. */
  startActions?: number[];
}

/** One record of the ledger: the tries of a task, and when a look last saw it. */
export interface LedgerRecord extends RecoveryRecord {
  lastSeenAt: number;
}

/**
 * The tries of each task, for the automatic recovery and the task reviewer together. A task gets
 * `MAX_RESUMES` and `MAX_REASSIGNS` in all, not for each of them. A look of the automatic recovery
 * sees each stopped task; the task reviewer sees a task when it acts on it, and each failed start. A
 * record that was not seen for `RECORD_RETENTION_MS` is forgotten, with its tries, and so is the
 * record of a task that completed. The records are in memory only.
 */
export class RecoveryLedger {
  readonly #records = new Map<string, LedgerRecord>();

  /** The record of a task that a look sees now. The first look makes it. */
  see(channelId: string, taskId: string, now: number): LedgerRecord {
    const key = ledgerKey(channelId, taskId);
    const record = this.#records.get(key) ?? {
      seenAt: now,
      lastActionAt: null,
      resumes: 0,
      reassigns: 0,
      tried: [],
      gaveUp: false,
      lastSeenAt: now,
    };
    record.lastSeenAt = now;
    this.#records.set(key, record);
    return record;
  }

  /** The record of a task, or undefined when no look saw it in the retention time. */
  peek(channelId: string, taskId: string): LedgerRecord | undefined {
    return this.#records.get(ledgerKey(channelId, taskId));
  }

  /** Forgets the record of a task, with its tries: the task completed. */
  forget(channelId: string, taskId: string): void {
    this.#records.delete(ledgerKey(channelId, taskId));
  }

  /** Forgets each record that no look saw for the retention time. */
  sweep(now: number): void {
    for (const [key, record] of this.#records)
      if (now - record.lastSeenAt > RECORD_RETENTION_MS) this.#records.delete(key);
  }
}

function ledgerKey(channelId: string, taskId: string): string {
  return `${channelId}\u0000${taskId}`;
}

export type RecoveryAction =
  | { type: "resume" }
  | { type: "reassign"; agentId: string }
  | { type: "give-up" }
  | { type: "needs-you" };

/**
 * What to do with one stopped task now, or null to wait. `pick` names the agent for a reassignment. A
 * task that a resume cannot fix (`resumable` false) gets no resume: it goes to another agent after the
 * interval when the person allows it and one can take it; else it is left to the person at once
 * (`needs-you`), so it does not wait for tries that cannot help.
 */
export function decideRecovery(
  record: RecoveryRecord,
  now: number,
  preference: { intervalMs: number; reassign: boolean },
  pick: () => string | null,
  canResume = true,
): RecoveryAction | null {
  if (record.gaveUp) return null;
  if (!canResume) {
    const agentId = preference.reassign && record.reassigns < MAX_REASSIGNS ? pick() : null;
    if (!agentId) return { type: "needs-you" };
    if (now - (record.lastActionAt ?? record.seenAt) < preference.intervalMs) return null;
    return { type: "reassign", agentId };
  }
  if (now - (record.lastActionAt ?? record.seenAt) < preference.intervalMs) return null;
  if (record.resumes < MAX_RESUMES) return { type: "resume" };
  if (!preference.reassign || record.reassigns >= MAX_REASSIGNS) return { type: "give-up" };
  const agentId = pick();
  return agentId ? { type: "reassign", agentId } : { type: "give-up" };
}

export interface AutoRecoveryPreference {
  enabled: boolean;
  intervalMinutes: number;
  reassign: boolean;
}

export interface RecoveryEvent {
  at: string;
  channelName: string;
  action: "resumed" | "reassigned" | "gave-up";
  agentName: string | null;
}

export interface StoppedRef {
  channelId: string;
  taskId: string;
  channelName: string;
  agentName: string | null;
  /** Whether a resume can fix it (`resumable`). Omitted: it can. */
  resumable?: boolean;
}

/** The log of the automatic recovery: actions and counts, never the text of a task. */
export interface RecoveryLog {
  info(message: string, fields: Record<string, string | number | boolean>): void;
}

export interface AutoRecoveryDeps {
  preference(): AutoRecoveryPreference;
  stopped(): readonly StoppedRef[];
  /** The agent to give a task to, given those it was given to already, or null. */
  candidate(channelId: string, taskId: string, tried: readonly string[]): string | null;
  resume(channelId: string, taskId: string): Promise<void>;
  reassign(channelId: string, taskId: string, agentId: string): Promise<void>;
  agentNameOf?(agentId: string): string | null;
  now(): number;
  onFailure(kind: "resume" | "reassign", channelId: string, taskId: string, cause: unknown): void;
  /** The tries, shared with the task reviewer. Omitted, the recovery keeps its own. */
  ledger?: RecoveryLedger;
  log?: RecoveryLog;
}

export class AutoRecovery {
  readonly #deps: AutoRecoveryDeps;
  readonly #ledger: RecoveryLedger;
  readonly #log: RecoveryLog;
  readonly #recent: RecoveryEvent[] = [];
  #ticking = false;

  constructor(deps: AutoRecoveryDeps) {
    this.#deps = deps;
    this.#ledger = deps.ledger ?? new RecoveryLedger();
    this.#log = deps.log ?? createBuildersBotLogger("auto-recovery");
  }

  /** What the panel shows for one stopped task. */
  statusOf(channelId: string, taskId: string): "waiting" | "gave-up" | null {
    const record = this.#ledger.peek(channelId, taskId);
    if (!record) return null;
    return record.gaveUp ? "gave-up" : "waiting";
  }

  /**
   * What "Resume by itself" does next with one stopped task, and in how many minutes, by the same rules
   * as a look (`decideRecovery`). A task that no look saw yet waits one interval from the next look.
   * `canReassign` says whether an agent can take it now; it is asked only when the next step needs it.
   */
  planOf(
    channelId: string,
    taskId: string,
    canResume: boolean,
    canReassign: () => boolean,
    now: number,
  ): StoppedWorkPlan | null {
    const preference = this.#deps.preference();
    if (!preference.enabled) return null;
    const record = this.#ledger.peek(channelId, taskId);
    const tries = (record?.resumes ?? 0) + (record?.reassigns ?? 0);
    const base = { by: "recovery", action: null, minutes: null, hold: null, tries } as const;
    if (record?.gaveUp) return { ...base, state: record.needsYou ? "needs-you" : "gave-up" };
    const intervalMs = Math.max(1, preference.intervalMinutes) * 60_000;
    const since = record ? (record.lastActionAt ?? record.seenAt) : now;
    const minutes = Math.max(0, Math.ceil((since + intervalMs - now) / 60_000));
    const reassign = () => preference.reassign && (record?.reassigns ?? 0) < MAX_REASSIGNS && canReassign();
    if (!canResume)
      return reassign() ? { ...base, state: "due", action: "reassign", minutes } : { ...base, state: "needs-you" };
    if ((record?.resumes ?? 0) < MAX_RESUMES) return { ...base, state: "due", action: "resume", minutes };
    return { ...base, state: "due", action: reassign() ? "reassign" : "give-up", minutes };
  }

  recent(): RecoveryEvent[] {
    return [...this.#recent];
  }

  /** One look. It does not overlap itself, and it never throws: a failed try counts as a try. */
  async tick(): Promise<void> {
    const preference = this.#deps.preference();
    if (!preference.enabled || this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#deps.now();
      const intervalMs = Math.max(1, preference.intervalMinutes) * 60_000;
      const due = this.#deps
        .stopped()
        .map((ref) => ({ ref, record: this.#ledger.see(ref.channelId, ref.taskId, now) }));
      this.#ledger.sweep(now);

      let acted = 0;
      let leftToYou = 0;
      for (const { ref, record } of due) {
        const canResume = ref.resumable ?? true;
        // Past the cap of the look, only the tasks that a resume cannot fix are still marked.
        if (acted >= MAX_ACTIONS_PER_TICK && canResume) continue;
        const action = decideRecovery(
          record,
          now,
          { intervalMs, reassign: preference.reassign },
          () => this.#deps.candidate(ref.channelId, ref.taskId, record.tried),
          canResume,
        );
        if (!action) continue;
        if (action.type === "needs-you") {
          // No command: it does not take one of the actions of the look.
          record.gaveUp = true;
          record.needsYou = true;
          leftToYou += 1;
          continue;
        }
        if (acted >= MAX_ACTIONS_PER_TICK) continue;
        acted += 1;
        record.lastActionAt = now;
        const tries = record.resumes + record.reassigns;
        if (action.type === "give-up") {
          record.gaveUp = true;
          this.#note(now, ref.channelName, "gave-up", ref.agentName);
          this.#log.info("Resume by itself gave up.", { tries });
        } else if (action.type === "resume") {
          record.resumes += 1;
          await this.#deps.resume(ref.channelId, ref.taskId).then(
            () => {
              this.#note(now, ref.channelName, "resumed", ref.agentName);
              this.#log.info("Resume by itself resumed a task.", { tries: tries + 1 });
            },
            (cause: unknown) => this.#deps.onFailure("resume", ref.channelId, ref.taskId, cause),
          );
        } else {
          record.reassigns += 1;
          record.tried.push(action.agentId);
          await this.#deps.reassign(ref.channelId, ref.taskId, action.agentId).then(
            () => {
              this.#note(
                now,
                ref.channelName,
                "reassigned",
                this.#deps.agentNameOf?.(action.agentId) ?? action.agentId,
              );
              this.#log.info("Resume by itself gave a task to another agent.", {
                tries: tries + 1,
                resumable: canResume,
              });
            },
            (cause: unknown) => this.#deps.onFailure("reassign", ref.channelId, ref.taskId, cause),
          );
        }
      }
      if (leftToYou > 0)
        this.#log.info("Resume by itself left tasks to the person: a resume cannot fix them.", { count: leftToYou });
    } finally {
      this.#ticking = false;
    }
  }

  #note(now: number, channelName: string, action: RecoveryEvent["action"], agentName: string | null): void {
    this.#recent.unshift({ at: new Date(now).toISOString(), channelName, action, agentName });
    this.#recent.length = Math.min(this.#recent.length, RECENT_LIMIT);
  }
}
