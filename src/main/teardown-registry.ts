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
 *   database (#3166). The wait ends at half the step limit, and the step then runs anyway: a database
 *   that the process leaves open makes the next start check every page, which takes minutes.
 *
 * - **The steps share one budget.** Each limit applies to one step, so the limits used to add up:
 *   the local host and the team WebRTC bridge held one quit for 20 s, and a third step that did not
 *   stop took the quit to the shutdown deadline before the database step had run. After the budget,
 *   each step that is left still starts in its order, but the drain waits only a short time for it.
 *   A step that waits for abandoned steps keeps its own limits, so the database always closes before
 *   the deadline, and an abandoned agent stop still has time to record its interrupted turns.
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
  /**
   * How long all the steps together may hold the quit, from `runAll`. With the half step limit that
   * the database step can wait for abandoned steps, and its close, it stays below the shutdown
   * deadline of the process.
   */
  budgetMs?: number;
}

/** Well above the two-second kill grace that provider processes get before `SIGKILL`. */
const DEFAULT_STEP_TIMEOUT_MS = 10_000;
/** One step that does not stop still gets its full limit, and a second one gets half of it. */
const DEFAULT_BUDGET_MS = 15_000;
/** Enough for a step that only closes a handle or a socket. Steps that do not stop add little. */
const LATE_STEP_TIMEOUT_MS = 100;
/** A step that takes this long goes to the main log, so a slow quit names the step that held it. */
const SLOW_STEP_MS = 1_000;
const TIMED_OUT = Symbol("timed out");

interface TeardownStep {
  order: number;
  name: string;
  run: () => PromiseLike<unknown> | unknown;
  afterAbandonedSteps: boolean;
}

export interface TeardownStepOptions {
  /** Run after every step that passed its limit has ended, or at half the step limit. */
  afterAbandonedSteps?: boolean;
}

export class TeardownRegistry {
  readonly #reportError: (name: string, error: unknown) => void;
  readonly #report: (message: string) => void;
  readonly #stepTimeoutMs: number;
  readonly #budgetMs: number;
  #steps: TeardownStep[] = [];
  /** The sorted steps a drain in progress has not reached yet. Late pushes are spliced into it. */
  #pending: TeardownStep[] | null = null;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  /** Steps that passed their limit and still run. Each removes itself when it ends. */
  readonly #abandoned = new Set<Promise<unknown>>();
  /** Set when the drain starts. */
  #budgetEndsAt: number | null = null;
  #budgetReported = false;

  constructor({
    reportError,
    report = () => undefined,
    stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    budgetMs = DEFAULT_BUDGET_MS,
  }: TeardownRegistryOptions) {
    this.#reportError = reportError;
    this.#report = report;
    this.#stepTimeoutMs = stepTimeoutMs;
    this.#budgetMs = budgetMs;
  }

  /** `order` is the position in the shutdown sequence, not the position in this call sequence. */
  push(
    order: number,
    name: string,
    run: () => PromiseLike<unknown> | unknown,
    { afterAbandonedSteps = false }: TeardownStepOptions = {},
  ): void {
    const step = { order, name, run, afterAbandonedSteps };
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
    this.#budgetEndsAt = Date.now() + this.#budgetMs;
    const pending = [...this.#steps].sort((left, right) => left.order - right.order);
    this.#steps = [];
    this.#pending = pending;
    // `shift` rather than iteration: `push` splices into this same array while the loop awaits.
    for (let step = pending.shift(); step; step = pending.shift()) await this.#runStep(step);
    this.#pending = null;
  }

  /** The step limit, or what is left of the budget when that is less, but never below a short wait. */
  #limit(step: TeardownStep): number {
    if (step.afterAbandonedSteps || this.#budgetEndsAt === null) return this.#stepTimeoutMs;
    const left = this.#budgetEndsAt - Date.now();
    if (left <= LATE_STEP_TIMEOUT_MS && !this.#budgetReported) {
      this.#budgetReported = true;
      this.#report(
        `The shutdown steps used their ${this.#budgetMs} ms. Each step that is left, from "${step.name}", gets ${LATE_STEP_TIMEOUT_MS} ms.`,
      );
    }
    return Math.min(this.#stepTimeoutMs, Math.max(LATE_STEP_TIMEOUT_MS, left));
  }

  async #runStep(step: TeardownStep): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = this.#limit(step);
    // From the step's own start: the wait of the database step for abandoned steps is not its own.
    let startedAt = Date.now();
    const running = (step.afterAbandonedSteps ? this.#abandonedSettled() : Promise.resolve()).then(() => {
      startedAt = Date.now();
      return step.run();
    });
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        this.#reportError(step.name, new Error(`It did not stop within ${limit} ms.`));
        // The step is abandoned, not cancelled: it keeps running, but the steps after it no longer wait.
        const abandoned = running.then(
          () => this.#reportSlow(step.name, startedAt),
          (error) => this.#reportError(step.name, error),
        );
        this.#abandoned.add(abandoned);
        void abandoned.finally(() => this.#abandoned.delete(abandoned));
        resolve(TIMED_OUT);
      }, limit);
    });
    try {
      if ((await Promise.race([running, timedOut])) !== TIMED_OUT) this.#reportSlow(step.name, startedAt);
    } catch (error) {
      this.#reportError(step.name, error);
    } finally {
      clearTimeout(timer);
    }
  }

  #reportSlow(name: string, startedAt: number): void {
    const durationMs = Date.now() - startedAt;
    if (durationMs >= SLOW_STEP_MS) this.#report(`Shutting down ${name} took ${durationMs} ms.`);
  }

  async #abandonedSettled(): Promise<void> {
    if (this.#abandoned.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitEnded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#stepTimeoutMs / 2);
    });
    await Promise.race([Promise.allSettled([...this.#abandoned]), waitEnded]);
    clearTimeout(timer);
  }
}
