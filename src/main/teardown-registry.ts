/**
 * The named shutdown steps `createApplicationServices` accumulates while it builds, so a quit that
 * arrives mid-startup tears down exactly what exists rather than nothing at all.
 *
 * Three things it does that the hand-written shutdown sequence it replaces did not:
 *
 * - **Every step is caught.** A rejecting `remoteServers.stop()` used to skip the host, the WebRTC
 *   bridge and the agent service below it, leaving provider CLIs running after the app had quit.
 * - **A step registered after `runAll` still runs.** Construction keeps going after `before-quit`
 *   fires, so a service built during the teardown would otherwise leak a listening socket or a
 *   child process. Its step joins the run in progress instead of being dropped: while the drain is
 *   working it is spliced into the steps still to come, in ordinal position, so a service that
 *   finishes building mid-shutdown is still torn down in sequence. It can only be placed among the
 *   steps that remain - an ordinal whose slot has already passed goes next rather than in the past.
 *   A step registered after `runAll` has returned is genuinely best-effort: nothing awaits it, and
 *   `app.quit()` can end the process first. Closing that last gap needs construction itself to
 *   abort on `before-quit`, which it does not do today.
 * - **A step can wait for the steps it abandoned.** A step that passes its limit keeps running. The
 *   database step waits for these before it closes, so a slow agent stop does not write to a closed
 *   database (#3166). It waits for a step outside the budget until `lastStepByMs`, and for any other
 *   step at most half the step limit. Then it runs anyway: a database that the process leaves open
 *   makes the next start check every page, which takes minutes.
 *
 * - **The steps that hold no data share one budget.** Each limit applies to one step, so the limits
 *   used to add up: the local host and the team WebRTC bridge held one quit for 20 s, and a third step
 *   that did not stop took the quit to the shutdown deadline before the database step had run. A step
 *   that writes user data or owns child processes is outside the budget: it keeps the full step limit,
 *   because the agent stop can take more than 10 s and a stop that is abandoned before its kill leaves
 *   processes behind. After the budget, each step that is left still starts in its order, but the
 *   drain waits only a short time for it. No step gets time after `lastStepByMs`, so the database
 *   closes before the shutdown deadline of the process.
 *
 * Steps declare an **order** rather than running last-in-first-out. Shutdown here is largely
 * *construction* order and not its reverse: the browser host is destroyed before the
 * picture-in-picture window that holds a reference to it, and the provider runtimes stop before the
 * agent service that owns them. Reversing that would move the browser's cookie and state flush
 * behind a potentially slow agent stop, so the order is declared and sorted, never inferred.
 */

export interface TeardownRegistryOptions {
  reportError: (name: string, error: unknown) => void;
  /** A line for the main log: a step that took long, or the budget that ran out. */
  report?: (message: string) => void;
  /**
   * How long one step may run before the drain moves on. A step that never settles would otherwise
   * keep a windowless process alive: it holds the single-instance lock, so every later launch hands
   * off to it and exits, and the user can only end it from the task manager.
   */
  stepTimeoutMs?: number;
  /** How long the drain may wait for the steps inside the budget, all together. */
  budgetMs?: number;
  /**
   * The time from `runAll` after which the drain gives no step more than a short wait, so that a step
   * that waits for abandoned steps starts by then. That step waits until then for the abandoned steps
   * outside the budget. `index.ts` sets it from its shutdown deadline, with time to close the database.
   */
  lastStepByMs?: number;
}

/** Well above the two-second kill grace that provider processes get before `SIGKILL`. */
const DEFAULT_STEP_TIMEOUT_MS = 10_000;
/** One step that does not stop still gets its full limit, and a second one gets half of it. */
const DEFAULT_BUDGET_MS = 15_000;
/** Six seconds before a shutdown deadline of 30 s. */
const DEFAULT_LAST_STEP_BY_MS = 24_000;
/** Enough for a step that only closes a handle or a socket. */
const LATE_STEP_TIMEOUT_MS = 100;
/** All the steps that are left after the budget, together: many steps that do not stop add little. */
const LATE_STEPS_TOTAL_MS = 1_000;
/** A step that takes this long goes to the main log, so a slow quit names the step that held it. */
const SLOW_STEP_MS = 1_000;
const TIMED_OUT = Symbol("timed out");

interface TeardownStep {
  order: number;
  name: string;
  run: () => PromiseLike<unknown> | unknown;
  afterAbandonedSteps: boolean;
  outsideBudget: boolean;
}

export interface TeardownStepOptions {
  /**
   * Run after every step that passed its limit has ended. The wait ends at `lastStepByMs` for a step
   * outside the budget, and at half the step limit for any other step. Its own limit starts after it.
   */
  afterAbandonedSteps?: boolean;
  /**
   * The step writes user data or owns child processes. The budget does not make its limit shorter,
   * and a step that waits for abandoned steps waits for it until `lastStepByMs`.
   */
  outsideBudget?: boolean;
}

/** Which allowance the time that the drain waits for a step comes from. */
type Allowance = "budget" | "late" | "none";

export class TeardownRegistry {
  readonly #reportError: (name: string, error: unknown) => void;
  readonly #report: (message: string) => void;
  readonly #stepTimeoutMs: number;
  readonly #budgetMs: number;
  readonly #lastStepByMs: number;
  #steps: TeardownStep[] = [];
  /** The sorted steps a drain in progress has not reached yet. Late pushes are spliced into it. */
  #pending: TeardownStep[] | null = null;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  /** Steps inside the budget that passed their limit and still run. Each removes itself when it ends. */
  readonly #abandoned = new Set<Promise<unknown>>();
  /** The same for the steps outside the budget. */
  readonly #abandonedOutsideBudget = new Set<Promise<unknown>>();
  /** Set when the drain starts. */
  #lastStepAt: number | null = null;
  #budgetUsedMs = 0;
  #lateUsedMs = 0;
  #lateReported = false;

  constructor({
    reportError,
    report = () => undefined,
    stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    budgetMs = DEFAULT_BUDGET_MS,
    lastStepByMs = DEFAULT_LAST_STEP_BY_MS,
  }: TeardownRegistryOptions) {
    this.#reportError = reportError;
    this.#report = report;
    this.#stepTimeoutMs = stepTimeoutMs;
    this.#budgetMs = budgetMs;
    this.#lastStepByMs = lastStepByMs;
  }

  /** `order` is the position in the shutdown sequence, not the position in this call sequence. */
  push(
    order: number,
    name: string,
    run: () => PromiseLike<unknown> | unknown,
    { afterAbandonedSteps = false, outsideBudget = false }: TeardownStepOptions = {},
  ): void {
    const step = { order, name, run, afterAbandonedSteps, outsideBudget };
    if (!this.#closed) {
      this.#steps.push(step);
      return;
    }
    const pending = this.#pending;
    if (pending) {
      const at = pending.findIndex((queued) => queued.order > order);
      pending.splice(at === -1 ? pending.length : at, 0, step);
      return;
    }
    this.#tail = this.#tail.then(() => this.#runStep(step));
  }

  /** Idempotent: a second call awaits the first run rather than starting another. */
  async runAll(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#tail = this.#tail.then(() => this.#drain());
    }
    // Construction that was already in flight when the quit arrived keeps registering steps while
    // this runs, and each one extends the tail. Wait until awaiting it leaves nothing new behind;
    // the loop terminates because only construction pushes, and construction is finite.
    let awaited: Promise<void> | null = null;
    while (awaited !== this.#tail) {
      awaited = this.#tail;
      await awaited;
    }
  }

  async #drain(): Promise<void> {
    this.#lastStepAt = Date.now() + this.#lastStepByMs;
    const pending = [...this.#steps].sort((left, right) => left.order - right.order);
    this.#steps = [];
    this.#pending = pending;
    // `shift` rather than iteration: `push` splices into this same array while the loop awaits.
    for (let step = pending.shift(); step; step = pending.shift()) await this.#runStep(step);
    this.#pending = null;
  }

  /**
   * The step limit, but not past `lastStepByMs`, and for a step inside the budget not past what is
   * left of it. When that leaves only a short wait, the step shares the short waits of the steps after
   * the budget.
   */
  #limit(step: TeardownStep): { limitMs: number; allowance: Allowance } {
    if (step.afterAbandonedSteps || this.#lastStepAt === null)
      return { limitMs: this.#stepTimeoutMs, allowance: "none" };
    const limitMs = Math.min(
      this.#stepTimeoutMs,
      this.#lastStepAt - Date.now(),
      step.outsideBudget ? Number.POSITIVE_INFINITY : this.#budgetMs - this.#budgetUsedMs,
    );
    if (limitMs > LATE_STEP_TIMEOUT_MS) return { limitMs, allowance: step.outsideBudget ? "none" : "budget" };
    if (!this.#lateReported) {
      this.#lateReported = true;
      this.#report(
        `The shutdown steps used their time. Each step that is left, from "${step.name}", gets ${LATE_STEP_TIMEOUT_MS} ms, and all of them ${LATE_STEPS_TOTAL_MS} ms.`,
      );
    }
    return {
      limitMs: Math.max(0, Math.min(LATE_STEP_TIMEOUT_MS, LATE_STEPS_TOTAL_MS - this.#lateUsedMs)),
      allowance: "late",
    };
  }

  async #runStep(step: TeardownStep): Promise<void> {
    // Before the limit: the wait of the database step for abandoned steps has its own end.
    if (step.afterAbandonedSteps) await this.#abandonedSettled();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { limitMs, allowance } = this.#limit(step);
    const startedAt = Date.now();
    const running = Promise.resolve().then(() => step.run());
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        this.#reportError(step.name, new Error(`It did not stop within ${limitMs} ms.`));
        // The step is abandoned, not cancelled: it keeps running, but the steps after it no longer wait.
        const abandoned = running.then(
          () => this.#reportSlow(step.name, startedAt),
          (error) => this.#reportError(step.name, error),
        );
        const set = step.outsideBudget ? this.#abandonedOutsideBudget : this.#abandoned;
        set.add(abandoned);
        void abandoned.finally(() => set.delete(abandoned));
        resolve(TIMED_OUT);
      }, limitMs);
    });
    try {
      if ((await Promise.race([running, timedOut])) !== TIMED_OUT) this.#reportSlow(step.name, startedAt);
    } catch (error) {
      this.#reportError(step.name, error);
    } finally {
      clearTimeout(timer);
      const waitedMs = Date.now() - startedAt;
      if (allowance === "budget") this.#budgetUsedMs += waitedMs;
      else if (allowance === "late") this.#lateUsedMs += waitedMs;
    }
  }

  #reportSlow(name: string, startedAt: number): void {
    const durationMs = Date.now() - startedAt;
    if (durationMs >= SLOW_STEP_MS) this.#report(`Shutting down ${name} took ${durationMs} ms.`);
  }

  async #abandonedSettled(): Promise<void> {
    const lastStepInMs = this.#lastStepAt === null ? 0 : this.#lastStepAt - Date.now();
    await Promise.all([
      settledWithin(this.#abandoned, Math.min(this.#stepTimeoutMs / 2, lastStepInMs)),
      settledWithin(this.#abandonedOutsideBudget, lastStepInMs),
    ]);
  }
}

/** Resolves when all of `tasks` have settled, or after `limitMs`. */
async function settledWithin(tasks: ReadonlySet<Promise<unknown>>, limitMs: number): Promise<void> {
  if (tasks.size === 0 || limitMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waitEnded = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limitMs);
  });
  await Promise.race([Promise.allSettled([...tasks]), waitEnded]);
  clearTimeout(timer);
}
