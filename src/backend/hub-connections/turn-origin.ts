// Where a turn came from, for the Hub connections (docs/architecture/hub-connections.md, "Who may
// use them"). The process decides it from the stored messages of the turn, never from the agent's
// text. A message that an agent, a task, a routine or a flow sends carries the origin of the turn or
// of the person that made it, so a turn that may not spend cannot start a turn that may.

/**
 * Where the turn that calls the tool came from. Only the person at this computer (`owner_ui`), the
 * person's routines and the person's agents get the tools. A chat app thread, a channel and a team
 * member never do: they would spend the person's money, and they are a direct path for injection.
 * `unknown` is a turn whose origin the app cannot prove; it never gets the tools.
 *
 * `routine_agent` is an agent turn that a routine started, at any distance: a message that a routine's
 * turn sent, or a run of a routine that an agent or a routine saved (a webhook routine too). For the Hub
 * connections it is `agent` (`hubConnectionOrigin`). It stays on every message that such a turn sends,
 * so the owner's Chrome, which no routine may use, stays closed along the whole chain.
 */
export const HUB_TURN_ORIGINS = [
  "owner_ui",
  "routine",
  "agent",
  "routine_agent",
  "unknown",
  "team_member",
  "messaging",
] as const;
export type HubTurnOrigin = (typeof HUB_TURN_ORIGINS)[number];

/** The origins that get the connection tools. Each other origin is closed. */
export const CONNECTION_ORIGINS: ReadonlySet<HubTurnOrigin> = new Set([
  "owner_ui",
  "routine",
  "agent",
  "routine_agent",
]);

/** The origin that the Hub connections read: an agent turn that a routine started is an agent turn there. */
export function hubConnectionOrigin(origin: HubTurnOrigin): HubTurnOrigin {
  return origin === "routine_agent" ? "agent" : origin;
}

export function isHubTurnOrigin(value: unknown): value is HubTurnOrigin {
  return HUB_TURN_ORIGINS.some((origin) => origin === value);
}

/** The order of `HUB_TURN_ORIGINS`: from the most open to the most closed. */
function rank(origin: HubTurnOrigin): number {
  return HUB_TURN_ORIGINS.indexOf(origin);
}

/** The more closed of two origins. */
export function narrowerOrigin(left: HubTurnOrigin, right: HubTurnOrigin): HubTurnOrigin {
  return rank(right) > rank(left) ? right : left;
}

/**
 * The origin of a message that a turn of this origin sends to an agent: with `send_message`, as the
 * brief of a task, as the first message of an agent that it creates, as an interrupt notice or as an
 * automatic result. The person's own turns pass on `agent`, and routines pass on `routine_agent`; both
 * get no cards and no amounts. A closed origin stays closed.
 */
export function sentOrigin(origin: HubTurnOrigin): HubTurnOrigin {
  if (origin === "owner_ui") return "agent";
  return origin === "routine" ? "routine_agent" : origin;
}

/**
 * The origin of the runs of a routine that someone of this origin saved. The person (in the app, or
 * in the person's own turn) makes a routine of the person; an agent's or a routine's turn makes one that
 * runs as `routine_agent`. A closed origin makes a closed routine.
 */
export function routineOriginOf(savedBy: HubTurnOrigin): HubTurnOrigin {
  if (savedBy === "owner_ui") return "routine";
  return savedBy === "routine" || savedBy === "agent" ? "routine_agent" : savedBy;
}

/** What one delivery of a turn says about who started it. */
export interface HubDeliveryOrigin {
  readonly sender: "user" | "agent" | "routine";
  /** The message came from Slack, Discord or Telegram, or an agent sent it from such a thread. */
  readonly messaging: boolean;
  /** The message belongs to a channel. */
  readonly channel: boolean;
  /** The person the host stamped on a user message; null for the person at this computer. */
  readonly memberId: string | null;
  /** The person who last edited the queued message through the host; null when nobody did. */
  readonly editorId: string | null;
  /**
   * The origin that the sender stamped on the message: the sending turn's (`sentOrigin`), or the
   * routine's. Null on a message that has none: an agent or a routine message without one is closed.
   */
  readonly stamp: HubTurnOrigin | null;
}

/** The origin of one delivery. */
export function deliveryOrigin(
  delivery: HubDeliveryOrigin,
  remotePerson: (memberId: string) => boolean,
): HubTurnOrigin {
  if (delivery.messaging) return "messaging";
  if (delivery.channel) return "team_member";
  // An agent or a routine message proves its origin only with a stamp.
  let origin: HubTurnOrigin = delivery.sender === "user" ? "owner_ui" : (delivery.stamp ?? "unknown");
  if (delivery.sender === "user" && delivery.stamp) origin = narrowerOrigin(origin, delivery.stamp);
  // The run of a routine that an agent saved before `routine_agent` existed is stamped `agent`.
  if (delivery.sender === "routine" && origin === "agent") origin = "routine_agent";
  for (const memberId of [delivery.memberId, delivery.editorId])
    if (memberId !== null && remotePerson(memberId)) origin = narrowerOrigin(origin, "team_member");
  return origin;
}

/** The origin of a turn: the most closed origin of its thread and of all its deliveries. */
export function hubTurnOrigin(
  deliveries: readonly HubDeliveryOrigin[],
  thread: { readonly messaging: boolean; readonly channel: boolean },
  remotePerson: (memberId: string) => boolean,
): HubTurnOrigin {
  let origin: HubTurnOrigin = deliveries.length === 0 ? "unknown" : "owner_ui";
  if (thread.messaging) origin = narrowerOrigin(origin, "messaging");
  if (thread.channel) origin = narrowerOrigin(origin, "team_member");
  for (const delivery of deliveries) origin = narrowerOrigin(origin, deliveryOrigin(delivery, remotePerson));
  return origin;
}
