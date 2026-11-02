/**
 * Who is on the other side of a Chrome host connection, from the `chrome-peer` addon
 * (`native/chrome-peer/peer.c`): the kernel's audit token of the peer, its pid and user, whether its
 * code meets the requirement of the host of this channel, and whether the process that started it is
 * Chrome. The app asks before it reads a byte.
 */

import { createRequire } from "node:module";
import type { Socket } from "node:net";
import type { ChromeBridgeChannel } from "@openbot/contracts/chrome-bridge/extension-ids";
import { Schema } from "effect";

/** The signed host inside the app bundle (`scripts/build-chrome-host.ts`). */
export const STORE_HOST_REQUIREMENT =
  'anchor apple generic and certificate leaf[subject.OU] = "ZTRDTUL87R" and identifier "app.buildersbot.chrome-host"';

/**
 * Google Chrome, which starts its native host itself: Google's Developer ID (EQHXZ8M8AV) and the
 * identifier of a release channel. A copy of the signed host that another program started has another
 * parent, and the app does not take it.
 */
export const GOOGLE_CHROME_REQUIREMENT =
  'anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV" and (identifier "com.google.Chrome" or identifier "com.google.Chrome.beta" or identifier "com.google.Chrome.dev" or identifier "com.google.Chrome.canary")';

export interface PeerIdentity {
  readonly pid: number;
  readonly uid: number;
  /** null when no requirement was checked (a development build). */
  readonly valid: boolean | null;
  readonly identifier: string | null;
  readonly team: string | null;
  /** The process that started the peer, or null when the kernel gives none. */
  readonly parent: {
    readonly pid: number;
    /** null when no requirement was checked. */
    readonly valid: boolean | null;
    readonly identifier: string | null;
    readonly team: string | null;
  } | null;
}

export interface PeerChecker {
  /** The peer of a connected socket. It throws when the socket has no descriptor or no peer token. */
  check(socket: Socket): PeerIdentity;
  /** A requirement for the process that starts the host is set: a peer that Chrome did not start fails. */
  readonly checksParent: boolean;
}

/** What the addon returns for one socket. */
const PeerIdentitySchema = Schema.Struct({
  pid: Schema.Number,
  uid: Schema.Number,
  valid: Schema.NullOr(Schema.Boolean),
  identifier: Schema.NullOr(Schema.String),
  team: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(
    Schema.Struct({
      pid: Schema.Number,
      valid: Schema.NullOr(Schema.Boolean),
      identifier: Schema.NullOr(Schema.String),
      team: Schema.NullOr(Schema.String),
    }),
  ),
});

/** The addon's module: one function. */
const PeerAddonSchema = Schema.Struct({
  check: Schema.declare(
    (value): value is (fd: number, requirement: string | null, parentRequirement: string | null) => object =>
      typeof value === "function",
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
 * identity is read. `parentRequirement` is the one of the process that starts the host: Google Chrome,
 * the pinned Chrome for Testing in E2E, or null in development.
 */
export function loadPeerChecker(
  addonPath: string,
  requirement: string | null,
  parentRequirement: string | null = null,
): PeerChecker {
  const addon = Schema.decodeUnknownSync(PeerAddonSchema)(createRequire(import.meta.url)(addonPath));
  return {
    check: (socket) => {
      const { fd } = Schema.decodeUnknownSync(SocketHandleSchema)(socket)._handle;
      if (fd < 0) throw new Error("The Chrome host socket has no descriptor.");
      return Schema.decodeUnknownSync(PeerIdentitySchema)(addon.check(fd, requirement, parentRequirement));
    },
    checksParent: parentRequirement !== null,
  };
}

/** The host requirement of a channel; E2E passes its own. */
export function hostRequirement(channel: ChromeBridgeChannel, e2eRequirement?: string): string | null {
  if (channel === "store") return STORE_HOST_REQUIREMENT;
  if (channel === "e2e") return e2eRequirement ?? null;
  return null;
}

/** The requirement of the process that starts the host of a channel; E2E passes its own. */
export function chromeRequirement(channel: ChromeBridgeChannel, e2eRequirement?: string): string | null {
  if (channel === "store") return GOOGLE_CHROME_REQUIREMENT;
  if (channel === "e2e") return e2eRequirement ?? null;
  return null;
}

/**
 * Whether the app takes this peer: the host's code meets its requirement, it runs as this user, and,
 * when a requirement for Chrome is set, Chrome started it. A requirement that was set and not checked
 * (no parent) fails.
 */
export function acceptsPeer(identity: PeerIdentity, uid: number | undefined, checksParent: boolean): boolean {
  if (identity.valid === false || (uid !== undefined && identity.uid !== uid)) return false;
  return !checksParent || identity.parent?.valid === true;
}
