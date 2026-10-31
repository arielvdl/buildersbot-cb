// Routines while the lid-closed mode keeps a Mac on. See docs/architecture/lid-awake.md.

import { sleptSince } from "./lid-awake-policy";

/** macOS sleeps in seconds after it tells the apps. A Mac still on after this time stays on. */
const DARK_WAKE_CHECK_MS = 30_000;
/** The check runs as a chain of short timers, so a stop of the app shows as a late timer. */
const TICK_MS = 5_000;
/** A timer this many ticks late shows that the app did not run: the Mac slept, or the app stopped. */
const LATE_TICKS = 3;

export interface LidAwakeRoutinesOptions {
  routineWake: { suspend(): void; resume(): void };
  /** True while the lid-closed mode keeps the Mac on, from the state that main has now. */
  holds: () => boolean;
  /** Reads the computer again, then tells if the lid-closed mode keeps the Mac on. */
  confirmHolds: () => Promise<boolean>;
  /** `kern.sleeptime`: when macOS last went to sleep, or null when it cannot be read. */
  lastSleep: () => Promise<number | null>;
  log: (message: string) => void;
  checkMs?: number;
  tickMs?: number;
  /** The wall clock. Tests give a clock that jumps, as the real one does after a sleep. */
  now?: () => number;
}

/**
 * When the lid closes, macOS tells the apps that the computer sleeps, and Electron sends `suspend`,
 * also when an assertion then keeps the computer in dark wake. Routines are held first, as for
 * every sleep. They run again 30 seconds later only when all of these are true:
 *
 * - each timer of the check came on time, so the app ran all the time;
 * - the kernel recorded no sleep after `suspend` (`kern.sleeptime`);
 * - a new read of the computer shows that the lid-closed mode keeps the Mac on.
 *
 * Node timers count the time in sleep too, so a timer can come in a short maintenance wake after a
 * real sleep. The two first checks find this case. At a real wake, `resume` starts the routines.
 */
export class LidAwakeRoutines {
  readonly #options: LidAwakeRoutinesOptions;
  #timer: NodeJS.Timeout | null = null;
  /** Each `suspend`, `resume` and `dispose` stops the check that runs. */
  #generation = 0;
  /** The routines run again in dark wake, so the end of the hold must hold them again. */
  #resumedInDarkWake = false;

  constructor(options: LidAwakeRoutinesOptions) {
    this.#options = options;
  }

  suspend(): void {
    this.dispose();
    this.#resumedInDarkWake = false;
    this.#options.routineWake.suspend();
    if (!this.#options.holds()) return;
    const now = this.#options.now ?? Date.now;
    const tickMs = this.#options.tickMs ?? TICK_MS;
    const checkMs = this.#options.checkMs ?? DARK_WAKE_CHECK_MS;
    const generation = this.#generation;
    const suspendedAt = now();
    let last = suspendedAt;
    const tick = () => {
      this.#timer = null;
      const at = now();
      // The app did not run for a time: the Mac slept, or the app stopped. `resume` comes at a wake.
      if (at - last > tickMs * LATE_TICKS) return;
      last = at;
      if (at - suspendedAt < checkMs) this.#schedule(tick, tickMs);
      else void this.#confirm(generation, suspendedAt);
    };
    this.#schedule(tick, tickMs);
  }

  resume(): void {
    this.dispose();
    this.#resumedInDarkWake = false;
    this.#options.routineWake.resume();
  }

  /**
   * The hold ended, or the power adapter was removed, while the routines run in dark wake. macOS then
   * sleeps from dark wake and sends no new `suspend`, so the routines are held again now. When the
   * hold continues (the `battery` mode), the check of `suspend` starts them again 30 seconds later.
   */
  holdMayEnd(): void {
    if (this.#resumedInDarkWake) this.suspend();
  }

  dispose(): void {
    this.#generation += 1;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(tick: () => void, delayMs: number): void {
    this.#timer = setTimeout(tick, delayMs);
    this.#timer.unref?.();
  }

  async #confirm(generation: number, suspendedAt: number): Promise<void> {
    try {
      const lastSleep = await this.#options.lastSleep();
      if (generation !== this.#generation) return;
      // An unknown time is no proof that the Mac stayed on.
      if (lastSleep === null || sleptSince(lastSleep, suspendedAt)) return;
      const holds = await this.#options.confirmHolds();
      if (!holds || generation !== this.#generation) return;
      this.#options.log("The lid-closed mode keeps this computer on in dark wake. Routines run again.");
      this.#resumedInDarkWake = true;
      this.#options.routineWake.resume();
    } catch (error) {
      this.#options.log(`The lid-closed mode could not check for sleep: ${String(error)}`);
    }
  }
}
