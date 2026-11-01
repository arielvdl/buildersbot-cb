import {
  STOPPED_WORK_UNDO_MS,
  type StoppedWorkBulkInput,
  type StoppedWorkBulkResult,
  type StoppedWorkEntry,
  type StoppedWorkList,
} from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { currentText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, createStore, untrack } from "solid-js";
import type { AppPort } from "../../app-port";
import {
  EMPTY_STOPPED_WORK_FILTER,
  filterStoppedWork,
  keyRange,
  type StoppedWorkFilter,
  stoppedWorkKey,
} from "./stopped-work-filter";

export type StoppedWorkPort = Pick<AppPort, "listStoppedWork" | "bulkStoppedWork">;

/** What the last action did, for the line under the actions. */
export interface StoppedWorkReport {
  action: StoppedWorkBulkInput["action"];
  done: number;
  failed: StoppedWorkBulkResult["failed"];
  /** The agent that Reassign gave the work to. */
  agentName: string | null;
  /** The agents whose model changed. */
  agents: string[];
  /** Set after a removal, until the time to undo it ends. */
  undoId: string | null;
}

interface SettingsLoadState {
  /** Null before the first answer. */
  list: StoppedWorkList | null;
  loadFailed: boolean;
  /** The action that runs now, and on how many rows. */
  busy: { action: StoppedWorkBulkInput["action"]; count: number } | null;
  report: StoppedWorkReport | null;
}

/**
 * The stopped work page of Settings: the list from main, the filters, the selection and the last
 * action. It reads the list when the page opens and again when the count of the ring changes, so work
 * that stops or ends elsewhere shows. Each action answers with the new list, and the ring reads the
 * load again at once.
 */
export function createSettingsLoadStore(options: {
  port: () => StoppedWorkPort;
  visible: () => boolean;
  /** The count of stopped runs that the load of the ring gives, or null before it reads. */
  stoppedTotal: () => number | null;
  /** An action changed the work: the ring reads the load again. */
  onChanged: () => void;
}) {
  const [state, setState] = createStore<SettingsLoadState>({
    list: null,
    loadFailed: false,
    busy: null,
    report: null,
  });
  const [filter, setFilter] = createStore<StoppedWorkFilter>({ ...EMPTY_STOPPED_WORK_FILTER });
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  /** The last row that the person marked, where a range with Shift starts. */
  let anchor: string | null = null;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  let reading = 0;

  const shown = createMemo(() => (state.list ? filterStoppedWork(state.list.items, filter) : []));
  const shownKeys = createMemo(() => shown().map(stoppedWorkKey));
  const selectedRows = createMemo((): StoppedWorkEntry[] => {
    const keys = selected();
    return state.list ? state.list.items.filter((item) => keys.has(stoppedWorkKey(item))) : [];
  });

  /** Shows a new list, and keeps only the marks of rows that it still has. */
  function showList(list: StoppedWorkList): void {
    setState((draft) => {
      draft.list = list;
      draft.loadFailed = false;
    });
    const keys = new Set(list.items.map(stoppedWorkKey));
    setSelected((current) => new Set([...current].filter((key) => keys.has(key))));
    if (anchor !== null && !keys.has(anchor)) anchor = null;
  }

  async function refresh(): Promise<void> {
    const id = ++reading;
    try {
      const list = await options.port().listStoppedWork();
      if (id === reading) showList(list);
    } catch {
      if (id === reading)
        setState((draft) => {
          draft.loadFailed = true;
        });
    }
  }

  createEffect(options.visible, (visible) => {
    if (visible) void refresh();
  });
  // Work that stops or ends while the page shows changes the count of the ring, which reads often here.
  createEffect(
    () => (options.visible() ? options.stoppedTotal() : null),
    (total, previous) => {
      if (total === null || previous === undefined || previous === null || total === previous) return;
      if (untrack(() => state.busy) === null) void refresh();
    },
  );

  function clearUndo(): void {
    if (undoTimer !== undefined) clearTimeout(undoTimer);
    undoTimer = undefined;
  }

  async function run(input: StoppedWorkBulkInput, count: number, agentName: string | null = null): Promise<void> {
    if (state.busy) return;
    setState((draft) => {
      draft.busy = { action: input.action, count };
    });
    try {
      const result = await options.port().bulkStoppedWork(input);
      reading += 1;
      showList(result.list);
      clearUndo();
      setState((draft) => {
        draft.report = {
          action: input.action,
          done: result.done,
          failed: result.failed,
          agentName,
          agents: result.agents,
          undoId: result.undoId,
        };
      });
      if (result.undoId) {
        const undoId = result.undoId;
        undoTimer = setTimeout(() => {
          setState((draft) => {
            if (draft.report?.undoId === undoId) draft.report.undoId = null;
          });
        }, STOPPED_WORK_UNDO_MS);
      }
      // The rows that were done leave the list; the ones that failed stay marked to try again.
      options.onChanged();
    } catch (error) {
      const { t, errorMessage } = currentText();
      toast.error(errorMessage(error, t("settings.load.actionFailed")), {
        report: { operation: "settings", source: "system", cause_code: "unknown" },
      });
    } finally {
      setState((draft) => {
        draft.busy = null;
      });
    }
  }

  const items = () => selectedRows().map(({ channelId, taskId }) => ({ channelId, taskId }));

  return {
    state,
    filter,
    setFilter,
    shown,
    selected,
    selectedRows,
    refresh,
    /** Marks or clears one row. With `range`, every row shown from the last marked one takes the same mark. */
    mark(key: string, checked: boolean, range: boolean): void {
      const keys = range ? keyRange(shownKeys(), anchor, key) : [key];
      setSelected((current) => {
        const next = new Set(current);
        for (const each of keys) {
          if (checked) next.add(each);
          else next.delete(each);
        }
        return next;
      });
      anchor = key;
    },
    /** Marks every row that the filters show, or clears them when all of them are marked. */
    markShown(checked: boolean): void {
      const keys = shownKeys();
      setSelected((current) => {
        const next = new Set(current);
        for (const key of keys) {
          if (checked) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    },
    allShownMarked: () => {
      const keys = shownKeys();
      const marks = selected();
      return keys.length > 0 && keys.every((key) => marks.has(key));
    },
    clearSelection(): void {
      setSelected(new Set<string>());
      anchor = null;
    },
    resume: () => run({ action: "resume", items: items() }, selectedRows().length),
    remove: () => run({ action: "remove", items: items() }, selectedRows().length),
    reassign: (agentId: string, agentName: string) =>
      run({ action: "reassign", items: items(), recipientAgentId: agentId }, selectedRows().length, agentName),
    changeModel: (provider: Extract<StoppedWorkBulkInput, { action: "model" }>["provider"], model: string) =>
      run({ action: "model", items: items(), provider, model }, selectedRows().length),
    undo(): void {
      const undoId = state.report?.undoId;
      if (!undoId) return;
      clearUndo();
      void run({ action: "undo", undoId }, state.report?.done ?? 0);
    },
    dismissReport(): void {
      clearUndo();
      setState((draft) => {
        draft.report = null;
      });
    },
    dispose: clearUndo,
  };
}

export type SettingsLoadStore = ReturnType<typeof createSettingsLoadStore>;
