// The bundled Builders CLI (`opencode acp`) of `server-model-policy-e2e.ts`. The same copy runs as the
// OpenCode provider and as the Cultura Builder provider, as the real one does.
//
// As the Cultura Builder provider, it lists the models that its spawn config declares under
// `cultura-builder`: that config is what the driver writes from the gateway catalog of the account,
// so the list shows which catalog reached the process. As the OpenCode provider, it lists the free
// tier of OpenCode and one paid OpenCode Go model, as OpenCode 2.2.5 does with no key.
// `--version` prints a version that no installed OpenCode has, so the runtime uses this copy.
import { logEntry, serveFakeAcpAgent } from "../acp-agent";

if (process.argv.includes("--version")) {
  process.stdout.write("99.0.0\n");
  process.exit(0);
}

interface ProviderEntry {
  options?: { apiKey?: string };
  models?: Record<string, { name?: string } | undefined>;
}
const config: { provider?: Record<string, ProviderEntry | undefined> } = process.env.OPENCODE_CONFIG_CONTENT
  ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
  : {};
const cultura = config.provider?.["cultura-builder"];

const OPENCODE_MODELS = [
  { modelId: "opencode/flint-40b-free", name: "OpenCode/Flint 40B Free" },
  { modelId: "opencode/glm-5.3-flash-free", name: "OpenCode/GLM-5.3-Flash Free" },
  { modelId: "opencode/big-pickle", name: "OpenCode/Big Pickle" },
  { modelId: "opencode-go/kimi-k2.6", name: "OpenCode Go/Kimi K2.6" },
];

const models = cultura
  ? Object.entries(cultura.models ?? {}).map(([id, model]) => ({
      modelId: `cultura-builder/${id}`,
      name: model?.name ?? id,
    }))
  : OPENCODE_MODELS;
logEntry({
  event: "spawn",
  role: cultura ? "cultura-builder" : "opencode",
  token: cultura?.options?.apiKey ?? null,
  models: models.map((model) => model.modelId),
});

const setup = (sessionId: string | undefined) => ({
  sessionId,
  models: { availableModels: models, currentModelId: models[0]?.modelId ?? null },
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
