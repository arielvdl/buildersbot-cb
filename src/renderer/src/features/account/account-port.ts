import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What the account context reaches in main: the Builders Bot account session, its devices, and the
 * usage the page rail and the Usage page show.
 */
export interface AccountPort {
  agent: Pick<BuildersBotDesktopApi["agent"], "getUsage">;
  auth: Pick<
    BuildersBotDesktopApi["auth"],
    | "cancelMobileConnect"
    | "createMobileConnect"
    | "createMobileConnectLink"
    | "getMobileConnectLink"
    | "getState"
    | "listAccountSessions"
    | "listMobileConnectedDevices"
    | "logout"
    | "onEvent"
    | "requestEmailCode"
    | "retry"
    | "revokeAccountSession"
    | "revokeMobileConnectedDevice"
    | "revokeMobileConnectLink"
    | "updateAvatar"
    | "updateName"
    | "verifyEmailCode"
  >;
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function accountPort(): AccountPort {
  return window.openbot;
}
