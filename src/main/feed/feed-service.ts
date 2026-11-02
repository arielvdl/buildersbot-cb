/**
 * The feed of the main process: `FeedAggregator` plus the batch timer, the windows that watch and the
 * reads of this computer's load. No Electron here either: `ipc/feed-handlers.ts` turns a window into a
 * `FeedWatcher`, so an E2E script runs this class as it is.
 *
 * - Every agent event of every server comes in through `ingest`, from `forwardAgentEvent`. It costs a
 *   few map reads, also while no window watches, so the page has the recent runs when it opens.
 * - A change marks its card. At most every `FEED_BATCH_MS` the marked cards go out as one delta, at most
 *   `FEED_DELTA_LIMIT` of them, each card once: at most `FEED_DELTAS_PER_SECOND` deltas a second.
 * - Nothing goes out while no window watches. A window that starts to watch reads the snapshot.
 * - Nothing is written to disk.
 */

import {
  type AgentEvent,
  type AgentPromptQuestion,
  type AgentRuntimeSnapshot,
  FEED_CONTRACT_VERSION,
  FEED_DELTA_LIMIT,
  FEED_DELTAS_PER_SECOND,
  FEED_SNAPSHOT_LIMIT,
  type FeedDelta,
  type FeedItem,
  type FeedSnapshot,
  LOCAL_SERVER_ID,
  type SidebarLayoutSnapshot,
} from "@openbot/contracts/ipc";
import { redactMcpValues } from "../../backend/mcp-redaction";
import { FeedAggregator, type FeedLoadWork, feedSimpleQuestion } from "./feed-aggregator";

/** The shortest time between two deltas. */
export const FEED_BATCH_MS = 1_000 / FEED_DELTAS_PER_SECOND;
/** How often the load of this computer is read while a window watches. */
export const FEED_LOAD_MS = 5_000;
const SWEEP_MS = 60_000;

/** A window that shows the feed page. `send` answers false when the window cannot take it any more. */
export interface FeedWatcher {
  readonly id: number;
  send(delta: FeedDelta): boolean;
}

export interface FeedServiceOptions {
  /** The secrets that only a configuration knows, such as the values of the MCP servers. */
  secretValues?: (() => Iterable<string>) | undefined;
  /** The name of an agent of this computer that no event has named yet. */
  resolveName?: ((serverId: string, agentId: string) => string | null) | undefined;
  /** The running and stopped work of this computer. Read while a window watches. */
  readLoad?: (() => FeedLoadWork | null) | undefined;
  /** The runs and requests of this computer now, read when the first window starts to watch. */
  readLocalRuntime?: (() => AgentRuntimeSnapshot | null) | undefined;
  /** The sections of this computer's agents, read when the first window starts to watch. */
  readLocalLayout?: (() => SidebarLayoutSnapshot | null) | undefined;
  /** Reports a read that failed. The feed keeps what it has. */
  onError?: ((operation: string, cause: unknown) => void) | undefined;
  now?: (() => number) | undefined;
  limit?: number | undefined;
}

export interface FeedStats {
  ingested: number;
  /** Time spent in `ingest`, in milliseconds. */
  ingestMs: number;
  deltasSent: number;
  cardsSent: number;
  /** Time spent building and sending deltas, in milliseconds. */
  flushMs: number;
  cards: number;
  watchers: number;
}

export class FeedService {
  readonly #aggregator: FeedAggregator;
  readonly #options: FeedServiceOptions;
  readonly #redact: (text: string) => string;
  readonly #watchers = new Map<number, FeedWatcher>();
  readonly #drains: Array<() => void> = [];
  #cursor = 0;
  #lastFlush = Number.NEGATIVE_INFINITY;
  #lastSweep = 0;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #loadTimer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;
  readonly #stats = { ingested: 0, ingestMs: 0, deltasSent: 0, cardsSent: 0, flushMs: 0 };

  constructor(options: FeedServiceOptions = {}) {
    this.#options = options;
    const secretValues = options.secretValues;
    this.#redact = (text) => redactMcpValues(text, secretValues?.() ?? []);
    this.#aggregator = new FeedAggregator({
      redact: this.#redact,
      resolveName: options.resolveName,
      now: options.now,
      limit: options.limit,
    });
  }

  ingest(serverId: string, event: AgentEvent): void {
    if (this.#disposed) return;
    const started = performance.now();
    this.#aggregator.ingest(serverId, event);
    this.#stats.ingestMs += performance.now() - started;
    this.#stats.ingested += 1;
    this.#schedule();
  }

  ingestLoad(work: FeedLoadWork, serverId = LOCAL_SERVER_ID): void {
    if (this.#disposed) return;
    const started = performance.now();
    this.#aggregator.ingestLoad(serverId, work);
    this.#stats.ingestMs += performance.now() - started;
    this.#schedule();
  }

  /** Every card, the newest `limit` of them, with the cursor of the last delta they include. */
  snapshot(limit: number = FEED_SNAPSHOT_LIMIT): FeedSnapshot {
    this.#sweep(true);
    const { items, truncated } = this.#aggregator.items(Math.min(limit, FEED_SNAPSHOT_LIMIT));
    return { v: FEED_CONTRACT_VERSION, cursor: this.#cursor, items, truncated };
  }

  /** One card as main holds it now, for the feed actions. */
  card(id: string): Readonly<FeedItem> | undefined {
    return this.#aggregator.card(id);
  }

  /** The turn of a card that runs now, or null. */
  runningTurn(id: string): string | null {
    return this.#aggregator.runningTurn(id);
  }

  /** The question that a card can answer itself, by the rule and the redaction of the cards. */
  simpleQuestion(questions: readonly AgentPromptQuestion[]): AgentPromptQuestion | null {
    return feedSimpleQuestion(questions, this.#redact);
  }

  /** Reads this computer's load again now, after an action changed it, so the cards follow at once. */
  refreshLoad(): void {
    this.#readLoad();
  }

  /** A window starts or stops to watch. The first window reads this computer's runs and load. */
  setWatching(watcher: FeedWatcher, watching: boolean): void {
    if (this.#disposed) return;
    if (!watching) {
      this.removeWatcher(watcher.id);
      return;
    }
    const first = this.#watchers.size === 0;
    this.#watchers.set(watcher.id, watcher);
    if (!first) return;
    this.#aggregator.setTracking(true);
    this.#readLocal();
    this.#readLoad();
    this.#loadTimer = setInterval(() => this.#readLoad(), FEED_LOAD_MS);
    this.#loadTimer.unref?.();
  }

  removeWatcher(id: number): void {
    if (!this.#watchers.delete(id) || this.#watchers.size > 0) return;
    this.#aggregator.setTracking(false);
    if (this.#loadTimer) clearInterval(this.#loadTimer);
    this.#loadTimer = null;
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    this.#resolveDrains();
  }

  /** Resolves when every change has gone out to the windows that watch, or at once when none watches. */
  drain(): Promise<void> {
    if (this.#watchers.size === 0 || !this.#aggregator.hasChanges()) return Promise.resolve();
    return new Promise((resolve) => this.#drains.push(resolve));
  }

  stats(): FeedStats {
    return { ...this.#stats, cards: this.#aggregator.size, watchers: this.#watchers.size };
  }

  dispose(): void {
    this.#disposed = true;
    for (const id of [...this.#watchers.keys()]) this.removeWatcher(id);
  }

  #schedule(): void {
    if (this.#flushTimer || this.#watchers.size === 0 || !this.#aggregator.hasChanges()) return;
    const wait = Math.max(0, this.#lastFlush + FEED_BATCH_MS - performance.now());
    this.#flushTimer = setTimeout(() => this.#flush(), Math.ceil(wait));
    this.#flushTimer.unref?.();
  }

  #flush(): void {
    this.#flushTimer = null;
    const now = performance.now();
    // A timer can fire a little early; the batch period is a promise to the window.
    if (now < this.#lastFlush + FEED_BATCH_MS) {
      this.#schedule();
      return;
    }
    this.#lastFlush = now;
    this.#sweep(false);
    const { upserts, removes } = this.#aggregator.takeChanges(FEED_DELTA_LIMIT);
    if (upserts.length > 0 || removes.length > 0) {
      const delta: FeedDelta = { v: FEED_CONTRACT_VERSION, cursor: ++this.#cursor, upserts, removes };
      for (const watcher of [...this.#watchers.values()]) {
        if (!watcher.send(delta)) this.removeWatcher(watcher.id);
      }
      this.#stats.deltasSent += 1;
      this.#stats.cardsSent += upserts.length;
    }
    this.#stats.flushMs += performance.now() - now;
    if (!this.#aggregator.hasChanges()) this.#resolveDrains();
    this.#schedule();
  }

  #resolveDrains(): void {
    for (const resolve of this.#drains.splice(0)) resolve();
  }

  #sweep(force: boolean): void {
    const now = (this.#options.now ?? Date.now)();
    if (!force && now - this.#lastSweep < SWEEP_MS) return;
    this.#lastSweep = now;
    this.#aggregator.sweep();
  }

  #readLocal(): void {
    try {
      const layout = this.#options.readLocalLayout?.();
      if (layout) this.#aggregator.ingest(LOCAL_SERVER_ID, { type: "sidebar-layout-changed", layout });
      const runtime = this.#options.readLocalRuntime?.();
      if (runtime) this.#aggregator.ingest(LOCAL_SERVER_ID, { type: "runtime-snapshot", snapshot: runtime });
    } catch (cause) {
      this.#options.onError?.("read the runs of this computer", cause);
    }
    this.#schedule();
  }

  #readLoad(): void {
    try {
      const work = this.#options.readLoad?.();
      if (work) this.ingestLoad(work);
    } catch (cause) {
      this.#options.onError?.("read the load of this computer", cause);
    }
  }
}
