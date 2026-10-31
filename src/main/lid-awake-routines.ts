// Routines while the lid-closed mode keeps a Mac on. See docs/architecture/lid-awake.md.

/** A sleep shorter than this is clock noise. */
const SLEPT_MS = 5_000;
/** macOS sleeps in seconds after it tells the apps. A Mac still on after this time stays on. */
const DARK_WAKE_CHECK_MS = 30_000;

function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export interface LidAwakeRoutinesOptions {
  routineWake: { suspend(): void; resume(): void };
  /** True while the lid-closed mode keeps the Mac on. */
  holds: () => boolean;
  log: (message: string) => void;
  checkMs?: number;
}

/**
 * When the lid closes, macOS tells the apps that the computer sleeps, and Electron sends `suspend`,
 * also when an assertion then keeps the computer in dark wake. Routines are held first, as for
 * every sleep. If the clock that stops in sleep moved with the wall clock 30 seconds later, the
 * computer did not sleep, and the routines run again. A real sleep freezes the timer; at the wake,
 * the wall clock is ahead, and `resume` starts the routines as before.
 */
export class LidAwakeRoutines {
  readonly #options: LidAwakeRoutinesOptions;
  #check: NodeJS.Timeout | null = null;
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
    const wallMs = Date.now();
    const monoMs = monotonicMs();
    this.#check = setTimeout(() => {
      this.#check = null;
      const slept = Date.now() - wallMs - (monotonicMs() - monoMs);
      if (slept > SLEPT_MS || !this.#options.holds()) return;
      this.#options.log("The lid-closed mode keeps this computer on in dark wake. Routines run again.");
      this.#resumedInDarkWake = true;
      this.#options.routineWake.resume();
    }, this.#options.checkMs ?? DARK_WAKE_CHECK_MS);
    this.#check.unref?.();
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
    if (this.#check) clearTimeout(this.#check);
    this.#check = null;
  }
}
