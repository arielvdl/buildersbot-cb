// @vitest-environment node
// What the gateway hands to the providers for Playwright when the browser broker serves it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { createBuildersBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerStore } from "../mcp-server-store";
import { BuildersBotDatabase } from "../openbot-database";
import { NO_PROVIDER_CREDENTIALS } from "../provider-drivers";
import { McpGateway } from "./mcp-gateway";
import { BROWSER_BROKER_MCP_SERVER_ID, type BrowserBrokerAddress } from "./playwright-browser-access";

const roots: string[] = [];
const databases: BuildersBotDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// A new row has no id: the store makes one.
const playwrightRow: McpServerConfig = {
  id: "",
  name: "playwright",
  transport: "stdio",
  enabled: true,
  command: "npx",
  args: ["-y", "@playwright/mcp@0.0.83"],
  env: [],
  envPassthrough: [],
  workingDirectory: "",
  url: "",
  headers: [],
};

async function gatewayWith(broker: { current: BrowserBrokerAddress | null }, browserInApp = false) {
  const root = await mkdtemp(join(tmpdir(), "mcp-gateway-broker-"));
  roots.push(root);
  const database = new BuildersBotDatabase(root);
  databases.push(database);
  await Effect.runPromise(database.initialize());
  const servers = new McpServerStore(database);
  servers.save(playwrightRow);
  const gateway = new McpGateway({
    servers,
    credentials: NO_PROVIDER_CREDENTIALS,
    computerUseMcpServer: () => null,
    browserInApp: () => browserInApp,
    browserBroker: () => broker.current,
    logger: createBuildersBotLogger("mcp-gateway-test"),
    hooks: { emitError() {}, refreshAllAgentRuntimes: () => Effect.void },
  });
  return gateway;
}

const address: BrowserBrokerAddress = { url: "http://127.0.0.1:5555/mcp", bearer: "broker-bearer-value-0123456789" };

describe("Playwright through the browser broker", () => {
  it("is handed to the providers as one http server that all agents share", async () => {
    const gateway = await gatewayWith({ current: address });
    const [handed] = gateway.enabled();
    expect(handed).toMatchObject({
      id: BROWSER_BROKER_MCP_SERVER_ID,
      name: "playwright",
      transport: "http",
      url: address.url,
    });
    expect(JSON.stringify(gateway.enabled())).not.toContain(address.bearer);
  });

  it("adds the bearer at the hand-off, and keeps it out of any text the app shows", async () => {
    const gateway = await gatewayWith({ current: address });
    const [handed] = gateway.enabled();
    if (!handed) throw new Error("nothing handed");
    const endpoint = await Effect.runPromise(gateway.endpoint(handed));
    expect(endpoint).toEqual({ url: address.url, authorization: address.bearer, proxied: false });
    expect(gateway.redact(`failed with ${address.bearer} in it`)).not.toContain(address.bearer);
  });

  it("refuses the hand-off, in words, when the broker has no address", async () => {
    const broker: { current: BrowserBrokerAddress | null } = { current: address };
    const gateway = await gatewayWith(broker);
    const [handed] = gateway.enabled();
    if (!handed) throw new Error("nothing handed");
    broker.current = null;
    const endpoint = await Effect.runPromise(gateway.endpoint(handed));
    expect("error" in endpoint ? endpoint.error : "").toContain("shared browser connection");
  });

  it("falls back to the Playwright of the saved row when the broker has no address yet", async () => {
    const gateway = await gatewayWith({ current: null });
    const [handed] = gateway.enabled();
    expect(handed?.transport).toBe("stdio");
    expect(handed?.args).toContain("--extension");
  });

  it("hands no Playwright at all when the Builders Bot browser is the way in", async () => {
    const gateway = await gatewayWith({ current: address }, true);
    expect(gateway.enabled()).toEqual([]);
  });

  it("changes the fingerprint of a resumed Codex session when the address changes", async () => {
    const broker: { current: BrowserBrokerAddress | null } = { current: address };
    const gateway = await gatewayWith(broker);
    const first = await Effect.runPromise(gateway.proxyFingerprint(gateway.enabled()));
    broker.current = { ...address, url: "http://127.0.0.1:6666/mcp" };
    const second = await Effect.runPromise(gateway.proxyFingerprint(gateway.enabled()));
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(first).not.toContain(address.bearer);
  });

  it("keeps a computer with no broker row with no fingerprint, as before", async () => {
    const gateway = await gatewayWith({ current: null });
    expect(await Effect.runPromise(gateway.proxyFingerprint(gateway.enabled()))).toBeNull();
  });
});
