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

/** Tries for one task before it is left alone. A reassignment is the try of the new owner. */
export const MAX_RESUMES = 2;
export const MAX_REASSIGNS = 2;
/** The most tasks one look acts on. */
const MAX_ACTIONS_PER_TICK = 3;
/** A task that has not been stopped for this long is forgotten, with its count of tries. */
const RECORD_RETENTION_MS = 6 * 60 * 60_000;
const RECENT_LIMIT = 5;
const CANDIDATE_LIMIT = 8;

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
}

/** One record of the ledger: the tries of a task, and when a look last saw it. */
export interface LedgerRecord extends RecoveryRecord {
  lastSeenAt: number;
}

/**
 * The tries of each task, for the automatic recovery and the task reviewer together. A task gets
 * `MAX_RESUMES` and `MAX_REASSIGNS` in all, not for each of them. A record that no look saw for
 * `RECORD_RETENTION_MS` is forgotten, with its tries. The records are in memory only.
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

  /** Forgets each record that no look saw for the retention time. */
  sweep(now: number): void {
    for (const [key, record] of this.#records)
      if (now - record.lastSeenAt > RECORD_RETENTION_MS) this.#records.delete(key);
  }
}

function ledgerKey(channelId: string, taskId: string): string {
  return `${channelId}\u0000${taskId}`;
}

export type RecoveryAction = { type: "resume" } | { type: "reassign"; agentId: string } | { type: "give-up" };

/** What to do with one stopped task now, or null to wait. `pick` names the agent for a reassignment. */
export function decideRecovery(
  record: RecoveryRecord,
  now: number,
  preference: { intervalMs: number; reassign: boolean },
  pick: () => string | null,
): RecoveryAction | null {
  if (record.gaveUp) return null;
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
}

export class AutoRecovery {
  readonly #deps: AutoRecoveryDeps;
  readonly #ledger: RecoveryLedger;
  readonly #recent: RecoveryEvent[] = [];
  #ticking = false;

  constructor(deps: AutoRecoveryDeps) {
    this.#deps = deps;
    this.#ledger = deps.ledger ?? new RecoveryLedger();
  }

  /** What the panel shows for one stopped task. */
  statusOf(channelId: string, taskId: string): "waiting" | "gave-up" | null {
    const record = this.#ledger.peek(channelId, taskId);
    if (!record) return null;
    return record.gaveUp ? "gave-up" : "waiting";
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
      for (const { ref, record } of due) {
        if (acted >= MAX_ACTIONS_PER_TICK) break;
        const action = decideRecovery(record, now, { intervalMs, reassign: preference.reassign }, () =>
          this.#deps.candidate(ref.channelId, ref.taskId, record.tried),
        );
        if (!action) continue;
        acted += 1;
        record.lastActionAt = now;
        if (action.type === "give-up") {
          record.gaveUp = true;
          this.#note(now, ref.channelName, "gave-up", ref.agentName);
        } else if (action.type === "resume") {
          record.resumes += 1;
          await this.#deps.resume(ref.channelId, ref.taskId).then(
            () => this.#note(now, ref.channelName, "resumed", ref.agentName),
            (cause: unknown) => this.#deps.onFailure("resume", ref.channelId, ref.taskId, cause),
          );
        } else {
          record.reassigns += 1;
          record.tried.push(action.agentId);
          await this.#deps.reassign(ref.channelId, ref.taskId, action.agentId).then(
            () =>
              this.#note(
                now,
                ref.channelName,
                "reassigned",
                this.#deps.agentNameOf?.(action.agentId) ?? action.agentId,
              ),
            (cause: unknown) => this.#deps.onFailure("reassign", ref.channelId, ref.taskId, cause),
          );
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  #note(now: number, channelName: string, action: RecoveryEvent["action"], agentName: string | null): void {
    this.#recent.unshift({ at: new Date(now).toISOString(), channelName, action, agentName });
    this.#recent.length = Math.min(this.#recent.length, RECENT_LIMIT);
  }
}
