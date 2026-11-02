// The Hub connections of this computer (docs/architecture/hub-connections.md): the Marketplace page,
// Usage › Connections, the payer that the person chooses, a request to the admins, and the Hub's
// consent page. Main reads the Hub with its own Cultura Builder session; no token, confirmation id or
// Hub URL reaches a window, and a window sends no URL: main opens the one fixed consent page. The
// payloads are parsed by the contract before the service sees them.

import { parseHubConnectionAccessRequestInput, parseHubConnectionPayerInput } from "@openbot/contracts/ipc";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export interface HubConnectionIpcDependencies {
  agents: Pick<
    AgentService,
    | "hubConnectionsView"
    | "hubConnectionsUsage"
    | "chooseHubConnectionPayer"
    | "requestHubConnectionAccess"
    | "openHubConsent"
  >;
}

export function hubConnectionIpcHandlers({
  agents,
}: HubConnectionIpcDependencies): Pick<IpcGroupHandlers, "hubConnections"> {
  return {
    hubConnections: {
      getView: handler(() => runCauseEffect(agents.hubConnectionsView(false))),
      refresh: handler(() => runCauseEffect(agents.hubConnectionsView(true))),
      getUsage: handler(() => runCauseEffect(agents.hubConnectionsUsage())),
      choosePayer: payloadHandler(parseHubConnectionPayerInput, (input) =>
        runCauseEffect(agents.chooseHubConnectionPayer(input)),
      ),
      requestAccess: payloadHandler(parseHubConnectionAccessRequestInput, (input) =>
        runCauseEffect(agents.requestHubConnectionAccess(input)),
      ),
      openConsent: handler(() => runCauseEffect(agents.openHubConsent())),
    },
  };
}
