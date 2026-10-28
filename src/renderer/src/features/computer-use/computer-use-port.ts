import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What Computer Use reaches in main: the driver state, the macOS permission panes and helper, and
 * the highlight placement. The helper and highlight windows have no provider tree, so this is a
 * module.
 */
export interface ComputerUsePort {
  computerUse: BuildersBotDesktopApi["computerUse"];
  remoteDesktop: Pick<BuildersBotDesktopApi["remoteDesktop"], "checkSetup">;
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function computerUsePort(): ComputerUsePort {
  return window.openbot;
}
