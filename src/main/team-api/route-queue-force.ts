import type { ForceQueuedMessageInput } from "@openbot/contracts/ipc";
import { QUEUE_FORCE_CAPABILITY, QUEUE_FORCE_ROUTES } from "@openbot/contracts/team-protocol/queue-force-v1";
import { sourceText } from "@openbot/i18n/source";
import { QueueForceRefused } from "../../backend/agent/queue-force";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiAgents } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAgentLevel, stringField } from "./request-helpers";

/**
 * A force of one queued message, from a joined server: the host stops the turn that holds the agent's
 * own chat and starts the message next. A member who may send the agent a message may force one, as
 * for a steer. The agent id is in the body, so the router's check of the path does not see it, and
 * this module refuses an agent hidden from the caller. Frozen by `queue-force-v1`.
 */
export async function routeQueueForce(
  context: TeamApiRequestContext,
  agents: Pick<TeamApiAgents, "forceQueuedMessage" | "listAgents">,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json } = context;
  if (method !== "POST" || url.pathname !== QUEUE_FORCE_ROUTES.force) return "unmatched";
  if (!capabilities.has(QUEUE_FORCE_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.queueForceUnsupported"));
  // `readJson` has already run the body through the queue-force wire codec.
  const body = await readJson(request);
  const agentId = stringField(body, "agentId");
  if (hiddenAgentIds.has(agentId) || !agents.listAgents().some((agent) => agent.id === agentId))
    throw new HttpError(404, sourceText("error.team.agentNotFound"));
  requireAgentLevel(context, agentId, "chat");
  const expectedTurnId = body.expectedTurnId === null ? null : stringField(body, "expectedTurnId");
  const input: ForceQueuedMessageInput = { agentId, deliveryId: stringField(body, "deliveryId"), expectedTurnId };
  try {
    const { outcome } = await runCauseEffect(agents.forceQueuedMessage(input));
    return json(200, { outcome });
  } catch (error) {
    // A client shows a refusal's text, but only "Request failed" for a 500.
    if (error instanceof QueueForceRefused) throw new HttpError(409, error.message);
    throw error;
  }
}
