/**
 * The page that `BrowserCdpEngine` drives, seen through the seam the engine needs: a CDP debugger,
 * the state of the main frame, and the few things a page does outside CDP. `ElectronCdpTarget` is the
 * Builders Bot browser tab, with the behavior the engine always had. A target in the person's own
 * Chrome, through the Builders Bot extension, implements the same interface (see
 * `docs/architecture/browser.md`, "The person's Chrome through the Builders Bot extension").
 *
 * Two rules make one engine work on both:
 *
 * - `attach` is an Effect, so a target whose attach goes over a channel can be asynchronous. It is
 *   idempotent: while an attach runs, a second call joins it. `isAttached` reads a cached flag and does
 *   no I/O, because the engine reads it before each lease.
 * - `release` is what the engine calls when no lease, watch or dialog needs the debugger. The target's
 *   `retention` decides what that means. An Electron tab detaches at once, as before. A Chrome tab keeps
 *   the real debugger until its lease ends, so Chrome's "is debugging this browser" bar does not flash
 *   on each tool call; for the engine the release is the same, because it forgets its sessions and
 *   enables `Page` again on the next lease.
 */

import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import type { NativeImage, Rectangle, WebContents } from "electron";
import { type BrowserOperationError, browserSync } from "./browser-effects";
import { stopLoadingAndWait, waitForLoading } from "./browser-navigation";

/** A CDP event: its method, its parameters, and the child session it came from (none for the page). */
export type CdpEventListener = (method: string, params: unknown, sessionId: string | undefined) => void;

/**
 * How long the debugger stays attached. `"operation"`: it detaches as soon as the engine releases it
 * (the Electron tab). `"lease"`: it stays until the agent's lease on the tab ends (a Chrome tab).
 */
export type CdpRetention = "operation" | "lease";

export interface CdpTarget {
  readonly retention: CdpRetention;

  /** The page is gone or closing. The engine starts no lease then. */
  isClosed(): boolean;

  url(): string;
  title(): string;
  isLoading(): boolean;
  /** The scale of the page zoom, for clips in view pixels. */
  zoomFactor(): number;

  /** A navigation started: `mainFrame` is false for a frame. Same-document navigations count too. */
  onNavigationStarted(listener: (mainFrame: boolean) => void): void;
  /** The main frame committed a new document. */
  onMainFrameNavigated(listener: () => void): void;
  /** Waits for a load that already started, such as one from `Page.navigate`. */
  waitForLoading(timeoutMs: number): Effect.Effect<void, BrowserOperationError>;
  /** Waits until the page stops loading or navigates in place, or `timeoutMs`. Never fails. */
  waitForPageSignal(timeoutMs: number): Effect.Effect<void>;
  /** Stops a load in progress and waits for the stop. */
  stopLoading(): Effect.Effect<void, BrowserOperationError>;
  /** An image of the visible page, or of `clip` in view pixels. */
  capturePage(clip?: Rectangle): Promise<NativeImage>;

  /** Cached; no I/O. True while the target holds an attach for the engine. */
  isAttached(): boolean;
  attach(): Effect.Effect<void, BrowserOperationError>;
  /** The engine needs the debugger no more. What it does depends on `retention`. */
  release(): void;
  sendCommand(method: string, params: DynamicRecord, sessionId?: string): Promise<unknown>;
  /** Adds a CDP event listener and gives back its removal. Listeners run in the order they were added. */
  onEvent(listener: CdpEventListener): () => void;
  /** Adds a listener for the end of the debugger session and gives back its removal. */
  onDetached(listener: () => void): () => void;

  /**
   * The host's own box for a JavaScript dialog, when it shows one apart from the page. Electron does:
   * an answer over CDP does not close it, so the engine closes it. Chrome closes its own dialog when CDP
   * answers it, so a Chrome target has no box to manage.
   */
  readonly dialogBox: DialogBox | null;
}

export interface DialogBox {
  /** Runs when the host shows its box, in the same task as the CDP event and after it. */
  onShown(listener: () => void): void;
  /** Closes the box without answering the page again. */
  close(): void;
  /** Whether a close can reach the box now. Without it, a person answers the dialog. */
  canClose(): boolean;
}

/**
 * Electron's internal events for its dialog box. They are not in the `WebContents` event types. The
 * engine listens for the box to show and closes it after a CDP answer.
 */
const CANCEL_DIALOGS_EVENT = "-cancel-dialogs";
const RUN_DIALOG_EVENT = "-run-dialog";

/** A Builders Bot browser tab. Each call keeps the behavior that the engine had on `WebContents`. */
export class ElectronCdpTarget implements CdpTarget {
  readonly retention: CdpRetention = "operation";
  readonly dialogBox: DialogBox;
  readonly #contents: WebContents;
  /**
   * Native teardown can start before `isDestroyed()` becomes true. Detaching a debugger during that
   * interval can crash Electron; Chromium disposes of it with the page.
   */
  #closing = false;

  constructor(contents: WebContents) {
    this.#contents = contents;
    contents.once("close", () => {
      this.#closing = true;
    });
    // Electron's internal events are not in its WebContents event types.
    const internalEvents: NodeJS.EventEmitter = contents;
    this.dialogBox = {
      onShown: (listener) => {
        internalEvents.on(RUN_DIALOG_EVENT, listener);
      },
      close: () => {
        contents.emit(CANCEL_DIALOGS_EVENT);
      },
      canClose: () => contents.listenerCount(CANCEL_DIALOGS_EVENT) > 0,
    };
  }

  isClosed(): boolean {
    return this.#closing || this.#contents.isDestroyed();
  }

  url(): string {
    return this.#contents.getURL();
  }

  title(): string {
    return this.#contents.getTitle();
  }

  isLoading(): boolean {
    return this.#contents.isLoading();
  }

  zoomFactor(): number {
    return this.#contents.getZoomFactor();
  }

  onNavigationStarted(listener: (mainFrame: boolean) => void): void {
    this.#contents.on("did-start-navigation", (details) => listener(details.isMainFrame));
  }

  onMainFrameNavigated(listener: () => void): void {
    this.#contents.on("did-navigate", listener);
  }

  waitForLoading(timeoutMs: number): Effect.Effect<void, BrowserOperationError> {
    return waitForLoading(this.#contents, timeoutMs);
  }

  waitForPageSignal(timeoutMs: number): Effect.Effect<void> {
    const contents = this.#contents;
    return Effect.callback<void>((resume) => {
      let timer: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timer);
        contents.off("did-stop-loading", signal);
        contents.off("did-navigate-in-page", signal);
      };
      const signal = () => {
        cleanup();
        resume(Effect.void);
      };
      timer = setTimeout(signal, timeoutMs);
      contents.once("did-stop-loading", signal);
      contents.once("did-navigate-in-page", signal);
      return Effect.sync(cleanup);
    });
  }

  stopLoading(): Effect.Effect<void, BrowserOperationError> {
    return stopLoadingAndWait(this.#contents);
  }

  capturePage(clip?: Rectangle): Promise<NativeImage> {
    return this.#contents.capturePage(clip);
  }

  isAttached(): boolean {
    return this.#contents.debugger.isAttached();
  }

  attach(): Effect.Effect<void, BrowserOperationError> {
    // Electron attaches synchronously, so two leases cannot both start an attach.
    return browserSync(() => {
      if (!this.#contents.debugger.isAttached()) this.#contents.debugger.attach("1.3");
    });
  }

  release(): void {
    if (this.isClosed() || !this.#contents.debugger.isAttached()) return;
    this.#contents.debugger.detach();
  }

  sendCommand(method: string, params: DynamicRecord, sessionId?: string): Promise<unknown> {
    return this.#contents.debugger.sendCommand(method, params, sessionId);
  }

  onEvent(listener: CdpEventListener): () => void {
    const debuggerClient = this.#contents.debugger;
    const wrapped = (_event: Electron.Event, method: string, params: unknown, sessionId?: string) =>
      listener(method, params, sessionId);
    debuggerClient.on("message", wrapped);
    return () => {
      debuggerClient.removeListener("message", wrapped);
    };
  }

  onDetached(listener: () => void): () => void {
    const debuggerClient = this.#contents.debugger;
    debuggerClient.on("detach", listener);
    return () => {
      debuggerClient.removeListener("detach", listener);
    };
  }
}
