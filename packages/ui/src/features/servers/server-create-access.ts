import type { ServerCreationAccess } from "@openbot/contracts/server-creation";

/** What the join dialog shows about the creation of a remote server. */
export type ServerCreateAccessState = "allowed" | "request" | "pending" | "denied";

/**
 * Null hides the section: the access is not known (no answer, or an older account server), this
 * deployment cannot create remote servers (hosting is off), or the person can create but the app has no
 * create flow to open. The account server checks the permission on each create, so this only decides
 * what the dialog shows.
 */
export function serverCreateAccessState(
  access: ServerCreationAccess | null,
  canOpenCreate: boolean,
): ServerCreateAccessState | null {
  if (!access?.creationAvailable) return null;
  if (access.canCreate) return canOpenCreate ? "allowed" : null;
  if (access.request?.status === "pending") return "pending";
  if (access.request?.status === "denied") return "denied";
  return "request";
}
