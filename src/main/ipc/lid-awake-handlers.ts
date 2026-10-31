// Keep a Mac laptop on with its lid closed: the mode, its safety service and the test.

import { parseLidAwakePreferenceChange } from "@openbot/contracts/ipc";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { LidAwakeService } from "../lid-awake-service";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export interface LidAwakeIpcDependencies {
  lidAwake: LidAwakeService;
}

export function lidAwakeIpcHandlers({ lidAwake }: LidAwakeIpcDependencies): Pick<IpcGroupHandlers, "lidAwake"> {
  return {
    lidAwake: {
      // Reads the computer again, so Settings shows the battery and a sleep setting that changed.
      getStatus: handler(() => runCauseEffect(lidAwake.refresh())),
      setPreference: payloadHandler(parseLidAwakePreferenceChange, (change) =>
        runCauseEffect(lidAwake.setPreference(change)),
      ),
      installHelper: handler(() => runCauseEffect(lidAwake.installHelper())),
      restoreNormalSleep: handler(() => runCauseEffect(lidAwake.restoreNormalSleep())),
      startTest: handler(() => runCauseEffect(lidAwake.startTest())),
      finishTest: handler(() => runCauseEffect(lidAwake.finishTest())),
    },
  };
}
