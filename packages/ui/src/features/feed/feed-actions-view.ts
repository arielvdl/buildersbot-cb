/**
 * The DOM-free part of the actions on the cards: what a card does now (an action that runs, a
 * confirmation that waits, the notice of an action that main refused), how a card shows while its
 * action runs, and the labels. The page keeps one control record for each card that has one.
 */

import type { FeedAction, FeedActionFailure, FeedCandidate, FeedItem } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";

/** The actions that wait for a second, explicit step on the card. */
export type FeedConfirmable = "approve" | "deny" | "stop";

/** An action that changes something: every action but `open`. */
export type FeedChange = Exclude<FeedAction, "open">;

export interface FeedPendingAction {
  action: FeedChange;
  /** The revision of the card when the action started. A newer revision is main's answer. */
  revision: number;
  /** Main answered that the action is done; the card waits for the change of its run. */
  done: boolean;
  /** For a reassign: the name of the agent that takes the task. */
  name?: string;
}

/** What the person does on one card now. Kept by the page, so a card that scrolls away keeps it. */
export interface FeedCardControl {
  pending?: FeedPendingAction | undefined;
  confirming?: FeedConfirmable | undefined;
  notice?: FeedActionFailure | undefined;
  /** The typed answer of a question. */
  draft?: string | undefined;
  /** The agent chosen to take a stopped task. */
  recipient?: string | undefined;
}

/** What the person asks of a card, from a button, a field or a key. */
export type FeedCardIntent =
  | { type: "approve"; via: "pointer" | "key" }
  | { type: "deny"; via: "pointer" | "key" }
  | { type: "stop" }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "choice"; index: number }
  | { type: "draft"; text: string }
  | { type: "text" }
  | { type: "resume" }
  | { type: "recipient"; agentId: string }
  | { type: "reassign" }
  | { type: "select"; selected: boolean };

export const FEED_FAILURE_LABEL = {
  gone: "app.feed.failure.gone",
  stale: "app.feed.failure.stale",
  duplicate: "app.feed.failure.duplicate",
  remote: "app.feed.failure.remote",
  "not-allowed": "app.feed.failure.notAllowed",
  unconfirmed: "app.feed.failure.unconfirmed",
  "not-member": "app.feed.failure.notMember",
  failed: "app.feed.failure.failed",
} as const satisfies Record<FeedActionFailure, AppTextKey>;

/** "Approving…" and the others. A reassign names its agent: `app.feed.pending.reassign`. */
export const FEED_PENDING_LABEL = {
  approve: "app.feed.pending.approve",
  deny: "app.feed.pending.deny",
  answer: "app.feed.pending.answer",
  stop: "app.feed.pending.stop",
  resume: "app.feed.pending.resume",
} as const satisfies Record<Exclude<FeedChange, "reassign">, AppTextKey>;

/** The actions that answer what the card waits for: while one runs, the card waits for nothing. */
const ANSWERS: ReadonlySet<FeedAction> = new Set(["approve", "deny", "answer"]);

/**
 * The card as it shows while its action runs: an approval or a question that is being answered is
 * gone at once, and the run shows as working. Main's next change of the card replaces this; a refusal
 * takes the card back as it was.
 */
export function feedShownItem(item: FeedItem, pending: FeedPendingAction | undefined): FeedItem {
  if (!pending || !ANSWERS.has(pending.action) || !item.need) return item;
  return { ...item, need: null, state: "working" };
}

/** Whether a card offers an action now: main offers it, and no other action of the card runs. */
export function feedCan(item: FeedItem, control: FeedCardControl | undefined, action: FeedAction): boolean {
  return item.actions.includes(action) && !control?.pending;
}

/** The agents that can take at least one of these cards, each once, in the order they come. */
export function feedBulkCandidates(items: readonly FeedItem[]): FeedCandidate[] {
  const seen = new Map<string, FeedCandidate>();
  for (const item of items) for (const candidate of item.reassignTo ?? []) seen.set(candidate.agentId, candidate);
  return [...seen.values()];
}

/** The keys that a focused card answers, for `aria-keyshortcuts`. */
export function feedCardShortcuts(item: FeedItem): string {
  const keys = ["J", "K"];
  if (item.actions.includes("approve")) keys.push("A");
  if (item.actions.includes("deny")) keys.push("N");
  if (item.actions.includes("resume")) keys.push("R");
  return keys.join(" ");
}
