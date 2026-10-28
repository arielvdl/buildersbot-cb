import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What the storage panels reach in main: the stored files of a server, and the agent names that
 * label them.
 */
export interface FilesPort {
  agent: Pick<BuildersBotDesktopApi["agent"], "listAgents">;
  /** The old provider CLI versions are optional: a client with no store of its own, such as the web client, has none. */
  storage: Pick<BuildersBotDesktopApi["storage"], "clear" | "deleteFile" | "getUsage" | "openFile"> &
    Partial<Pick<BuildersBotDesktopApi["storage"], "getOldRuntimeVersions" | "removeOldRuntimeVersions">>;
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function filesPort(): FilesPort {
  return window.openbot;
}
