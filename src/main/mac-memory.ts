import { execFile } from "node:child_process";
import type { HostMemory, HostMemoryLevel } from "../backend/host-memory";

const SAMPLE_INTERVAL_MS = 10_000;
const COMMAND_TIMEOUT_MS = 5_000;
/** A desktop does not cap the turns that run together: only the level holds a new one. */
const DESKTOP_TURN_LIMIT = 64;

/**
 * The thresholds, in percent of memory that macOS says is free. The used swap is a high-water mark on
 * macOS, so it counts only together with little free memory, as the browser gate counts it.
 */
const LOW_BELOW = 14;
const CRITICAL_BELOW = 8;
const LOW_SWAP_MB = 6_000;
const LOW_SWAP_FREE_BELOW = 25;
const CRITICAL_SWAP_MB = 9_000;
const CRITICAL_SWAP_FREE_BELOW = 15;
/** A level is left only this far past the threshold that entered it, so it does not flap. */
const RECOVER_MARGIN_PERCENT = 6;

export interface MacMemorySample {
  freePercent: number;
  swapUsedMb: number;
}

/** `System-wide memory free percentage: 82%` of `memory_pressure`, or null. */
export function parseFreePercent(text: string): number | null {
  const match = /System-wide memory free percentage:\s*(\d{1,3})%/u.exec(text);
  const value = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

/** The used swap of `sysctl vm.swapusage`, in whole MB, or null. */
export function parseSwapUsedMb(text: string): number | null {
  const match = /used\s*=\s*([\d.]+)M/u.exec(text);
  const value = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) ? Math.round(value) : null;
}

const ORDER: Record<HostMemoryLevel, number> = { ok: 0, low: 1, critical: 2 };

function levelAt(sample: MacMemorySample, margin: number): HostMemoryLevel {
  if (
    sample.freePercent < CRITICAL_BELOW + margin ||
    (sample.swapUsedMb > CRITICAL_SWAP_MB && sample.freePercent < CRITICAL_SWAP_FREE_BELOW + margin)
  )
    return "critical";
  if (
    sample.freePercent < LOW_BELOW + margin ||
    (sample.swapUsedMb > LOW_SWAP_MB && sample.freePercent < LOW_SWAP_FREE_BELOW + margin)
  )
    return "low";
  return "ok";
}

/** The level of a sample, given the one before: up at once, down only past the margin. */
export function classifyMacMemory(sample: MacMemorySample, previous: HostMemoryLevel): HostMemoryLevel {
  const entering = levelAt(sample, 0);
  if (ORDER[entering] >= ORDER[previous]) return entering;
  const staying = levelAt(sample, RECOVER_MARGIN_PERCENT);
  return ORDER[staying] < ORDER[previous] ? staying : previous;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

/** Reads the memory of this Mac. Null when macOS gives no number, and the level then stays as it was. */
export async function readMacMemory(): Promise<MacMemorySample | null> {
  const [pressure, swap] = await Promise.all([
    run("/usr/bin/memory_pressure", []),
    run("/usr/sbin/sysctl", ["vm.swapusage"]),
  ]);
  const freePercent = parseFreePercent(pressure);
  const swapUsedMb = parseSwapUsedMb(swap);
  return freePercent === null ? null : { freePercent, swapUsedMb: swapUsedMb ?? 0 };
}

export interface MacMemoryOptions {
  read?: () => Promise<MacMemorySample | null>;
  /** Called one time when the memory cannot be read (the level then stays as it was). */
  onError: (message: string, error?: unknown) => void;
  intervalMs?: number;
}

/**
 * How much memory this Mac has left, for the agents. On a desktop nothing stopped a few agents, each
 * with its own MCP servers, from filling the memory until macOS asked for apps to be closed. This holds
 * a new turn while the memory is low, and at a critical level closes the idle provider threads, through
 * the same `MemoryHold` that a server uses. It reads macOS every 10 s and never throws.
 */
export class MacMemory implements HostMemory {
  readonly hostedPlan = false;
  readonly kind = "desktop" as const;
  readonly #read: () => Promise<MacMemorySample | null>;
  readonly #onError: MacMemoryOptions["onError"];
  readonly #intervalMs: number;
  readonly #listeners = new Set<() => void>();
  #level: HostMemoryLevel = "ok";
  #last: MacMemorySample | null = null;
  #sampling: Promise<void> | null = null;
  #reported = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: MacMemoryOptions) {
    this.#read = options.read ?? readMacMemory;
    this.#onError = options.onError;
    this.#intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  }

  level(): HostMemoryLevel {
    return this.#level;
  }

  turnLimit(): number {
    return DESKTOP_TURN_LIMIT;
  }

  reserveTurn(): () => void {
    return () => {};
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The last reading, for the load panel, or null before the first one. */
  reading(): { level: HostMemoryLevel; freePercent: number; swapUsedMb: number } | null {
    return this.#last ? { level: this.#level, ...this.#last } : null;
  }

  start(): void {
    if (this.#timer) return;
    void this.sample();
    this.#timer = setInterval(() => void this.sample(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One sample. A sample that runs is not started twice. */
  sample(): Promise<void> {
    this.#sampling ??= this.#take().finally(() => {
      this.#sampling = null;
    });
    return this.#sampling;
  }

  async #take(): Promise<void> {
    let sample: MacMemorySample | null = null;
    try {
      sample = await this.#read();
    } catch (error) {
      sample = null;
      if (!this.#reported) {
        this.#reported = true;
        this.#onError("The memory of this Mac could not be read, so agents are not held for it.", error);
      }
    }
    if (!sample) {
      if (!this.#reported) {
        this.#reported = true;
        this.#onError("macOS gave no free-memory number, so agents are not held for it.");
      }
      return;
    }
    this.#last = sample;
    this.#level = classifyMacMemory(sample, this.#level);
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#onError("A memory listener failed.", error);
      }
    }
  }
}
