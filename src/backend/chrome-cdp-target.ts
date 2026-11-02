/**
 * A tab of the person's Chrome, as `BrowserCdpEngine` drives it: the `CdpTarget` seam over the Builders
 * Bot extension (DESIGN §5.4, §10.1). Each CDP command goes to the extension, which checks it against
 * its closed lists before Chrome runs it; this side only carries it.
 *
 * - The debugger stays attached for the agent's lease (`retention: "lease"`). The extension attaches at
 *   the first command of a lease and detaches when the lease ends, so Chrome's debugging bar does not
 *   flash at each tool call. `attach` here is the engine's own claim: it costs no message.
 * - Commands that the engine sends in the same turn of the event loop (the snapshot sends hundreds at
 *   once) leave in one `cdp.batch` message, up to the protocol's limit, when the extension has that
 *   feature. A command that is alone goes as `cdp.send`. The extension keeps their order in the tab.
 * - The page state (address, title, loading) comes from the extension's `tab.updated` events, which
 *   Chrome sends for each tab whether or not a debugger is attached; nothing here polls.
 * - Navigation events: `tab.updated` with `status: "loading"` starts one, and `complete` ends it. A new
 *   address with no load is a same-document navigation.
 */

import { BRIDGE_LIMITS } from "@openbot/contracts/chrome-bridge/protocol";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { NativeImage } from "electron";
import type { CdpEventListener, CdpRetention, CdpTarget } from "./browser-cdp-target";
import { type BrowserOperationError, browserFailure } from "./browser-effects";

/** One command of a batch, and its outcome. */
export interface ChromeCdpCommand {
  readonly method: string;
  readonly params: DynamicRecord;
  readonly session?: string;
}
export type ChromeCdpOutcome = { readonly result: unknown } | { readonly error: Error };

/** How a target reaches its tab: the bridge requests of `ChromeTabsHost`, bound to one handle. */
export interface ChromeTabChannel {
  send(command: ChromeCdpCommand): Promise<unknown>;
  /** Several independent commands in one message. Absent when the extension did not announce it. */
  readonly batch?: (commands: readonly ChromeCdpCommand[]) => Promise<readonly ChromeCdpOutcome[]>;
  stopLoading(): Promise<void>;
}

/** What the extension last said of the tab. */
export interface ChromeTabState {
  readonly url?: string;
  readonly title?: string;
  readonly status?: "loading" | "complete" | "unloaded";
}

const NAVIGATION_TIMED_OUT = "Navigation timed out.";
const TAB_CLOSED = "Browser tab was closed during navigation.";
const STOP_WAIT_MS = 2_000;

type Waiter = { readonly done: (error?: Error) => void };

export class ChromeCdpTarget implements CdpTarget {
  readonly retention: CdpRetention = "lease";
  /** Chrome closes its own dialog when CDP answers it. */
  readonly dialogBox = null;
  readonly #channel: ChromeTabChannel;
  #url: string;
  #title: string;
  #loading: boolean;
  #closed = false;
  /** The engine's claim on the debugger; the extension holds the real one for the lease. */
  #claimed = false;
  #zoom = 1;
  /** Counts each status event, so a wait knows which load it waits for. */
  #statusSeq = 0;
  #lastLoadingSeq = 0;
  #lastCompleteSeq = 0;
  readonly #navigationStarted = new Set<(mainFrame: boolean) => void>();
  readonly #mainFrameNavigated = new Set<() => void>();
  readonly #events = new Set<CdpEventListener>();
  readonly #detached = new Set<() => void>();
  /** Waits for the end of a load: resolved on `complete`, failed when the tab closes. */
  readonly #loadWaiters = new Set<Waiter>();
  /** Waits for any page signal: the end of a load or a navigation in place. */
  readonly #signalWaiters = new Set<Waiter>();
  /** Waits that read the state again after each event. */
  readonly #stateWaiters = new Set<() => void>();
  #pending: { command: ChromeCdpCommand; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  #flushScheduled = false;

  constructor(channel: ChromeTabChannel, initial: ChromeTabState = {}) {
    this.#channel = channel;
    this.#url = initial.url ?? "about:blank";
    this.#title = initial.title ?? "";
    this.#loading = initial.status === "loading";
  }

  // -------------------------------------------------------------------------------------------------
  // What the host tells the target

  /** A `tab.updated` event of this tab. */
  receiveTabState(state: ChromeTabState): void {
    if (this.#closed) return;
    const previousUrl = this.#url;
    if (state.title !== undefined) this.#title = state.title;
    if (state.status === "loading") {
      this.#statusSeq += 1;
      this.#lastLoadingSeq = this.#statusSeq;
      const wasLoading = this.#loading;
      this.#loading = true;
      if (!wasLoading) for (const listener of this.#navigationStarted) listener(true);
    }
    if (state.url !== undefined && state.url !== previousUrl) {
      this.#url = state.url;
      if (state.status === "loading" || this.#loading) {
        for (const listener of this.#mainFrameNavigated) listener();
      } else {
        // A new address with no load: a navigation in place, such as `pushState`.
        for (const listener of this.#navigationStarted) listener(true);
        this.#settle(this.#signalWaiters);
      }
    }
    if (state.status === "complete" || state.status === "unloaded") {
      this.#statusSeq += 1;
      this.#lastCompleteSeq = this.#statusSeq;
      this.#loading = false;
      this.#settle(this.#loadWaiters);
      this.#settle(this.#signalWaiters);
    }
    for (const check of [...this.#stateWaiters]) check();
  }

  /** A `cdp.event` of this tab, already reduced by the extension to its allowed fields. */
  receiveCdpEvent(method: string, params: unknown, session: string | undefined): void {
    if (this.#closed) return;
    for (const listener of this.#events) listener(method, params, session);
  }

  /** The extension detached its debugger: the lease ended, the person took the tab, or Chrome stopped it. */
  receiveDetached(): void {
    if (!this.#claimed) return;
    this.#claimed = false;
    for (const listener of this.#detached) listener();
  }

  /** The tab is gone. Every wait ends, and every command waiting to leave fails. */
  markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#loading = false;
    this.#settle(this.#loadWaiters, new Error(TAB_CLOSED));
    this.#settle(this.#signalWaiters);
    const pending = this.#pending;
    this.#pending = [];
    for (const entry of pending) entry.reject(new Error("Browser tab was closed."));
    for (const check of [...this.#stateWaiters]) check();
    this.receiveDetached();
  }

  setZoomFactor(factor: number): void {
    if (Number.isFinite(factor) && factor > 0) this.#zoom = factor;
  }

  /** The status counter now, before a navigation starts. */
  statusMark(): number {
    return this.#statusSeq;
  }

  /**
   * Waits for the load that began after `mark`: a `loading` after it, then a `complete` after that.
   * The two events can come before the answer to `Page.navigate`, so the wait reads what came since
   * the mark rather than only what comes next.
   */
  waitForLoadAfter(mark: number, timeoutMs: number): Effect.Effect<void, BrowserOperationError> {
    return Effect.callback<void, BrowserOperationError>((resume) => {
      if (this.#closed) {
        resume(Effect.fail(browserFailure(new Error(TAB_CLOSED))));
        return;
      }
      const loadDone = () => this.#lastLoadingSeq > mark && this.#lastCompleteSeq > this.#lastLoadingSeq;
      if (loadDone()) {
        resume(Effect.void);
        return;
      }
      const timer = setTimeout(() => {
        this.#loadWaiters.delete(waiter);
        resume(Effect.fail(browserFailure(new Error(NAVIGATION_TIMED_OUT))));
      }, timeoutMs);
      const waiter: Waiter = {
        done: (error) => {
          if (!error && !loadDone()) {
            // A `complete` of an earlier load: keep waiting for this one.
            this.#loadWaiters.add(waiter);
            return;
          }
          clearTimeout(timer);
          resume(error ? Effect.fail(browserFailure(error)) : Effect.void);
        },
      };
      this.#loadWaiters.add(waiter);
      return Effect.sync(() => {
        clearTimeout(timer);
        this.#loadWaiters.delete(waiter);
      });
    });
  }

  /**
   * Waits for the first page of a new tab: an address other than `about:blank`, loaded. The tab is made
   * at `about:blank` and navigated after, so the load of the blank page does not count.
   */
  waitForFirstPage(timeoutMs: number): Effect.Effect<void, BrowserOperationError> {
    return Effect.callback<void, BrowserOperationError>((resume) => {
      const shown = () => !this.#loading && this.#url !== "about:blank" && this.#lastCompleteSeq > 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        if (this.#closed) {
          this.#stateWaiters.delete(check);
          clearTimeout(timer);
          resume(Effect.fail(browserFailure(new Error(TAB_CLOSED))));
        } else if (shown()) {
          this.#stateWaiters.delete(check);
          clearTimeout(timer);
          resume(Effect.void);
        }
      };
      timer = setTimeout(() => {
        this.#stateWaiters.delete(check);
        resume(Effect.fail(browserFailure(new Error(NAVIGATION_TIMED_OUT))));
      }, timeoutMs);
      this.#stateWaiters.add(check);
      check();
      return Effect.sync(() => {
        clearTimeout(timer);
        this.#stateWaiters.delete(check);
      });
    });
  }

  #settle(waiters: Set<Waiter>, error?: Error): void {
    const current = [...waiters];
    waiters.clear();
    for (const waiter of current) waiter.done(error);
  }

  // -------------------------------------------------------------------------------------------------
  // CdpTarget

  isClosed(): boolean {
    return this.#closed;
  }

  url(): string {
    return this.#url;
  }

  title(): string {
    return this.#title;
  }

  isLoading(): boolean {
    return this.#loading;
  }

  zoomFactor(): number {
    return this.#zoom;
  }

  onNavigationStarted(listener: (mainFrame: boolean) => void): void {
    this.#navigationStarted.add(listener);
  }

  onMainFrameNavigated(listener: () => void): void {
    this.#mainFrameNavigated.add(listener);
  }

  waitForLoading(timeoutMs: number): Effect.Effect<void, BrowserOperationError> {
    return Effect.callback<void, BrowserOperationError>((resume) => {
      if (!this.#loading) {
        resume(Effect.void);
        return;
      }
      const timer = setTimeout(() => {
        this.#loadWaiters.delete(waiter);
        resume(Effect.fail(browserFailure(new Error(NAVIGATION_TIMED_OUT))));
      }, timeoutMs);
      const waiter: Waiter = {
        done: (error) => {
          clearTimeout(timer);
          resume(error ? Effect.fail(browserFailure(error)) : Effect.void);
        },
      };
      this.#loadWaiters.add(waiter);
      return Effect.sync(() => {
        clearTimeout(timer);
        this.#loadWaiters.delete(waiter);
      });
    });
  }

  waitForPageSignal(timeoutMs: number): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
      const timer = setTimeout(() => {
        this.#signalWaiters.delete(waiter);
        resume(Effect.void);
      }, timeoutMs);
      const waiter: Waiter = {
        done: () => {
          clearTimeout(timer);
          resume(Effect.void);
        },
      };
      this.#signalWaiters.add(waiter);
      return Effect.sync(() => {
        clearTimeout(timer);
        this.#signalWaiters.delete(waiter);
      });
    });
  }

  stopLoading(): Effect.Effect<void, BrowserOperationError> {
    if (!this.#loading || this.#closed) return Effect.void;
    return Effect.tryPromise({
      try: () => this.#channel.stopLoading(),
      catch: (cause) => browserFailure(cause),
    }).pipe(
      Effect.andThen(() => this.waitForLoading(STOP_WAIT_MS)),
      // Chrome can stop without a `complete`: the page is as it is now.
      Effect.catch(() =>
        Effect.sync(() => {
          this.#loading = false;
        }),
      ),
    );
  }

  /** Never called for a Chrome tab: `BrowserCdpEngine.captureImageData` makes the image over CDP. */
  capturePage(): Promise<NativeImage> {
    return Promise.reject(new Error("A Chrome tab has no host capture. Use a CDP screenshot."));
  }

  isAttached(): boolean {
    return this.#claimed && !this.#closed;
  }

  attach(): Effect.Effect<void, BrowserOperationError> {
    return Effect.suspend(() => {
      if (this.#closed) return Effect.fail(browserFailure(new Error("Browser tab was closed.")));
      this.#claimed = true;
      return Effect.void;
    });
  }

  /** The engine lets go; the extension keeps the debugger until the lease ends. */
  release(): void {
    this.#claimed = false;
  }

  sendCommand(method: string, params: DynamicRecord, sessionId?: string): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Browser tab was closed."));
    const command: ChromeCdpCommand =
      sessionId === undefined ? { method, params } : { method, params, session: sessionId };
    if (!this.#channel.batch) return this.#channel.send(command);
    return new Promise((resolve, reject) => {
      this.#pending.push({ command, resolve, reject });
      if (this.#flushScheduled) return;
      this.#flushScheduled = true;
      // The engine's concurrent commands all start in this turn of the event loop.
      setImmediate(() => this.#flush());
    });
  }

  #flush(): void {
    this.#flushScheduled = false;
    const batch = this.#channel.batch;
    while (this.#pending.length > 0) {
      const group = this.#pending.splice(0, BRIDGE_LIMITS.maxBatchCommands);
      const first = group[0];
      if (group.length === 1 || !batch) {
        for (const entry of group) this.#channel.send(entry.command).then(entry.resolve, entry.reject);
        continue;
      }
      if (!first) continue;
      batch(group.map((entry) => entry.command)).then(
        (outcomes) => {
          for (const [index, entry] of group.entries()) {
            const outcome = outcomes[index];
            if (!outcome) entry.reject(new Error(`CDP ${entry.command.method} got no answer in the batch.`));
            else if ("error" in outcome) entry.reject(outcome.error);
            else entry.resolve(outcome.result);
          }
        },
        (error: unknown) => {
          for (const entry of group) entry.reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    }
  }

  onEvent(listener: CdpEventListener): () => void {
    this.#events.add(listener);
    return () => {
      this.#events.delete(listener);
    };
  }

  onDetached(listener: () => void): () => void {
    this.#detached.add(listener);
    return () => {
      this.#detached.delete(listener);
    };
  }
}
