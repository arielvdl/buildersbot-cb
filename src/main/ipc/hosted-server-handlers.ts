// Builders Bot servers that the account server runs for the signed-in account.

import {
  type CreateHostedServerInput,
  type DeleteHostedServerInput,
  parseCreateHostedServerInput,
  parseDeleteHostedServerInput,
  parseHostedServerLifecycleInput,
} from "@openbot/contracts/hosted-servers";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  isServerCreationUserId,
  parseServerCreationAccessRequest,
  parseServerCreationDecisionInput,
  parseServerCreationGrantInput,
} from "@openbot/contracts/server-creation";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { HostedServerDesktopService } from "../hosted-server-service";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { requireString } from "./validation";

export interface HostedServerIpcDependencies {
  hostedServers: HostedServerDesktopService;
  /** A server that this app made. It takes the default egress proxy when it is first online. */
  onCreated?: (serverId: string) => Promise<void>;
}

export function hostedServerIpcHandlers({
  hostedServers,
  onCreated,
}: HostedServerIpcDependencies): Pick<IpcGroupHandlers, "hostedServers"> {
  return {
    hostedServers: {
      lifecycle: payloadHandler(
        (value) => {
          const input = parseHostedServerLifecycleInput(value);
          if (!input) throw new Error("Invalid hosted server lifecycle request.");
          return input;
        },
        (input) => runCauseEffect(hostedServers.lifecycle(input)),
      ),
      list: handler(() => runCauseEffect(hostedServers.list())),
      plans: handler(() => runCauseEffect(hostedServers.plans())),
      create: payloadHandler(parseCreate, async (input) => {
        const summary = await runCauseEffect(hostedServers.create(input));
        // The server exists now. `onCreated` logs its own failure, so the purchase does not fail.
        await onCreated?.(summary.serverId);
        return summary;
      }),
      openCheckout: payloadHandler(
        (value) => requireString(value, "serverId", INPUT_LIMITS.identifier),
        (serverId) => runCauseEffect(hostedServers.openCheckout(serverId)),
      ),
      delete: payloadHandler(parseDelete, (input) => runCauseEffect(hostedServers.delete(input))),
      wake: payloadHandler(
        (value) => requireString(value, "serverId", INPUT_LIMITS.identifier),
        (serverId) => runCauseEffect(hostedServers.wake(serverId)),
      ),
      restart: payloadHandler(
        (value) => requireString(value, "serverId", INPUT_LIMITS.identifier),
        (serverId) => runCauseEffect(hostedServers.restart(serverId)),
      ),
      creationAccess: handler(() => runCauseEffect(hostedServers.creationAccess())),
      requestCreationAccess: payloadHandler(
        (value) => required(parseServerCreationAccessRequest(value), "Invalid server creation request."),
        (input) => runCauseEffect(hostedServers.requestCreationAccess(input)),
      ),
      creationAdmin: handler(() => runCauseEffect(hostedServers.creationAdmin())),
      grantCreation: payloadHandler(
        (value) => required(parseServerCreationGrantInput(value), "Invalid server creation grant."),
        (input) => runCauseEffect(hostedServers.grantCreation(input)),
      ),
      revokeCreation: payloadHandler(
        (value) => required(isServerCreationUserId(value) ? value : null, "Invalid account."),
        (userId) => runCauseEffect(hostedServers.revokeCreation(userId)),
      ),
      decideCreationRequest: payloadHandler(
        (value) => required(parseServerCreationDecisionInput(value), "Invalid server creation decision."),
        (input) => runCauseEffect(hostedServers.decideCreationRequest(input)),
      ),
    },
  };
}

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}

function parseCreate(value: unknown): CreateHostedServerInput {
  const input = parseCreateHostedServerInput(value);
  if (!input) throw new Error("Invalid hosted server.");
  return input;
}

function parseDelete(value: unknown): DeleteHostedServerInput {
  const input = parseDeleteHostedServerInput(value);
  if (!input) throw new Error("Invalid hosted server deletion.");
  return input;
}
