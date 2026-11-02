import {
  FEED_ACTION_VERSION,
  FEED_BULK_LIMIT,
  type FeedActionInput,
  type FeedActionResult,
  type FeedItem,
} from "@openbot/contracts/ipc";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, createStore, onCleanup } from "solid-js";
import {
  FEED_FAILURE_LABEL,
  type FeedCardControl,
  type FeedCardIntent,
  type FeedChange,
  type FeedConfirmable,
  feedBulkCandidates,
  feedCan,
} from "./feed-actions-view";

/** How long a done action waits for main's change of its card before the card shows as main has it. */
const SETTLE_MS = 8_000;

export interface FeedActionsControllerOptions {
  /** Every card, in timeline order. */
  items: () => readonly FeedItem[];
  /** The cards that the filters show. "Select the stopped" selects among them. */
  shown: () => readonly FeedItem[];
  act: () => ((input: FeedActionInput) => Promise<FeedActionResult>) | undefined;
  announce: (text: string) => void;
  focusCard: (id: string) => void;
  title: (item: FeedItem) => string;
}

/** What a confirmation is for: the request of an approval, or the start of a run. */
function confirmKey(item: FeedItem, step: FeedConfirmable): string | null {
  if (step === "stop") return item.startedAt;
  return item.need?.kind === "approval" ? String(item.need.requestId) : null;
}

/**
 * The actions of the feed page. A card changes at once ("Approving…"); main's answer either keeps the
 * change until the delta of the card arrives, or takes the card back as it was, with the reason on the
 * card and in the live region. The record of a card ignores what is out of date by itself: a done
 * action whose card has a newer revision, a confirmation for a request or a run that is not the one
 * on the card now, a selected card that is not stopped any more.
 */
export function createFeedActionsController(options: FeedActionsControllerOptions) {
  const { t } = useText();
  const [controls, setControls] = createStore<Record<string, FeedCardControl & { confirmKey?: string }>>({});
  const [chosen, setChosen] = createSignal<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = createStore({ recipient: "", busy: false });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  onCleanup(() => {
    for (const timer of timers.values()) clearTimeout(timer);
  });

  const byId = createMemo(() => new Map(options.items().map((item) => [item.id, item])));

  /** The control of a card as it applies to the card now. */
  const controlOf = (item: FeedItem): FeedCardControl | undefined => {
    const control = controls[item.id];
    if (!control) return undefined;
    const pending = control.pending;
    const settled = pending?.done && pending.revision !== item.revision;
    const confirming =
      control.confirming && control.confirmKey === confirmKey(item, control.confirming)
        ? control.confirming
        : undefined;
    return {
      pending: settled ? undefined : pending,
      confirming,
      notice: control.notice,
      draft: control.draft,
      recipient: control.recipient,
    };
  };

  /** The selected cards that are still stopped tasks, in timeline order. */
  const selected = createMemo(() => {
    const ids = chosen();
    return options.items().filter((item) => ids.has(item.id) && item.actions.includes("resume"));
  });
  const selectedIds = createMemo(() => new Set(selected().map((item) => item.id)));
  const selectable = createMemo(() => options.shown().filter((item) => item.actions.includes("resume")));
  const candidates = createMemo(() => feedBulkCandidates(selected()));

  const settleLater = (id: string) => {
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        setControls((draft) => {
          const control = draft[id];
          if (control?.pending?.done) control.pending = undefined;
        });
      }, SETTLE_MS),
    );
  };

  async function run(input: FeedActionInput, ids: readonly string[], name?: string): Promise<void> {
    const act = options.act();
    if (!act || ids.length === 0) return;
    const action: FeedChange = input.action;
    const cards = byId();
    setControls((draft) => {
      // A card that left the feed takes its record with it.
      for (const id of Object.keys(draft)) if (!cards.has(id)) delete draft[id];
      for (const id of ids) {
        const item = cards.get(id);
        if (!item) continue;
        const control = draft[id] ?? {};
        control.pending = { action, revision: item.revision, done: false, ...(name ? { name } : {}) };
        control.confirming = undefined;
        control.confirmKey = undefined;
        control.notice = undefined;
        draft[id] = control;
      }
    });
    let result: FeedActionResult;
    try {
      result = await act(input);
    } catch {
      result = {
        v: FEED_ACTION_VERSION,
        done: 0,
        failed: ids.map((itemId) => ({ itemId, reason: "failed" as const })),
      };
    }
    const failed = new Map(result.failed.map((entry) => [entry.itemId, entry.reason]));
    const now = byId();
    setControls((draft) => {
      for (const id of ids) {
        const control = draft[id];
        if (!control?.pending) continue;
        const reason = failed.get(id);
        if (reason) {
          control.pending = undefined;
          control.notice = reason;
          continue;
        }
        const item = now.get(id);
        // The delta of the card can come before the answer of the action.
        if (!item || item.revision !== control.pending.revision) control.pending = undefined;
        else {
          control.pending.done = true;
          settleLater(id);
        }
        if (action === "answer") control.draft = undefined;
        if (action === "reassign") control.recipient = undefined;
      }
    });
    if (ids.length === 1) {
      const id = ids[0] ?? "";
      const item = cards.get(id);
      const title = item ? options.title(item) : "";
      const reason = failed.get(id);
      options.announce(
        reason
          ? t("app.feed.announce.failed", { title, reason: t(FEED_FAILURE_LABEL[reason]) })
          : t("app.feed.announce.done", { title }),
      );
    } else options.announce(t("app.feed.bulk.result", { done: result.done, failed: result.failed.length }));
  }

  const arm = (item: FeedItem, step: FeedConfirmable) => {
    const key = confirmKey(item, step);
    if (key === null) return;
    setControls((draft) => {
      const control = draft[item.id] ?? {};
      control.confirming = step;
      control.confirmKey = key;
      control.notice = undefined;
      draft[item.id] = control;
    });
  };

  const disarm = (id: string) =>
    setControls((draft) => {
      const control = draft[id];
      if (!control) return;
      control.confirming = undefined;
      control.confirmKey = undefined;
    });

  /** Gives the focus back to the card once its buttons changed. */
  const refocus = (id: string) => queueMicrotask(() => options.focusCard(id));

  function intent(item: FeedItem, request: FeedCardIntent): void {
    const control = controlOf(item);
    const need = item.need;
    switch (request.type) {
      case "approve": {
        if (!feedCan(item, control, "approve") || need?.kind !== "approval") return;
        // A high risk approval always waits for the second step, from a click or a key.
        if (need.risk === "high") arm(item, "approve");
        else
          void run({ v: FEED_ACTION_VERSION, action: "approve", itemId: item.id, requestId: need.requestId }, [
            item.id,
          ]);
        return;
      }
      case "deny": {
        if (!feedCan(item, control, "deny") || need?.kind !== "approval") return;
        // A key never denies at once: the card asks first.
        if (request.via === "key") arm(item, "deny");
        else
          void run({ v: FEED_ACTION_VERSION, action: "deny", itemId: item.id, requestId: need.requestId }, [item.id]);
        return;
      }
      case "stop":
        if (feedCan(item, control, "stop")) arm(item, "stop");
        return;
      case "confirm": {
        const step = control?.confirming;
        if (!step) return;
        refocus(item.id);
        if (step === "stop") {
          void run({ v: FEED_ACTION_VERSION, action: "stop", itemId: item.id, startedAt: item.startedAt }, [item.id]);
          return;
        }
        if (need?.kind !== "approval") return;
        void run(
          step === "approve"
            ? { v: FEED_ACTION_VERSION, action: "approve", itemId: item.id, requestId: need.requestId, confirmed: true }
            : { v: FEED_ACTION_VERSION, action: "deny", itemId: item.id, requestId: need.requestId },
          [item.id],
        );
        return;
      }
      case "cancel":
        disarm(item.id);
        refocus(item.id);
        return;
      case "choice":
        if (feedCan(item, control, "answer") && need?.kind === "prompt")
          void run(
            {
              v: FEED_ACTION_VERSION,
              action: "answer",
              itemId: item.id,
              requestId: need.requestId,
              choice: request.index,
            },
            [item.id],
          );
        return;
      case "draft":
        setControls((draft) => {
          const entry = draft[item.id] ?? {};
          entry.draft = request.text;
          draft[item.id] = entry;
        });
        return;
      case "text": {
        const text = control?.draft?.trim();
        if (text && feedCan(item, control, "answer") && need?.kind === "prompt")
          void run({ v: FEED_ACTION_VERSION, action: "answer", itemId: item.id, requestId: need.requestId, text }, [
            item.id,
          ]);
        return;
      }
      case "resume":
        if (feedCan(item, control, "resume"))
          void run({ v: FEED_ACTION_VERSION, action: "resume", itemIds: [item.id] }, [item.id]);
        return;
      case "recipient":
        setControls((draft) => {
          const entry = draft[item.id] ?? {};
          entry.recipient = request.agentId || undefined;
          draft[item.id] = entry;
        });
        return;
      case "reassign": {
        const recipient = item.reassignTo?.find((candidate) => candidate.agentId === control?.recipient);
        if (recipient && feedCan(item, control, "reassign"))
          void run(
            {
              v: FEED_ACTION_VERSION,
              action: "reassign",
              itemIds: [item.id],
              recipientAgentId: recipient.agentId,
            },
            [item.id],
            recipient.name,
          );
        return;
      }
      case "select": {
        const next = new Set(chosen());
        if (request.selected) next.add(item.id);
        else next.delete(item.id);
        setChosen(next);
        return;
      }
    }
  }

  /** A, N and R on a focused card. Answers whether the card took the key. */
  function shortcut(item: FeedItem, key: "a" | "n" | "r"): boolean {
    const control = controlOf(item);
    if (key === "a" && feedCan(item, control, "approve")) intent(item, { type: "approve", via: "key" });
    else if (key === "n" && feedCan(item, control, "deny")) intent(item, { type: "deny", via: "key" });
    else if (key === "r" && feedCan(item, control, "resume")) intent(item, { type: "resume" });
    else return false;
    return true;
  }

  /** Resume or reassign the selection, `FEED_BULK_LIMIT` cards at a time. */
  async function runBulk(recipientAgentId: string | null): Promise<void> {
    const ids = selected().map((item) => item.id);
    if (ids.length === 0 || bulk.busy) return;
    const name = recipientAgentId
      ? candidates().find((candidate) => candidate.agentId === recipientAgentId)?.name
      : undefined;
    setBulk((draft) => {
      draft.busy = true;
    });
    setChosen(new Set<string>());
    try {
      for (let start = 0; start < ids.length; start += FEED_BULK_LIMIT) {
        const chunk = ids.slice(start, start + FEED_BULK_LIMIT);
        await run(
          recipientAgentId
            ? { v: FEED_ACTION_VERSION, action: "reassign", itemIds: chunk, recipientAgentId }
            : { v: FEED_ACTION_VERSION, action: "resume", itemIds: chunk },
          chunk,
          name,
        );
      }
    } finally {
      setBulk((draft) => {
        draft.busy = false;
        draft.recipient = "";
      });
    }
  }

  return {
    controlOf,
    intent,
    shortcut,
    selectedIds,
    bulk: {
      selected: () => selected().length,
      selectable: () => selectable().length,
      candidates,
      recipient: () => bulk.recipient,
      busy: () => bulk.busy,
      selectAll: () => setChosen(new Set(selectable().map((item) => item.id))),
      clear: () => setChosen(new Set<string>()),
      resume: () => void runBulk(null),
      setRecipient: (agentId: string) =>
        setBulk((draft) => {
          draft.recipient = agentId;
        }),
      reassign: () => void runBulk(bulk.recipient || null),
    },
  };
}
