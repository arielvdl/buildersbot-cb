import type { ServerSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { providerConnectRoute } from "../provider-updates/provider-connect-route";
import { serverCodeRouteProviders } from "./server-capabilities";

/** A joined server whose host advertises `capabilities`. Only what the routes read is filled in. */
function remoteServer(capabilities: readonly string[]): ServerSummary {
  return {
    id: "server-1",
    name: "CB marketing",
    kind: "remote",
    state: "online",
    role: "owner",
    active: true,
    compatibility: { capabilities },
  } as unknown as ServerSummary;
}

describe("Cultura Builder sign-in on a joined server", () => {
  it("is offered by the code route when the host serves providers-v8", () => {
    const server = remoteServer(["providers-v4", "providers-v8"]);
    expect(serverCodeRouteProviders(server)).toContain("cultura-builder");
    expect(providerConnectRoute("cultura-builder", { kind: "app-server", server }).connect).toBe("code");
    expect(providerConnectRoute("cultura-builder", { kind: "web-server", server }).connect).toBe("code");
  });

  it("is not offered by a host that cannot sign it in", () => {
    const server = remoteServer(["providers-v4"]);
    expect(serverCodeRouteProviders(server)).not.toContain("cultura-builder");
    expect(providerConnectRoute("cultura-builder", { kind: "app-server", server }).connect).toBeNull();
  });

  it("leaves the providers that the older routes sign in unchanged", () => {
    const server = remoteServer(["providers-v4", "providers-v8"]);
    expect(serverCodeRouteProviders(server)).toEqual(expect.arrayContaining(["codex", "grok", "cursor", "cline"]));
  });
});
