/**
 * Who is on the other side of a Chrome host connection, from the `chrome-peer` addon
 * (`native/chrome-peer/peer.c`): the kernel's audit token of the peer, its pid and user, and whether
 * its code meets the requirement of the host of this channel. The app asks before it reads a byte.
 */

import { createRequire } from "node:module";
import type { Socket } from "node:net";
import type { ChromeBridgeChannel } from "@openbot/contracts/chrome-bridge/extension-ids";
import { Schema } from "effect";

/** The signed host inside the app bundle (`scripts/build-chrome-host.ts`). */
export const STORE_HOST_REQUIREMENT =
  'anchor apple generic and certificate leaf[subject.OU] = "ZTRDTUL87R" and identifier "app.buildersbot.chrome-host"';

export interface PeerIdentity {
  readonly pid: number;
  readonly uid: number;
  /** null when no requirement was checked (a development build). */
  readonly valid: boolean | null;
  readonly identifier: string | null;
  readonly team: string | null;
}

export interface PeerChecker {
  /** The peer of a connected socket. It throws when the socket has no descriptor or no peer token. */
  check(socket: Socket): PeerIdentity;
}

/** What the addon returns for one socket. */
const PeerIdentitySchema = Schema.Struct({
  pid: Schema.Number,
  uid: Schema.Number,
  valid: Schema.NullOr(Schema.Boolean),
  identifier: Schema.NullOr(Schema.String),
  team: Schema.NullOr(Schema.String),
});

/** The addon's module: one function. */
const PeerAddonSchema = Schema.Struct({
  check: Schema.declare(
    (value): value is (fd: number, requirement: string | null) => object => typeof value === "function",
  ),
});

/**
 * The descriptor of a Node socket. Node keeps it on the socket's private handle and has no public
 * accessor; the shape is checked, so a Node that moves it makes the check fail closed.
 */
const SocketHandleSchema = Schema.Struct({ _handle: Schema.Struct({ fd: Schema.Number }) });

/**
 * Loads the addon. `requirement` is the code requirement of the host for this channel: the signed store
 * host, a pinned code hash in E2E, or null in development, where the host is not signed and only its
 * identity is read.
 */
export function loadPeerChecker(addonPath: string, requirement: string | null): PeerChecker {
  const addon = Schema.decodeUnknownSync(PeerAddonSchema)(createRequire(import.meta.url)(addonPath));
  return {
    check: (socket) => {
      const { fd } = Schema.decodeUnknownSync(SocketHandleSchema)(socket)._handle;
      if (fd < 0) throw new Error("The Chrome host socket has no descriptor.");
      return Schema.decodeUnknownSync(PeerIdentitySchema)(addon.check(fd, requirement));
    },
  };
}

/** The host requirement of a channel; E2E passes its own. */
export function hostRequirement(channel: ChromeBridgeChannel, e2eRequirement?: string): string | null {
  if (channel === "store") return STORE_HOST_REQUIREMENT;
  if (channel === "e2e") return e2eRequirement ?? null;
  return null;
}
