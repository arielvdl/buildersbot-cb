// The `opencode acp` of `hub-connections-safety-e2e.ts`. At spawn it logs the names of the MCP layer
// that Builders Bot sends on `OPENCODE_CONFIG_CONTENT`, with each entry's `enabled` and `type`, as
// `opencode debug config` would read that layer. It never logs a value of an entry.
import { logEntry, serveFakeAcpAgent } from "../acp-agent";

interface McpEntry {
  type?: string;
  enabled?: boolean;
}
const layer: { mcp?: Record<string, McpEntry | undefined> } = process.env.OPENCODE_CONFIG_CONTENT
  ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
  : {};
const entries = Object.entries(layer.mcp ?? {});
logEntry({
  event: "spawn",
  provider: process.env.FAKE_PROVIDER ?? "opencode",
  off: entries.filter(([, entry]) => entry?.enabled === false && entry.type === "local").map(([name]) => name),
  on: entries.filter(([, entry]) => entry?.enabled !== false).map(([name]) => name),
});

const MODEL = "opencode/test-model";
let count = 0;
serveFakeAcpAgent({
  initialize: (request, peer) =>
    peer.reply(request, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }),
  "session/new": (request, peer) => {
    count += 1;
    peer.reply(request, {
      sessionId: `s-${process.pid}-${count}`,
      models: { availableModels: [{ modelId: MODEL, name: "Test model" }], currentModelId: MODEL },
    });
  },
});
