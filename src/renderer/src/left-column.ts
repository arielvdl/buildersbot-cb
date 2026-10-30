import { LEFT_COLUMN_STORAGE_KEY } from "./layout-constants";

/**
 * What the narrow column at the left of the chat list shows: the sections of the active server, or the
 * servers. With the sections, the server menu on the server name lists the servers.
 */
export type LeftColumnView = "sections" | "servers";

/**
 * The choice saved on this computer. The sections are the default, and blocked storage or another
 * value reads as the default.
 */
export function readLeftColumnView(storage: Pick<Storage, "getItem">): LeftColumnView {
  try {
    return storage.getItem(LEFT_COLUMN_STORAGE_KEY) === "servers" ? "servers" : "sections";
  } catch {
    return "sections";
  }
}

export function writeLeftColumnView(view: LeftColumnView, storage: Pick<Storage, "setItem">): void {
  try {
    storage.setItem(LEFT_COLUMN_STORAGE_KEY, view);
  } catch {
    // Blocked or full storage keeps the choice for this window only.
  }
}
