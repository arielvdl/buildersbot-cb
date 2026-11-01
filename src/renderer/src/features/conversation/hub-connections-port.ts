import type { HubConnectionAccessRequestResult } from "@openbot/contracts/ipc";

/**
 * "Ask the admin for more" from the line of a Hub connection call that the cap stopped. Main asks the
 * Hub with the Cultura Builder session of this computer, so only a chat of this computer offers it.
 */
export function requestConnectionMore(connectionId: string, orgId: string): Promise<HubConnectionAccessRequestResult> {
  return window.openbot.hubConnections.requestAccess({ connectionId, orgId, kind: "more" });
}
