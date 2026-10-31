// Frozen optional queue-force-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: a member who can chat with
// an agent can force one message that waits in the agent's own queue. The host stops the turn that
// holds the agent's own chat, as the Stop button does, and starts that message next, alone, before
// the other queued messages. That turn runs in the agent's chat, or in a channel or messaging thread
// of the same agent; the host stops no turn of another agent. The member names the turn of the
// agent's chat that it saw running, or null. The host does not stop a chat turn that the member did
// not see: the message then waits at the head of the queue. Channel, messaging and task work keep
// their own controls. The answer says what the host did. Widening any of it needs a second capability
// string.
import { adminRoute, fields, identifier, nullable, type OptionalRouteCodec, oneOf } from "./admin-wire";

export const QUEUE_FORCE_CAPABILITY = "queue-force-v1";

export const QUEUE_FORCE_ROUTES = {
  force: "/v1/agent-queue/force",
} as const;

/** The same values as `FORCE_QUEUED_MESSAGE_OUTCOMES`, written out so that an IPC change cannot move the wire. */
const forced = fields({ outcome: oneOf("interrupted", "started", "next") });

export const QUEUE_FORCE_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    QUEUE_FORCE_ROUTES.force,
    adminRoute(fields({ agentId: identifier, deliveryId: identifier, expectedTurnId: nullable(identifier) }), forced),
  ],
]);
