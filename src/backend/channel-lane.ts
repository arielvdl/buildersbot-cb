/**
 * The one-channel-at-a-time lane. While the mode is on, a channel starts work only when no other
 * channel does, so the agents of many channels do not run, and hold memory, all at once.
 *
 * This file only decides. It holds no state and never stops work: a channel that already works
 * keeps working, and the lane only chooses which waiting channel starts next.
 */

/**
 * The next channel to start: the first of the user's order that has work, else the one that has
 * waited longest. `runnable` is in the order the channels began to wait.
 */
export function nextLaneChannel(order: readonly string[], runnable: readonly string[]): string | undefined {
  const waiting = new Set(runnable);
  return order.find((id) => waiting.has(id)) ?? runnable[0];
}

export interface LaneInput {
  enabled: boolean;
  /** The channels in the order the user chose. */
  order: readonly string[];
  /** The channels with work that could start, in the order they began to wait. */
  runnable: readonly string[];
  /** The channels that work now: a pump runs or an assignment is active. */
  busy: ReadonlySet<string>;
  /** The channels the user chose to run now, beside the lane. */
  forced: ReadonlySet<string>;
  /** The channel a wake names, if it names one. */
  requested?: string | undefined;
}

/**
 * The channels whose pump may run now, or null when the mode is off and every channel may.
 * A busy channel always may, because its next task needs its pump. No new channel joins while one
 * is busy.
 */
export function admittedChannels(input: LaneInput): ReadonlySet<string> | null {
  if (!input.enabled) return null;
  const admitted = new Set<string>([...input.busy, ...input.forced]);
  if (input.busy.size > 0) return admitted;
  const next = nextLaneChannel(input.order, input.runnable) ?? input.requested;
  if (next !== undefined) admitted.add(next);
  return admitted;
}
