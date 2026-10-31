import type {
  BuildersBotDesktopApi,
  WhatsAppAccountNotice,
  WhatsAppAccountsError,
  WhatsAppAccountsResult,
  WhatsAppAccountsSnapshot,
  WhatsAppLinkState,
} from "@openbot/contracts/ipc";
import type { MarketplaceModel } from "@openbot/ui/features/marketplace/marketplace-model";
import { createStore, onCleanup } from "solid-js";

export type WhatsAppAccountsCalls = BuildersBotDesktopApi["whatsappAccounts"];

/** The panel's model, as the Marketplace model names it. */
type WhatsAppAccountsModel = NonNullable<MarketplaceModel["whatsappAccounts"]>;

/** How often the link dialog asks main where the pairing is. Main itself reads wazap every 3 seconds. */
const LINK_POLL_MS = 2_000;

interface WhatsAppAccountsState {
  snapshot: WhatsAppAccountsSnapshot | null;
  /** A read of the list runs. */
  loading: boolean;
  /** A change runs. Changes run one at a time. */
  changing: boolean;
  error: WhatsAppAccountsError | null;
  notice: WhatsAppAccountNotice | null;
  link: { id: string; state: WhatsAppLinkState } | null;
}

/** A pairing that still waits for the phone. */
function waiting(state: WhatsAppLinkState): boolean {
  return state.phase === "starting" || state.phase === "code" || state.phase === "qr";
}

/**
 * The accounts panel's state over the `whatsappAccounts` IPC group. It reads nothing until the panel
 * asks: each read starts `npx` in main. A pairing that waits ends with the owner of this model.
 */
export function createWhatsAppAccountsModel(calls: () => WhatsAppAccountsCalls | undefined): WhatsAppAccountsModel {
  const [state, setState] = createStore<WhatsAppAccountsState>({
    snapshot: null,
    loading: false,
    changing: false,
    error: null,
    notice: null,
    link: null,
  });
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** Each pairing gets a number, so an answer for an earlier one is dropped. */
  let generation = 0;

  const stopPolling = () => {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
  };

  async function refresh() {
    const api = calls();
    if (!api) return;
    setState((draft) => {
      draft.loading = true;
    });
    let snapshot: WhatsAppAccountsSnapshot;
    try {
      snapshot = await api.list();
    } catch {
      snapshot = { status: "unavailable", error: "failed" };
    }
    setState((draft) => {
      draft.snapshot = snapshot;
      draft.loading = false;
    });
  }

  async function change(run: (api: WhatsAppAccountsCalls) => Promise<WhatsAppAccountsResult>): Promise<boolean> {
    const api = calls();
    if (!api || state.changing) return false;
    setState((draft) => {
      draft.changing = true;
      draft.error = null;
      draft.notice = null;
    });
    let result: WhatsAppAccountsResult;
    try {
      result = await run(api);
    } catch {
      result = { ok: false, error: "failed", snapshot: null };
    }
    setState((draft) => {
      draft.changing = false;
      if (result.snapshot) draft.snapshot = result.snapshot;
      if (result.ok) draft.notice = result.notice;
      else draft.error = result.error;
    });
    return result.ok;
  }

  function poll(id: string, current: number) {
    stopPolling();
    pollTimer = setTimeout(async () => {
      const api = calls();
      if (!api || current !== generation) return;
      let next: WhatsAppLinkState | null;
      try {
        next = await api.linkState(id);
      } catch {
        next = { phase: "failed", error: "failed" };
      }
      if (current !== generation) return;
      setState((draft) => {
        draft.link = next === null ? null : { id, state: next };
      });
      if (next !== null && waiting(next)) poll(id, current);
      else if (next?.phase === "linked") void refresh();
    }, LINK_POLL_MS);
  }

  async function startLink(input: Parameters<WhatsAppAccountsCalls["startLink"]>[0]) {
    const api = calls();
    if (!api) return;
    const current = ++generation;
    stopPolling();
    setState((draft) => {
      draft.link = { id: input.id, state: { phase: "starting" } };
      draft.error = null;
    });
    let first: WhatsAppLinkState;
    try {
      first = await api.startLink(input);
    } catch {
      first = { phase: "failed", error: "failed" };
    }
    if (current !== generation) return;
    setState((draft) => {
      draft.link = { id: input.id, state: first };
    });
    if (waiting(first)) poll(input.id, current);
  }

  async function closeLink() {
    generation += 1;
    stopPolling();
    const link = state.link;
    setState((draft) => {
      draft.link = null;
    });
    if (!link) return;
    if (waiting(link.state))
      await calls()
        ?.cancelLink(link.id)
        .catch(() => undefined);
    await refresh();
  }

  onCleanup(() => {
    generation += 1;
    stopPolling();
    const link = state.link;
    if (link && waiting(link.state))
      void calls()
        ?.cancelLink(link.id)
        .catch(() => undefined);
  });

  return {
    snapshot: () => state.snapshot,
    busy: () => state.loading || state.changing,
    error: () => state.error,
    notice: () => state.notice,
    clearMessages: () =>
      setState((draft) => {
        draft.error = null;
        draft.notice = null;
      }),
    refresh,
    add: (input) => change((api) => api.add(input)),
    act: (input) => change((api) => api.act(input)),
    link: () => state.link,
    startLink,
    closeLink,
  };
}
