// The app default egress proxy for the servers that this app makes later. See "Default for new
// servers" in docs/architecture/egress-proxy.md.
//
// A server on this computer takes it in its environment at its first start, before any agent runs.
// A hosted server takes it over `egress-proxy-v1` when it is first online and the user can
// administer it. A joined server and this computer's own server never take it.

import {
  canAdministerServer,
  type EgressProxyDefaultView,
  type EgressProxyUpdate,
  type ServerSummary,
} from "@openbot/contracts/ipc";
import { EGRESS_PROXY_CAPABILITY } from "@openbot/contracts/team-protocol/egress-proxy-v1";
import type { Effect } from "effect";
import { runCauseEffect } from "../backend/effect-boundary";
import type { EgressProxyStore } from "./egress-proxy-store";

/** The variable that carries the default to a new server on this computer. The child removes it at once. */
export const EGRESS_DEFAULT_ENVIRONMENT = "OPENBOT_LOCAL_SERVER_EGRESS";

export interface EgressDefaultRemote {
  supportsCapability(serverId: string, capability: typeof EGRESS_PROXY_CAPABILITY): boolean;
  /** Sends the update to one server; the answer is the server's view, which is not needed here. */
  sendUpdate(serverId: string, update: EgressProxyUpdate): Effect.Effect<unknown, { readonly cause: unknown }>;
}

export class EgressProxyDefault {
  readonly #store: EgressProxyStore;
  readonly #log: { warn: (message: string, detail?: unknown) => void };
  readonly #sending = new Set<string>();

  constructor(store: EgressProxyStore, log: { warn: (message: string, detail?: unknown) => void }) {
    this.#store = store;
    this.#log = log;
  }

  /** Null when no default is saved. */
  view(): EgressProxyDefaultView | null {
    if (!this.#store.exists() || this.#store.unreadable()) return null;
    return { ...this.#store.settings(), passwordSaved: this.#store.passwordSaved() };
  }

  /** Saves the default, or removes it with null. */
  async set(update: EgressProxyUpdate | null): Promise<EgressProxyDefaultView | null> {
    if (update === null) await runCauseEffect(this.#store.clear());
    else await runCauseEffect(this.#store.save(update));
    return this.view();
  }

  /** The whole default with its password, for a new server only. Null when none is on. */
  #update(): EgressProxyUpdate | null {
    const view = this.view();
    if (!view?.enabled) return null;
    const { passwordSaved: _saved, ...settings } = view;
    const password = this.#store.password();
    return password === null ? settings : { ...settings, password };
  }

  /** The value of `EGRESS_DEFAULT_ENVIRONMENT` for the first start of a new server on this computer. */
  childEnvironmentValue(): string | null {
    const update = this.#update();
    return update ? JSON.stringify(update) : null;
  }

  /** A hosted server that this app made: it takes the default when it is first online. Never throws. */
  async serverCreated(serverId: string): Promise<void> {
    if (!this.#update()) return;
    await this.#setPending([...this.#store.pendingServers(), serverId]);
  }

  /**
   * Sends the default to each pending server that is online, supports `egress-proxy-v1`, and that
   * the user can administer. A new hosted server can take minutes to show in the list, so an id
   * waits until a send succeeds or the default is removed. A failed send waits for the next change
   * of the list. Resolves when the sends of this call end; it never throws.
   */
  async reconcile(
    servers: readonly Pick<ServerSummary, "id" | "kind" | "state" | "role">[],
    remote: EgressDefaultRemote,
  ): Promise<void> {
    const pending = this.#store.exists() ? this.#store.pendingServers() : [];
    const update = this.#update();
    if (pending.length === 0 || !update) return;
    const ready = servers.filter(
      (server) =>
        pending.includes(server.id) &&
        !this.#sending.has(server.id) &&
        server.kind === "remote" &&
        server.state === "online" &&
        canAdministerServer(server.role) &&
        remote.supportsCapability(server.id, EGRESS_PROXY_CAPABILITY),
    );
    await Promise.all(
      ready.map(async (server) => {
        this.#sending.add(server.id);
        try {
          await runCauseEffect(remote.sendUpdate(server.id, update));
          await this.#setPending(this.#store.pendingServers().filter((id) => id !== server.id));
        } catch (error) {
          this.#log.warn("A new server did not take the default egress proxy.", error);
        } finally {
          this.#sending.delete(server.id);
        }
      }),
    );
  }

  async #setPending(serverIds: readonly string[]): Promise<void> {
    try {
      await runCauseEffect(this.#store.setPending(serverIds));
    } catch (error) {
      this.#log.warn("The servers that wait for the default egress proxy were not saved.", error);
    }
  }
}
