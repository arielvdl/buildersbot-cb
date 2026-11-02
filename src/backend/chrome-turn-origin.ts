/**
 * Where a turn came from, for the owner's Chrome (DESIGN §7, item 14; NEXT.md, decision 5). The app
 * decides it from the stored messages of the turn, never from the agent's text, with the rule of the
 * Hub connections (`hubTurnOrigin`) and one change: a channel thread is open while nobody but the
 * owner can write in the channels, so a channel of the owner's own agents can use Chrome. While a team
 * member can write in them, a channel turn is closed, as a team member's message, a chat app thread, a
 * routine and an origin that the app cannot prove are.
 */

import { type HubDeliveryOrigin, type HubTurnOrigin, hubTurnOrigin } from "./hub-connections/turn-origin";

/**
 * The origins whose turns may use the owner's Chrome: the person here, and the person's agents. A
 * routine is not one: it needs a release of its own, which this release does not have.
 */
export const CHROME_TURN_ORIGINS: ReadonlySet<HubTurnOrigin> = new Set(["owner_ui", "agent"]);

/** The origin of a turn for the owner's Chrome. `channelsHaveRemotePeople`: a team member can write in the channels. */
export function chromeTurnOrigin(
  deliveries: readonly HubDeliveryOrigin[],
  thread: { readonly messaging: boolean; readonly channel: boolean },
  remotePerson: (memberId: string) => boolean,
  channelsHaveRemotePeople: boolean,
): HubTurnOrigin {
  if (channelsHaveRemotePeople) return hubTurnOrigin(deliveries, thread, remotePerson);
  return hubTurnOrigin(
    deliveries.map((delivery) => ({ ...delivery, channel: false })),
    { ...thread, channel: false },
    remotePerson,
  );
}
