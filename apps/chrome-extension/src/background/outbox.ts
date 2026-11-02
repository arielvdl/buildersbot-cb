/**
 * The way out to the app for events. The channel sets the sender while a session is open; with no
 * session an event is dropped, because the `ready` of the next session carries the state again.
 */

import type { ChromeBridgeEvent, EventBodies } from "@openbot/contracts/chrome-bridge/protocol";

type Sender = <E extends ChromeBridgeEvent>(op: E, body: EventBodies[E]) => void;

let sender: Sender | null = null;

export function setEventSender(next: Sender | null): void {
  sender = next;
}

export function emit<E extends ChromeBridgeEvent>(op: E, body: EventBodies[E]): void {
  sender?.(op, body);
}

/** Counters of the `audit` event: no content, only how many. */
export const audit = { commands: 0, denied: 0, blocked: 0, navigations: 0, stops: 0 };
