import { sourceText } from "@openbot/i18n/source";
import { Effect, Exit, Scope } from "effect";
import type { HostMemory, HostMemoryLevel } from "../host-memory";
import { OPTIMIZATIONS_OFF, type OptimizationPort } from "../optimizations";
import type { ProviderClientOperationError } from "../provider-client-effects";

export interface MemoryHoldHooks {
  /** Tries each agent again. The memory is back, so a delivery that waited can start. */
  scheduleAll(): void;
  /**
   * Tries the agents that wait for a turn slot again. A slot can free on a path that schedules no
   * drain, so each sample is also a retry.
   */
  retryWaiting(): void;
  /**
   * Closes the provider threads that have no turn. They open again from their session. With
   * `minIdleMs`, only the threads that had no turn for at least that long.
   */
  releaseIdleThreads(minIdleMs?: number): Effect.Effect<void, ProviderClientOperationError>;
  emitError(code: string, error: unknown, agentId?: string): void;
  /**
   * The memory is back after a low period. The channels wake: a channel tab that waited for memory
   * holds no delivery of its own, so no drain would start it.
   */
  memoryReturned?(): void;
}

export interface MemoryHoldOptions {
  /** Null on a desktop computer: nothing is held there. */
  memory: HostMemory | null;
  hooks: MemoryHoldHooks;
  /** The advanced optimizations (beta). Omitted: every switch off. */
  optimizations?: OptimizationPort;
}

/**
 * How long a provider thread has had no turn before it closes when the memory becomes `low`, with the
 * switch `idle-release-low` on. A thread that just ended its turn is likely to get the next message.
 */
export const LOW_MEMORY_IDLE_RELEASE_MS = 2 * 60_000;

/**
 * Owns the memory clause of the queue drain. While the machine is low on memory no new turn starts,
 * and the delivery stays queued: a message to a busy machine waits, as it does for a busy agent. Each
 * held agent is told one time in each low period. At a critical level the idle provider threads close.
 * With the switch `idle-release-low` on, the threads with no turn for `LOW_MEMORY_IDLE_RELEASE_MS` also
 * close when the level goes from `ok` to `low`. It never imports the service.
 */
export class MemoryHold {
  readonly #memory: HostMemory | null;
  readonly #hooks: MemoryHoldHooks;
  readonly #optimizations: OptimizationPort;
  #scope = Scope.makeUnsafe();
  readonly #told = new Set<string>();
  #level: HostMemoryLevel = "ok";
  #unsubscribe: (() => void) | null = null;

  constructor(options: MemoryHoldOptions) {
    this.#memory = options.memory;
    this.#hooks = options.hooks;
    this.#optimizations = options.optimizations ?? OPTIMIZATIONS_OFF;
  }

  start(): void {
    if (!this.#memory || this.#unsubscribe) return;
    this.#unsubscribe = this.#memory.subscribe(() =>
      Effect.runFork(this.#sampled().pipe(Effect.forkIn(this.#scope, { startImmediately: true }))),
    );
  }

  readonly dispose = Effect.fn("MemoryHold.dispose")(function* (this: MemoryHold) {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    yield* Scope.close(this.#scope, Exit.void);
    this.#scope = Scope.makeUnsafe();
  }).bind(this);

  mayDrain(_agentId: string): boolean {
    return (this.#memory?.level() ?? "ok") === "ok";
  }

  /**
   * Whether one turn of the person may start although the memory is low: the level of a desktop is
   * `low`, not `critical`. A server's `low` also counts its turn reservations, so it lets nothing pass.
   * The drain adds the other rules (`queue-priority-user`).
   */
  personMayPassLow(): boolean {
    return this.#memory?.kind === "desktop" && this.#memory.level() === "low";
  }

  /** Tells the agent that its delivery waits for memory, one time in this low period. */
  held(agentId: string): void {
    if (this.#told.has(agentId)) return;
    this.#told.add(agentId);
    const message = this.#memory?.hostedPlan
      ? sourceText("error.agent.lowMemory")
      : this.#memory?.kind === "desktop"
        ? sourceText("error.agent.lowMemoryDesktop")
        : sourceText("error.agent.lowMemoryServer");
    this.#hooks.emitError("host_memory_low", new Error(message), agentId);
  }

  /** Returns the release, for a start that ends with no turn. */
  reserveTurn(): () => void {
    return this.#memory?.reserveTurn() ?? (() => {});
  }

  /** The most turns that run at the same time, or null for no limit. */
  turnLimit(): number | null {
    return this.#memory?.turnLimit() ?? null;
  }

  readonly #sampled = Effect.fn("MemoryHold.sampled")(function* (this: MemoryHold) {
    this.#hooks.retryWaiting();
    const level = this.#memory?.level() ?? "ok";
    const previous = this.#level;
    this.#level = level;
    if (level === "critical" && previous !== "critical")
      yield* this.#hooks
        .releaseIdleThreads()
        .pipe(
          Effect.catch((failure) =>
            Effect.sync(() => this.#hooks.emitError("idle_thread_release_failed", failure.cause)),
          ),
        );
    else if (level === "low" && previous === "ok" && this.#optimizations.optimizationEnabled("idle-release-low"))
      yield* this.#hooks
        .releaseIdleThreads(LOW_MEMORY_IDLE_RELEASE_MS)
        .pipe(
          Effect.catch((failure) =>
            Effect.sync(() => this.#hooks.emitError("idle_thread_release_failed", failure.cause)),
          ),
        );
    if (level === "ok" && previous !== "ok") this.#hooks.memoryReturned?.();
    // By the held agents, not by the last level: a turn reservation can hold an agent between two
    // samples that both read "ok".
    if (level === "ok" && this.#told.size > 0) {
      this.#told.clear();
      this.#hooks.scheduleAll();
    }
  });
}
