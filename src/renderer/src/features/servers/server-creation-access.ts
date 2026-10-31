import type { HostedServersDesktopApi } from "@openbot/contracts/ipc";
import type { ServerCreationAccess } from "@openbot/contracts/server-creation";
import { createEffect, createSignal, untrack } from "solid-js";

type ServerCreationAccessCalls = Pick<HostedServersDesktopApi, "creationAccess" | "requestCreationAccess">;

/**
 * The permission of the signed-in person to create a remote server, for the join dialog of the
 * desktop app and of the web client. It reads the access each time the dialog opens. A failed read
 * (no network, an older account server) leaves it null, and the dialog then hides the section.
 */
export function createServerCreationAccess(open: () => boolean, calls: () => ServerCreationAccessCalls | undefined) {
  const [access, setAccess] = createSignal<ServerCreationAccess | null>(null);
  createEffect(open, (isOpen) => {
    if (!isOpen) return;
    const api = untrack(calls);
    if (!api) return;
    let active = true;
    void api.creationAccess().then(
      (value) => {
        if (active) setAccess(value);
      },
      () => {
        if (active) setAccess(null);
      },
    );
    return () => {
      active = false;
    };
  });

  /** Sends the request. A refusal reaches the caller, which shows it in the dialog. */
  async function request(reason: string): Promise<void> {
    const api = calls();
    if (!api) return;
    setAccess(await api.requestCreationAccess({ reason }));
  }

  return { access, request };
}
