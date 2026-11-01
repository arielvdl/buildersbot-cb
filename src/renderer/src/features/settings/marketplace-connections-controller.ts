import type {
  BuildersBotDesktopApi,
  ClientAgentSummary,
  HubAccessRequestKind,
  HubConnectionAccessRequestResult,
  HubConnectionsView,
} from "@openbot/contracts/ipc";
import {
  connectionApp,
  type MarketplaceConnectionAgent,
  type MarketplaceConnections,
} from "@openbot/ui/features/marketplace/marketplace-connections";
import type { MarketplaceApp } from "@openbot/ui/features/marketplace/marketplace-model";
import { createEffect, createStore } from "solid-js";

/** What the Marketplace calls for Hub connections. The desktop app reaches main; other clients have none. */
export type HubConnectionCalls = Pick<
  BuildersBotDesktopApi["hubConnections"],
  "getView" | "refresh" | "choosePayer" | "requestAccess"
>;

export interface MarketplaceConnectionsOptions {
  open: () => boolean;
  /** Absent where this Marketplace is not for this computer, or the client has no Hub session. */
  calls: () => HubConnectionCalls | undefined;
  /** The agents of this computer, with the connections that each one has off. */
  agents: () => ReadonlyArray<
    Pick<ClientAgentSummary, "id" | "name" | "title" | "avatarSeed" | "avatarHue" | "avatarUrl"> & {
      connectionsOff?: string[] | undefined;
    }
  >;
  /** Saves an agent's list of connections that are off. */
  setConnectionsOff: (agentId: string, connectionsOff: string[]) => Promise<void>;
  /** Reports a failure as the Marketplace error line. */
  onError: (error: unknown) => void;
}

/**
 * The Hub connections of the Marketplace on the real IPC: main reads the Hub while the window is open,
 * and the connection rows join the Apps list, where the curation decides if they show. A failure of
 * the Hub is a status of the view, not an error line: the page says why.
 */
export function createMarketplaceConnections(options: MarketplaceConnectionsOptions) {
  const [state, setState] = createStore<{
    view: HubConnectionsView | null;
    busy: Record<string, true>;
    /** The lists that the person saved, until the agents of the window show them. */
    off: Record<string, string[]>;
  }>({ view: null, busy: {}, off: {} });

  const take = (view: HubConnectionsView) =>
    setState((draft) => {
      draft.view = view;
    });

  const read = (fresh: boolean) => {
    const calls = options.calls();
    if (!calls) return;
    void (fresh ? calls.refresh() : calls.getView()).then(take, options.onError);
  };

  /* Each open of the window reads the view; main keeps the Hub's answers for up to 5 minutes. */
  createEffect(
    () => options.open() && options.calls() !== undefined,
    (open) => {
      if (open) read(false);
    },
  );

  const withBusy = async <T>(connectionId: string, run: () => Promise<T>): Promise<T> => {
    setState((draft) => {
      draft.busy[connectionId] = true;
    });
    try {
      return await run();
    } finally {
      setState((draft) => {
        delete draft.busy[connectionId];
      });
    }
  };

  const agents = (): MarketplaceConnectionAgent[] =>
    options.agents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      title: agent.title,
      avatarSeed: agent.avatarSeed,
      avatarHue: agent.avatarHue,
      avatarUrl: agent.avatarUrl,
      connectionsOff: state.off[agent.id] ?? agent.connectionsOff ?? [],
    }));

  const model: MarketplaceConnections = {
    status: () => state.view?.status ?? "unavailable",
    readAt: () => state.view?.readAt ?? null,
    refresh: () => read(true),
    busy: (connectionId) => Boolean(state.busy[connectionId]),
    choosePayer: async (connectionId, orgId) => {
      const calls = options.calls();
      if (!calls) return;
      await withBusy(connectionId, () => calls.choosePayer({ connectionId, orgId })).then(take, options.onError);
    },
    requestAccess: async (
      connectionId: string,
      orgId: string,
      kind: HubAccessRequestKind,
    ): Promise<HubConnectionAccessRequestResult> => {
      const calls = options.calls();
      if (!calls) return { status: "failed", requestedAt: null, failure: "signed_out" };
      const result = await calls.requestAccess({ connectionId, orgId, kind });
      // The catalog row now carries the request date.
      if (result.status !== "failed") read(false);
      return result;
    },
    agents,
    setAgentConnection: async (agentId, connectionId, on) => {
      const current = agents().find((agent) => agent.id === agentId)?.connectionsOff ?? [];
      const next = on ? current.filter((id) => id !== connectionId) : [...new Set([...current, connectionId])];
      await withBusy(connectionId, () => options.setConnectionsOff(agentId, next)).then(
        () =>
          setState((draft) => {
            draft.off[agentId] = next;
          }),
        options.onError,
      );
    },
  };

  return {
    /** The connection rows of the Apps list. Empty until main answers, or when it has none. */
    apps: (): MarketplaceApp[] => (state.view?.connections ?? []).map(connectionApp),
    /** Absent where this Marketplace has no Hub connections. */
    model: (): MarketplaceConnections | undefined => (options.calls() ? model : undefined),
  };
}
