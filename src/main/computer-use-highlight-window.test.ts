import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerUseHighlightController, type HighlightOverlayWindow } from "./computer-use-highlight-window";
import type { ComputerUseHighlightTarget } from "./computer-use-target-window";

class FakeOverlay implements HighlightOverlayWindow {
  #visible = false;
  #destroyed = false;
  setBounds(): void {}
  showInactive(): void {
    this.#visible = true;
  }
  hide(): void {
    this.#visible = false;
  }
  destroy(): void {
    this.#destroyed = true;
  }
  isDestroyed(): boolean {
    return this.#destroyed;
  }
  isVisible(): boolean {
    return this.#visible;
  }
}

const TARGET: ComputerUseHighlightTarget = {
  windowId: 7,
  title: "Notes",
  bounds: { x: 10, y: 20, width: 300, height: 200 },
  covered: [],
};

/** A controller over fake overlays, and how many times it read the driver. */
function controller(target: () => ComputerUseHighlightTarget | null) {
  const reads = { count: 0 };
  const highlight = new ComputerUseHighlightController<FakeOverlay>({
    createWindow: () => new FakeOverlay(),
    loadWindow: async () => undefined,
    place: () => undefined,
    displays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }],
    readTarget: () =>
      Effect.sync(() => {
        reads.count += 1;
        return target();
      }),
    pollIntervalMs: 33,
    idlePollIntervalMs: 1_000,
  });
  return { highlight, reads };
}

/** Lets the ticks that the timers started finish: each read and placement settles in microtasks. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 11) {
    vi.advanceTimersByTime(11);
    await settle();
  }
}

describe("ComputerUseHighlightController pace", () => {
  beforeEach(() => {
    // Only the polling timer and the clock: Effect schedules its own work on the real timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the driver once a second while no agent holds the desktop", async () => {
    const { highlight, reads } = controller(() => null);
    highlight.start();
    await settle();
    expect(reads.count).toBe(1);

    await advance(3_000);
    // Thirty a second would be about ninety here.
    expect(reads.count).toBe(4);
    highlight.destroy();
  });

  it("follows the window at the fast interval while the rim is up", async () => {
    const { highlight, reads } = controller(() => TARGET);
    highlight.start();
    await settle();
    expect(highlight.visible).toBe(true);

    const before = reads.count;
    await advance(330);
    expect(reads.count - before).toBeGreaterThanOrEqual(9);
    highlight.destroy();
  });

  it("reads at once on an agent action, and goes back to the idle interval after it", async () => {
    let held = false;
    const { highlight, reads } = controller(() => (held ? TARGET : null));
    highlight.start();
    await settle();

    // The first action reaches the tap before the daemon shows a live session.
    highlight.wake();
    await settle();
    expect(reads.count).toBe(2);
    await advance(330);
    expect(reads.count).toBeGreaterThanOrEqual(11);

    held = true;
    await advance(66);
    expect(highlight.visible).toBe(true);

    held = false;
    await advance(3_000);
    expect(highlight.visible).toBe(false);
    const afterAction = reads.count;
    await advance(2_000);
    expect(reads.count - afterAction).toBe(2);
    highlight.destroy();
  });

  it("does nothing on an action while it is stopped", async () => {
    const { highlight, reads } = controller(() => TARGET);
    highlight.wake();
    await settle();
    expect(reads.count).toBe(0);
    expect(highlight.visible).toBe(false);
  });
});
