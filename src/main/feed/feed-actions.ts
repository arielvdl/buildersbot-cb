/**
 * The actions of the person on the cards of the feed: approve, deny, answer, stop, resume, reassign.
 * No Electron here: `ipc/feed-handlers.ts` checks the window, and an E2E script runs this class as it is.
 *
 * A window sends ids only. For each card this class reads the card as main holds it now, not as the
 * window shows it, and checks again before it acts:
 * - the card is of this computer (a joined server's card goes through its conversation);
 * - the request that the window names is the one that the card waits for now, and the attention
 *   registry still has it open for the same agent and thread (a provider can use a request id again);
 * - a `high` risk approval came with the person's confirmation;
 * - the same action on the same request is not running and was not done (a second click, a second
 *   window or a replayed message does nothing).
 * Then it calls the operation that the conversation or the load panel calls for the same action:
 * `respondToApproval`, `respondToPrompt`, `WorkControl.stopWork` and `WorkControl.bulkStopped`.
 * There is no other path to a decision.
 */

import {
  type AgentApproval,
  type AgentPromptQuestion,
  FEED_ACTION_VERSION,
  type FeedActionFailure,
  type FeedActionInput,
  type FeedActionResult,
  type FeedItem,
  LOCAL_SERVER_ID,
  type RespondToApprovalInput,
  type RespondToPromptInput,
  type StoppedWorkBulkInput,
  type StoppedWorkBulkResult,
  type StoppedWorkFailure,
  type StopWorkInput,
} from "@openbot/contracts/ipc";
import { feedApprovalHighRisk } from "./feed-aggregator";

/** A request that waits for the person now, as the attention registry holds it. */
export type FeedPendingRequest =
  | {
      kind: "approval";
      requestId: string | number;
      agentId: string;
      threadId: string;
      approval: Pick<AgentApproval, "kind" | "guard">;
    }
  | {
      kind: "prompt";
      requestId: string | number;
      agentId: string;
      threadId: string;
      questions: AgentPromptQuestion[];
    };

export interface FeedActionsOptions {
  feed: {
    card(id: string): Readonly<FeedItem> | undefined;
    runningTurn(id: string): string | null;
    simpleQuestion(questions: readonly AgentPromptQuestion[]): AgentPromptQuestion | null;
    refreshLoad(): void;
  };
  /** `AgentService.pendingRequest`. */
  pendingRequest: (kind: "approval" | "prompt", requestId: string | number) => FeedPendingRequest | null;
  /** The answer of the conversation: `AgentService.respondToApproval`. */
  respondToApproval: (input: RespondToApprovalInput) => Promise<void>;
  /** The answer of the conversation: `AgentService.respondToPrompt`. */
  respondToPrompt: (input: RespondToPromptInput) => Promise<void>;
  /** The Stop of the load panel: `WorkControl.stopWork`. */
  stopWork: (input: StopWorkInput) => Promise<boolean>;
  /** The actions of the stopped work page: `WorkControl.bulkStopped`. */
  bulkStopped: (input: StoppedWorkBulkInput) => Promise<StoppedWorkBulkResult>;
  /** Reports a failed operation. It gets the action name only, never a text of the person. */
  onFailure: (action: string, cause: unknown) => void;
  localServerId?: string | undefined;
}

/** The done actions that a repeat is checked against. Older ones fall to the checks of the card. */
const SETTLED_LIMIT = 1_000;

function key(...parts: Array<string | number>): string {
  return parts.join("\u0000");
}

function sameRequest(a: string | number, b: string | number): boolean {
  return typeof a === typeof b && a === b;
}

export class FeedActions {
  readonly #options: FeedActionsOptions;
  readonly #local: string;
  /** The actions that run now, by request or card. */
  readonly #running = new Set<string>();
  /** The actions that were done, by request or run, the oldest first. */
  readonly #settled = new Set<string>();

  constructor(options: FeedActionsOptions) {
    this.#options = options;
    this.#local = options.localServerId ?? LOCAL_SERVER_ID;
  }

  async act(input: FeedActionInput): Promise<FeedActionResult> {
    switch (input.action) {
      case "approve":
      case "deny":
        return this.#single(input.itemId, () =>
          this.#approval(
            input.itemId,
            input.requestId,
            input.action,
            input.action === "approve" && input.confirmed === true,
          ),
        );
      case "answer":
        return this.#single(input.itemId, () =>
          this.#answer(
            input.itemId,
            input.requestId,
            "choice" in input ? { choice: input.choice } : { text: input.text },
          ),
        );
      case "stop":
        return this.#single(input.itemId, () => this.#stop(input.itemId, input.startedAt));
      case "resume":
        return this.#tasks(input.itemIds, null);
      case "reassign":
        return this.#tasks(input.itemIds, input.recipientAgentId);
    }
  }

  async #single(itemId: string, run: () => Promise<FeedActionFailure | null>): Promise<FeedActionResult> {
    const failure = await run();
    return failure
      ? { v: FEED_ACTION_VERSION, done: 0, failed: [{ itemId, reason: failure }] }
      : { v: FEED_ACTION_VERSION, done: 1, failed: [] };
  }

  /** The card of this computer, or why there is none. */
  #card(itemId: string): Readonly<FeedItem> | FeedActionFailure {
    const card = this.#options.feed.card(itemId);
    if (!card) return "gone";
    return card.serverId === this.#local ? card : "remote";
  }

  async #approval(
    itemId: string,
    requestId: string | number,
    action: "approve" | "deny",
    confirmed: boolean,
  ): Promise<FeedActionFailure | null> {
    const card = this.#card(itemId);
    if (typeof card === "string") return card;
    const need = card.need;
    if (need?.kind !== "approval" || !sameRequest(need.requestId, requestId)) return "stale";
    const live = this.#options.pendingRequest("approval", need.requestId);
    if (live?.kind !== "approval" || live.agentId !== card.agentId || live.threadId !== card.threadId) return "stale";
    // The rule of the card, read from the request as the registry holds it, not from the window.
    if (action === "approve" && feedApprovalHighRisk(live.approval) && !confirmed) return "unconfirmed";
    return this.#once(key("approval", card.serverId, card.agentId, String(live.requestId), need.since), action, () =>
      this.#options.respondToApproval({
        requestId: live.requestId,
        decision: action === "approve" ? "accept" : "decline",
      }),
    );
  }

  async #answer(
    itemId: string,
    requestId: string | number,
    answer: { choice: number } | { text: string },
  ): Promise<FeedActionFailure | null> {
    const card = this.#card(itemId);
    if (typeof card === "string") return card;
    const need = card.need;
    if (need?.kind !== "prompt" || !sameRequest(need.requestId, requestId)) return "stale";
    if (!need.form) return "not-allowed";
    const live = this.#options.pendingRequest("prompt", need.requestId);
    if (live?.kind !== "prompt" || live.agentId !== card.agentId || live.threadId !== card.threadId) return "stale";
    const question = this.#options.feed.simpleQuestion(live.questions);
    if (!question) return "not-allowed";
    const options = question.options ?? [];
    // The card shows the choices of this question: another count is another question.
    if (options.length !== need.form.choices.length) return "stale";
    let value: string;
    if ("choice" in answer) {
      const option = options[answer.choice];
      if (!option) return "not-allowed";
      value = option.label;
    } else {
      value = answer.text.trim();
      if (!need.form.text || !value) return "not-allowed";
    }
    return this.#once(key("prompt", card.serverId, card.agentId, String(live.requestId), need.since), "answer", () =>
      this.#options.respondToPrompt({ requestId: live.requestId, answers: { [question.id]: [value] } }),
    );
  }

  async #stop(itemId: string, startedAt: string): Promise<FeedActionFailure | null> {
    const card = this.#card(itemId);
    if (typeof card === "string") return card;
    // Another start is another run: the person saw this one.
    if (card.startedAt !== startedAt) return "stale";
    const turnId = this.#options.feed.runningTurn(itemId);
    if (!turnId) return "stale";
    const channel = card.channelId !== null && card.taskId !== null;
    let sent = true;
    const failure = await this.#once(key("stop", itemId, turnId), "stop", async () => {
      sent = await this.#options.stopWork({
        turnId,
        agentId: card.agentId,
        channelId: channel ? card.channelId : null,
        taskId: channel ? card.taskId : null,
      });
    });
    if (failure) return failure;
    this.#options.feed.refreshLoad();
    return sent ? null : "stale";
  }

  /**
   * Resume or reassign stopped channel tasks, one card or many, in one call of the stopped work page.
   * That call checks again that each task is stopped now, and that the agent can take it.
   */
  async #tasks(itemIds: readonly string[], recipientAgentId: string | null): Promise<FeedActionResult> {
    const action = recipientAgentId === null ? "resume" : "reassign";
    const failed: FeedActionResult["failed"] = [];
    const items: { itemId: string; channelId: string; taskId: string; key: string }[] = [];
    for (const itemId of new Set(itemIds)) {
      const card = this.#card(itemId);
      if (typeof card === "string") {
        failed.push({ itemId, reason: card });
        continue;
      }
      if (!card.actions.includes(action) || card.channelId === null || card.taskId === null) {
        failed.push({ itemId, reason: "not-allowed" });
        continue;
      }
      if (recipientAgentId !== null && !card.reassignTo?.some((candidate) => candidate.agentId === recipientAgentId)) {
        failed.push({ itemId, reason: "not-member" });
        continue;
      }
      const taskKey = key("task", itemId);
      if (this.#running.has(taskKey)) {
        failed.push({ itemId, reason: "duplicate" });
        continue;
      }
      items.push({ itemId, channelId: card.channelId, taskId: card.taskId, key: taskKey });
    }
    if (items.length === 0) return { v: FEED_ACTION_VERSION, done: 0, failed };
    for (const item of items) this.#running.add(item.key);
    let done = 0;
    try {
      const rows = items.map(({ channelId, taskId }) => ({ channelId, taskId }));
      const result = await this.#options.bulkStopped(
        recipientAgentId === null
          ? { action: "resume", items: rows }
          : { action: "reassign", items: rows, recipientAgentId },
      );
      done = result.done;
      for (const entry of result.failed) {
        const item = items.find(
          (candidate) => candidate.channelId === entry.channelId && candidate.taskId === entry.taskId,
        );
        if (item) failed.push({ itemId: item.itemId, reason: taskFailure(entry.reason) });
      }
    } catch (cause) {
      this.#options.onFailure(action, cause);
      for (const item of items) failed.push({ itemId: item.itemId, reason: "failed" });
    } finally {
      for (const item of items) this.#running.delete(item.key);
      this.#options.feed.refreshLoad();
    }
    return { v: FEED_ACTION_VERSION, done, failed };
  }

  /** Runs an operation once for a key: a repeat while it runs, or after it was done, is a duplicate. */
  async #once(actionKey: string, action: string, run: () => Promise<void>): Promise<FeedActionFailure | null> {
    if (this.#running.has(actionKey) || this.#settled.has(actionKey)) return "duplicate";
    this.#running.add(actionKey);
    try {
      await run();
      this.#settled.add(actionKey);
      if (this.#settled.size > SETTLED_LIMIT) {
        const oldest = this.#settled.values().next().value;
        if (oldest !== undefined) this.#settled.delete(oldest);
      }
      return null;
    } catch (cause) {
      this.#options.onFailure(action, cause);
      return "failed";
    } finally {
      this.#running.delete(actionKey);
    }
  }
}

function taskFailure(reason: StoppedWorkFailure): FeedActionFailure {
  switch (reason) {
    case "gone":
    case "expired":
      return "gone";
    case "not-member":
      return "not-member";
    case "running":
      return "not-allowed";
    default:
      return "failed";
  }
}
