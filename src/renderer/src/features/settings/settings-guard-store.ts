import {
  type BuildersBotDesktopApi,
  type ClientAgentModelOption,
  DEFAULT_GUARD_JUDGE,
  type GuardAvailableLevel,
  type GuardJudgeChoice,
  type GuardPreferenceChange,
  type GuardState,
  isAgentProvider,
  LOCAL_SERVER_ID,
} from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { currentText } from "@openbot/ui/text";
import { createEffect, createStore } from "solid-js";

/** What the Guard page reaches in main. Read on each call: tests and stories replace `window.openbot`. */
type GuardSettingsPort = Pick<BuildersBotDesktopApi, "guard"> & {
  agent: Pick<BuildersBotDesktopApi["agent"], "listModels">;
};

function guardPort(): GuardSettingsPort {
  return window.openbot;
}

/** One row of the model list: a model, or the local check alone. */
export interface GuardModelRow {
  readonly key: string;
  readonly choice: GuardJudgeChoice | null;
  /** The model name as the provider lists it, or the id when the list does not have it. */
  readonly name: string;
  readonly recommended: boolean;
}

export const LOCAL_ONLY_KEY = "local";

export function guardModelKey(choice: GuardJudgeChoice | null): string {
  return choice ? JSON.stringify([choice.provider, choice.model]) : LOCAL_ONLY_KEY;
}

function sameChoice(left: GuardJudgeChoice, right: GuardJudgeChoice): boolean {
  return left.provider === right.provider && left.model === right.model;
}

/**
 * The rows of the model list: the fast Cultura Builder model first and marked, the other Cultura
 * Builder models next, then the models of the other providers, and the local check alone last. The
 * default and the current choice are in the list also when the provider does not list them now,
 * such as Cultura Builder with no sign-in.
 */
export function guardModelRows(
  models: readonly ClientAgentModelOption[],
  current: GuardJudgeChoice | null,
): GuardModelRow[] {
  const listed = models.flatMap((model) =>
    isAgentProvider(model.provider)
      ? [{ choice: { provider: model.provider, model: model.id }, name: model.name }]
      : [],
  );
  const named = (choice: GuardJudgeChoice) =>
    listed.find((entry) => sameChoice(entry.choice, choice))?.name ?? choice.model.split("/").at(-1) ?? choice.model;
  const rows: GuardModelRow[] = [
    {
      key: guardModelKey(DEFAULT_GUARD_JUDGE),
      choice: DEFAULT_GUARD_JUDGE,
      name: named(DEFAULT_GUARD_JUDGE),
      recommended: true,
    },
  ];
  const add = (choice: GuardJudgeChoice, name: string) => {
    if (rows.some((row) => row.choice && sameChoice(row.choice, choice))) return;
    rows.push({ key: guardModelKey(choice), choice, name, recommended: false });
  };
  for (const entry of listed) if (entry.choice.provider === "cultura-builder") add(entry.choice, entry.name);
  if (current) add(current, named(current));
  for (const entry of listed) add(entry.choice, entry.name);
  rows.push({ key: LOCAL_ONLY_KEY, choice: null, name: "", recommended: false });
  return rows;
}

interface GuardSettingsState {
  /** Null before main answers. */
  guard: GuardState | null;
  models: ClientAgentModelOption[];
  saving: boolean;
}

function fail(error: unknown, fallback: "guard.loadFailed" | "guard.saveFailed"): void {
  const { t, errorMessage } = currentText();
  toast.error(errorMessage(error, t(fallback)), {
    report: { operation: "settings", source: "system", cause_code: "unknown" },
  });
}

/**
 * The Guard page's view of the preference and of the models that can review. It reads both again
 * each time the page opens, so a sign-in made elsewhere shows when the person comes back.
 */
export function createSettingsGuardStore(active: () => boolean) {
  const [state, setState] = createStore<GuardSettingsState>({ guard: null, models: [], saving: false });

  createEffect(active, (isActive) => {
    if (!isActive) return;
    const port = guardPort();
    void port.guard
      .getState()
      .then((guard) =>
        setState((draft) => {
          draft.guard = guard;
        }),
      )
      .catch((error: unknown) => fail(error, "guard.loadFailed"));
    // The model list is a nicety: without it, the page still offers the default and the local check.
    void port.agent
      .listModels(LOCAL_SERVER_ID)
      .then((models) =>
        setState((draft) => {
          draft.models = models;
        }),
      )
      .catch(() => undefined);
  });

  function save(change: GuardPreferenceChange): void {
    if (state.saving) return;
    setState((draft) => {
      draft.saving = true;
    });
    void guardPort()
      .guard.setPreference(change)
      .then((guard) =>
        setState((draft) => {
          draft.guard = guard;
        }),
      )
      .catch((error: unknown) => fail(error, "guard.saveFailed"))
      .finally(() =>
        setState((draft) => {
          draft.saving = false;
        }),
      );
  }

  return {
    state,
    rows: () => guardModelRows(state.models, state.guard?.preference.judge ?? null),
    setLevel: (level: GuardAvailableLevel) => save({ level }),
    setJudge: (choice: GuardJudgeChoice | null) => save({ judge: choice }),
  };
}

export type SettingsGuardStore = ReturnType<typeof createSettingsGuardStore>;
