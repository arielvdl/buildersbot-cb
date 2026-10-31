// The Guard of this computer: its level and its reviewer model. The change is parsed by the contract
// before the store sees it, so a window can choose only a level that this version runs.

import { type GuardState, parseGuardPreferenceChange } from "@openbot/contracts/ipc";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { GuardPreferenceStore } from "../guard-preference-store";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export interface GuardIpcDependencies {
  guard: GuardPreferenceStore;
  /** Whether the chosen reviewer can run now, read at each call: a sign-in can change it. */
  judgeReady(): boolean;
}

export function guardIpcHandlers({ guard, judgeReady }: GuardIpcDependencies): Pick<IpcGroupHandlers, "guard"> {
  const state = (): GuardState => ({ preference: guard.get(), judgeReady: judgeReady() });
  return {
    guard: {
      getState: handler(() => state()),
      setPreference: payloadHandler(parseGuardPreferenceChange, async (change) => {
        await runCauseEffect(guard.set(change));
        return state();
      }),
    },
  };
}
