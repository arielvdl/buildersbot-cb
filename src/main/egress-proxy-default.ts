// The app default egress proxy for the servers that this app makes later. See "Default for new
// servers" in docs/architecture/egress-proxy.md.
//
// A server on this computer takes it as a setting file in its own user data folder, which this
// process writes before the first start of the server: the password never goes into an environment.
// A hosted server takes it over `egress-proxy-v1` when it is first online and the user can
// administer it. A joined server and this computer's own server never take it.

import {
  canAdministerServer,
  type EgressProxyDefaultView,
  type EgressProxyUpdate,
  type EgressProxyView,
  egressSettingsComplete,
  type ServerSummary,
} from "@openbot/contracts/ipc";
import { EGRESS_PROXY_CAPABILITY } from "@openbot/contracts/team-protocol/egress-proxy-v1";
import { sourceText } from "@openbot/i18n/source";
import type { Effect } from "effect";
import { runCauseEffect } from "../backend/effect-boundary";
import type { EgressProxyStore } from "./egress-proxy-store";

export interface EgressDefaultRemote {
  supportsCapability(serverId: string, capability: typeof EGRESS_PROXY_CAPABILITY): boolean;
  /** The server's own setting, read before a send so that the default never replaces a setting. */
  readView(serverId: string): Effect.Effect<EgressProxyView, { readonly cause: unknown }>;
  /** Sends the update to one server; the answer is the server's view, which is not needed here. */
  sendUpdate(serverId: string, update: EgressProxyUpdate): Effect.Effect<unknown, { readonly cause: unknown }>;
}

export interface EgressProxyDefaultOptions {
  store: EgressProxyStore;
  log: { warn: (message: string, detail?: unknown) => void };
  /**
   * The setting file of a new server on this computer, in its user data folder. It uses the cipher
   * of this app: the server is the same app with another folder, so it reads the same keychain item.
   */
  serverStore: (userData: string) => EgressProxyStore;
}

export class EgressProxyDefault {
  readonly #store: EgressProxyStore;
  readonly #log: EgressProxyDefaultOptions["log"];
  readonly #serverStore: EgressProxyDefaultOptions["serverStore"];
  readonly #sending = new Set<string>();

  constructor(options: EgressProxyDefaultOptions) {
    this.#store = options.store;
    this.#log = options.log;
    this.#serverStore = options.serverStore;
  }

  /** Null when no default is saved. */
  view(): EgressProxyDefaultView | null {
    if (!this.#store.exists() || this.#store.unreadable()) return null;
    return { ...this.#store.settings(), passwordSaved: this.#store.passwordSaved() };
  }

  /**
   * Saves the default, or removes it with null. As for a server, the saved password stays only for
   * the same host, port and user, and a default that is on must name a whole upstream.
   */
  async set(update: EgressProxyUpdate | null): Promise<EgressProxyDefaultView | null> {
    if (update === null) await runCauseEffect(this.#store.clear());
    else {
      if (update.enabled && !egressSettingsComplete(update, this.#store.passwordAfter(update)))
        throw new Error(sourceText("error.host.egressIncomplete"));
      await runCauseEffect(this.#store.save(update));
    }
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

  /**
   * Before the first start of a new server on this computer: writes the default as the server's own
   * setting, so the server has it before its first agent. A failure throws, and the caller does not
   * make the server: a new server must not start without the proxy that the default names.
   */
  async writeToNewServer(userData: string): Promise<void> {
    const update = this.#update();
    if (!update) return;
    const store = this.#serverStore(userData);
    await runCauseEffect(store.load());
    if (store.exists()) return;
    await runCauseEffect(store.save(update));
  }

  /** A hosted server that this app made: it takes the default when it is first online. Never throws. */
  async serverCreated(serverId: string): Promise<void> {
    if (!this.#update()) return;
    await this.#editPending((serverIds) => [...serverIds, serverId]);
  }

  /**
   * Sends the default to each pending server that is online, supports `egress-proxy-v1`, and that
   * the user can administer. A new hosted server can take minutes to show in the list, so an id
   * waits until a send succeeds or the default is removed. A server whose owner already set a proxy
   * keeps it, and leaves the list. A failed send waits for the next change of the list. Resolves when
   * the sends of this call end; it never throws.
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
          const current = await runCauseEffect(remote.readView(server.id));
          if (!current.enabled && !current.host) await runCauseEffect(remote.sendUpdate(server.id, update));
          await this.#editPending((serverIds) => serverIds.filter((id) => id !== server.id));
        } catch (error) {
          this.#log.warn("A new server did not take the default egress proxy.", error);
        } finally {
          this.#sending.delete(server.id);
        }
      }),
    );
  }

  async #editPending(change: (serverIds: readonly string[]) => readonly string[]): Promise<void> {
    try {
      await runCauseEffect(this.#store.editPending(change));
    } catch (error) {
      this.#log.warn("The servers that wait for the default egress proxy were not saved.", error);
    }
  }
}
