import type { HostedServersDesktopApi } from "@openbot/contracts/ipc";
import type {
  ServerCreationAdminState,
  ServerCreationGrant,
  ServerCreationRequest,
} from "@openbot/contracts/server-creation";
import { createEffect, createStore, untrack } from "solid-js";
import { currentText } from "../../../text";

export type ServerCreationAdminCalls = Pick<
  HostedServersDesktopApi,
  "creationAccess" | "creationAdmin" | "grantCreation" | "revokeCreation" | "decideCreationRequest"
>;

interface ServerCreationAdminPanel {
  /** False until the account server says that this account is an administrator. */
  administrator: boolean;
  loaded: boolean;
  error: string | null;
  requests: ServerCreationRequest[];
  grants: ServerCreationGrant[];
  /** The request or the person whose change waits for the answer, or `grant` for the form. */
  busy: string | null;
  actionError: string | null;
  email: string;
  note: string;
}

/**
 * The administrator section of server creation: the requests that wait and the people with the
 * permission. It reads the access first and shows nothing to a person who is not an administrator.
 * The account server checks the administrator again on each call.
 */
export function createServerCreationAdminStore(
  calls: () => ServerCreationAdminCalls | undefined,
  visible: () => boolean,
) {
  const [panel, setPanel] = createStore<ServerCreationAdminPanel>({
    administrator: false,
    loaded: false,
    error: null,
    requests: [],
    grants: [],
    busy: null,
    actionError: null,
    email: "",
    note: "",
  });
  let loadRevision = 0;

  function hide(draft: ServerCreationAdminPanel): void {
    draft.administrator = false;
    draft.loaded = false;
    draft.error = null;
    draft.actionError = null;
    draft.requests = [];
    draft.grants = [];
  }

  function apply(state: ServerCreationAdminState): void {
    setPanel((draft) => {
      draft.requests = state.requests;
      draft.grants = state.grants;
      draft.loaded = true;
      draft.error = null;
    });
  }

  async function load(): Promise<void> {
    const api = calls();
    if (!api) return;
    const revision = ++loadRevision;
    let accessKnown = false;
    try {
      const access = await api.creationAccess();
      if (revision !== loadRevision) return;
      accessKnown = true;
      setPanel((draft) => {
        if (!access.administrator) hide(draft);
        draft.administrator = access.administrator;
      });
      if (!access.administrator) return;
      const state = await api.creationAdmin();
      if (revision === loadRevision) apply(state);
    } catch (error) {
      if (revision !== loadRevision) return;
      setPanel((draft) => {
        // Before the access is known, a failure hides the section and drops its rows: they can belong to
        // the account of an earlier session. Only a new answer with `administrator: true` shows them again.
        if (!accessKnown) {
          hide(draft);
          return;
        }
        const text = currentText();
        draft.error = text.errorMessage(error, text.t("settings.serverCreation.loadFailed"));
      });
    }
  }

  createEffect(visible, (shown) => {
    if (shown) void untrack(load);
  });

  async function change(key: string, action: (api: ServerCreationAdminCalls) => Promise<ServerCreationAdminState>) {
    const api = calls();
    if (!api || panel.busy !== null) return false;
    setPanel((draft) => {
      draft.busy = key;
      draft.actionError = null;
    });
    try {
      apply(await action(api));
      return true;
    } catch (error) {
      setPanel((draft) => {
        const text = currentText();
        draft.actionError = text.errorMessage(error, text.t("settings.serverCreation.actionFailed"));
      });
      return false;
    } finally {
      setPanel((draft) => {
        draft.busy = null;
      });
    }
  }

  return {
    state: panel,
    reload: () => void load(),
    approve: (requestId: string) =>
      void change(requestId, (api) => api.decideCreationRequest({ requestId, decision: "approve" })),
    deny: (requestId: string) =>
      void change(requestId, (api) => api.decideCreationRequest({ requestId, decision: "deny" })),
    revoke: (userId: string) => void change(userId, (api) => api.revokeCreation(userId)),
    setEmail: (email: string) =>
      setPanel((draft) => {
        draft.email = email;
      }),
    setNote: (note: string) =>
      setPanel((draft) => {
        draft.note = note;
      }),
    async grant(): Promise<void> {
      const email = panel.email.trim();
      const note = panel.note.trim();
      if (!email) return;
      const granted = await change("grant", (api) => api.grantCreation(note ? { email, note } : { email }));
      if (!granted) return;
      setPanel((draft) => {
        draft.email = "";
        draft.note = "";
      });
    },
  };
}

export type ServerCreationAdminStore = ReturnType<typeof createServerCreationAdminStore>;
