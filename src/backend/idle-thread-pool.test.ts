// @vitest-environment node
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IdleThread, IdleThreadPool } from "./idle-thread-pool";

// Failure modes: an idle process is never released because the provider stopped answering
// `canRelease`; a thread in a turn is closed; a released thread cannot be opened again; the retry
// timer fires after the thread is already gone. Each case below covers one.

const RELEASE_AFTER = 10 * 60_000;
const FORCE_AFTER = 30 * 60_000;

interface FakeThread extends IdleThread {
  released: boolean;
  reopened: number;
  background: number;
}

describe("IdleThreadPool", () => {
  let disposed: string[];
  let pool: IdleThreadPool<FakeThread, { id: string }>;
  let releasable: Set<string>;
  let scope: Scope.Closeable;

  function thread(id: string): FakeThread {
    return { id, activeTurn: null, idleRelease: null, idleSince: 0, released: false, reopened: 0, background: 0 };
  }

  function makePool(overrides: { idleLimit?: number } = {}) {
    scope = Scope.makeUnsafe();
    pool = new IdleThreadPool<FakeThread, { id: string }>({
      releaseAfterMs: RELEASE_AFTER,
      forceReleaseAfterMs: FORCE_AFTER,
      idleLimit: overrides.idleLimit ?? 5,
      scope: () => scope,
      canRelease: (candidate) => releasable.has(candidate.id) && candidate.background === 0,
      snapshot: (candidate) => ({ id: candidate.id }),
      dispose: (candidate) =>
        Effect.sync(() => {
          candidate.released = true;
          disposed.push(candidate.id);
        }),
      reopen: (id) =>
        Effect.sync(() => {
          const reopened = thread(id);
          reopened.reopened += 1;
          pool.add(reopened);
        }),
    });
    return pool;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    disposed = [];
    releasable = new Set();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("releases an idle thread after the timeout", async () => {
    const candidate = thread("a");
    releasable.add("a");
    makePool().add(candidate);
    await vi.advanceTimersByTimeAsync(RELEASE_AFTER + 1);
    expect(disposed).toEqual(["a"]);
  });

  it("keeps a thread that is in a turn", async () => {
    const candidate = thread("a");
    releasable.add("a");
    const made = makePool();
    made.add(candidate);
    candidate.activeTurn = {};
    made.holdForTurn(candidate);
    await vi.advanceTimersByTimeAsync(RELEASE_AFTER * 2);
    expect(disposed).toEqual([]);
  });

  it("retries a thread that cannot be released yet, and releases it once it can", async () => {
    const candidate = thread("a");
    const made = makePool();
    made.add(candidate);
    await vi.advanceTimersByTimeAsync(RELEASE_AFTER + 1);
    expect(disposed).toEqual([]);
    // The provider starts answering `canRelease` again.
    releasable.add("a");
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    expect(disposed).toEqual(["a"]);
  });

  it("releases a thread that never becomes releasable once the hard cap passes", async () => {
    const candidate = thread("a");
    const made = makePool();
    made.add(candidate);
    // Under the cap: still held.
    await vi.advanceTimersByTimeAsync(FORCE_AFTER - 60_000);
    expect(disposed).toEqual([]);
    // Past the cap: taken anyway, so the process cannot be held for the life of the app.
    await vi.advanceTimersByTimeAsync(60_000 * 2);
    expect(disposed).toEqual(["a"]);
  });

  it("keeps a released thread openable, and opens it again", async () => {
    const candidate = thread("a");
    releasable.add("a");
    const made = makePool();
    made.add(candidate);
    await vi.advanceTimersByTimeAsync(RELEASE_AFTER + 1);
    expect(made.isReleased("a")).toBe(true);
    await Effect.runPromise(made.wake("a"));
    expect(made.isReleased("a")).toBe(false);
    expect(made.get("a")?.reopened).toBe(1);
  });
});
