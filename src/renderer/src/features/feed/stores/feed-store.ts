import type { FeedDelta, FeedItem } from "@openbot/contracts/ipc";
import { createMemo, createStore, onSettled } from "solid-js";
import type { FeedPort } from "../feed-port";

interface FeedState {
  /** The cards by id. A delta replaces a whole card, so only the readers of that card run again. */
  items: Record<string, FeedItem>;
  /** The ids in timeline order, the newest last, as main keeps them. */
  order: string[];
  loading: boolean;
  error: string | null;
}

/**
 * The cards of the feed page while it is on screen. It tells main that the window watches, reads the
 * whole feed once, and then applies the deltas in cursor order. A gap in the cursor reads the whole
 * feed again. While the window is hidden it stops watching, so main sends nothing; it reads again
 * when the window shows.
 */
export function createFeedStore(port: () => FeedPort, describeError: (cause: unknown) => string) {
  const [state, setState] = createStore<FeedState>({ items: {}, order: [], loading: true, error: null });
  /** The cursor of the last delta applied. Null until a snapshot arrived. */
  let cursor: number | null = null;
  /** Deltas that arrived while a snapshot was being read. */
  let pending: FeedDelta[] = [];
  let reading = false;
  let watching = false;
  let disposed = false;

  async function read(): Promise<void> {
    if (reading || disposed) return;
    reading = true;
    cursor = null;
    try {
      const snapshot = await port().getSnapshot();
      if (disposed) return;
      setState((draft) => {
        draft.items = Object.fromEntries(snapshot.items.map((item) => [item.id, item]));
        draft.order = snapshot.items.map((item) => item.id);
        draft.loading = false;
        draft.error = null;
      });
      cursor = snapshot.cursor;
      const queued = pending.filter((delta) => delta.cursor > snapshot.cursor).sort((a, b) => a.cursor - b.cursor);
      pending = [];
      reading = false;
      for (const delta of queued) apply(delta);
    } catch (cause) {
      if (!disposed)
        setState((draft) => {
          draft.loading = false;
          draft.error = describeError(cause);
        });
    } finally {
      reading = false;
    }
  }

  function apply(delta: FeedDelta): void {
    if (disposed) return;
    if (cursor === null || reading) {
      pending.push(delta);
      return;
    }
    if (delta.cursor <= cursor) return;
    if (delta.cursor !== cursor + 1) {
      void read();
      return;
    }
    cursor = delta.cursor;
    setState((draft) => {
      if (delta.removes.length > 0) {
        const removed = new Set(delta.removes);
        for (const id of delta.removes) delete draft.items[id];
        draft.order = draft.order.filter((id) => !removed.has(id));
      }
      const appended: string[] = [];
      const moved = new Set<string>();
      for (const item of delta.upserts) {
        const previous = draft.items[item.id];
        // A new run, or a run that started again: main put it last.
        if (!previous) appended.push(item.id);
        else if (previous.startedAt !== item.startedAt) {
          moved.add(item.id);
          appended.push(item.id);
        }
        draft.items[item.id] = item;
      }
      if (moved.size > 0) draft.order = draft.order.filter((id) => !moved.has(id));
      if (appended.length > 0) draft.order = [...draft.order, ...appended];
    });
  }

  function watch(next: boolean): void {
    if (watching === next || disposed) return;
    watching = next;
    void port()
      .setWatching({ watching: next })
      .then(() => (next ? read() : undefined))
      .catch((cause: unknown) => {
        if (!disposed)
          setState((draft) => {
            draft.loading = false;
            draft.error = describeError(cause);
          });
      });
  }

  onSettled(() => {
    const unsubscribe = port().onDelta(apply);
    const onVisibility = () => watch(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    watch(document.visibilityState !== "hidden");
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
      watch(false);
      disposed = true;
    };
  });

  /** The cards in timeline order. */
  const items = createMemo(() =>
    state.order.flatMap((id) => {
      const item = state.items[id];
      return item ? [item] : [];
    }),
  );

  return { state, items };
}
