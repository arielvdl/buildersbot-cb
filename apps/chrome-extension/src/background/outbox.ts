/**
 * The way out to the app for events. The channel sets the sender while a session is open; with no
 * session an event is dropped, because the `ready` of the next session carries the state again.
 */

import type { ChromeBridgeEvent, EventBodies } from "@openbot/contracts/chrome-bridge/protocol";

/** Sends one event; the promise settles when its frames are on the port. */
type Sender = <E extends ChromeBridgeEvent>(op: E, body: EventBodies[E]) => Promise<void>;

let sender: Sender | null = null;
let last: Promise<void> = Promise.resolve();

export function setEventSender(next: Sender | null): void {
  sender = next;
}

export function emit<E extends ChromeBridgeEvent>(op: E, body: EventBodies[E]): void {
  const sent = sender?.(op, body);
  if (sent) last = sent.catch(() => undefined);
}

/** Resolves when the events emitted so far are on the port (before a reload of the extension). */
export function flushEvents(): Promise<void> {
  return last;
}

/** Counters of the `audit` event: no content, only how many. */
export const audit = { commands: 0, denied: 0, blocked: 0, navigations: 0, stops: 0 };
