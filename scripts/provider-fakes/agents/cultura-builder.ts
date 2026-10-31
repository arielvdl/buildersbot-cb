// The bundled Builders CLI (`opencode acp`) of `cultura-builder-start-e2e.ts`, as the Cultura Builder
// driver starts it. It writes the access token that its spawn config carries to the log, and answers
// with one gateway model. `--version` prints a version that no installed OpenCode has, so the provider
// runtime uses this copy and not the OpenCode of the computer.
import { logEntry, serveFakeAcpAgent } from "../acp-agent";

if (process.argv.includes("--version")) {
  process.stdout.write("99.0.0\n");
  process.exit(0);
}

const MODEL = "cultura-builder/builder-auto";

interface ProviderOptions {
  options?: { apiKey?: string; baseURL?: string };
}
const config: { provider?: Record<string, ProviderOptions | undefined> } = process.env.OPENCODE_CONFIG_CONTENT
  ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
  : {};
logEntry({ event: "spawn", token: config.provider?.["cultura-builder"]?.options?.apiKey ?? null });

const setup = (sessionId: string | undefined) => ({
  sessionId,
  models: { availableModels: [{ modelId: MODEL, name: "Cultura Builder" }], currentModelId: MODEL },
});

let count = 0;
serveFakeAcpAgent({
  initialize: (request, peer) =>
    peer.reply(request, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }),
  "session/new": (request, peer) => {
    count += 1;
    peer.reply(request, setup(`s-${process.pid}-${count}`));
  },
  "session/load": (request, peer) => peer.reply(request, setup(request.params.sessionId)),
});
