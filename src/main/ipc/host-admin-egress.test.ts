// @vitest-environment node

// The egress proxy endpoints carry a proxy password from the renderer to main. The sender check must
// run first, every payload must be decoded before the service sees it, and no answer may carry the
// password back. See docs/architecture/egress-proxy.md.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEgressProxyView,
  EGRESS_DEFAULT_BYPASS,
  type EgressProxyUpdate,
  type EgressProxyView,
  LOCAL_SERVER_ID,
} from "@openbot/contracts/ipc";
import { describe, expect, it, vi } from "vitest";
import { MemoryReviewPreferenceStore } from "../memory-review-preference-store";
import { registerIpcGroup } from "./define-ipc-group";
import { hostAdminIpcHandlers } from "./host-admin-handlers";

const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, ...arguments_: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, ...arguments_: unknown[]) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));

const TRUSTED_EVENT = { senderFrame: { url: "openbot-app://app/index.html" } };
const UNTRUSTED_EVENT = { senderFrame: { url: "https://evil.example/index.html" } };

// Documentation addresses (RFC 5737) and an obviously fake credential.
const VALID_UPDATE: EgressProxyUpdate = {
  enabled: true,
  host: "203.0.113.10",
  port: 8080,
  username: "demo-user",
  password: "demo-pass",
  bypass: [...EGRESS_DEFAULT_BYPASS],
  expectedCountry: "BR",
  blockOtherCountry: true,
};

const VIEW: EgressProxyView = {
  enabled: true,
  host: "203.0.113.10",
  port: 8080,
  username: "demo-user",
  bypass: [...EGRESS_DEFAULT_BYPASS],
  expectedCountry: "BR",
  blockOtherCountry: true,
  passwordSaved: true,
  state: "active",
  reason: null,
  failedAt: null,
  lastCheck: null,
};

function unused(): never {
  throw new Error("Not used by the egress endpoints.");
}

function register() {
  const update = vi.fn(async (_input: EgressProxyUpdate) => VIEW);
  const setDefault = vi.fn(async (_input: EgressProxyUpdate | null) => null);
  const handlers = hostAdminIpcHandlers({
    host: { updateIdentity: unused },
    remoteServers: { list: () => [], supportsCapability: () => false, request: unused, refreshIdentity: unused },
    serverTimezone: { get: unused, set: unused },
    agentMemoryLimit: { get: unused, set: unused, subscribe: unused },
    memoryReview: new MemoryReviewPreferenceStore(join(mkdtempSync(join(tmpdir(), "egress-ipc-")), "review.json")),
    machineAlerts: { alerts: unused, setAlerts: unused, canBeResponsible: unused },
    promptCacheTtl: { get: unused, set: unused },
    agentAccess: { levels: unused, set: unused },
    egressProxy: { view: () => VIEW, update, test: async () => VIEW },
    egressDefault: { view: () => null, set: setDefault },
    localServerId: () => undefined,
    localAgentIds: () => [],
  });
  registerIpcGroup("hostAdmin", handlers.hostAdmin);
  // Async, so a refusal that the wrapper throws at once reads as a rejected call, as `ipcMain` gives it.
  const invoke = async (channel: string, event: unknown, payload: unknown) => {
    const listener = registrations.get(channel);
    if (!listener) throw new Error(`No handler for ${channel}.`);
    return listener(event, payload);
  };
  return { update, setDefault, invoke };
}

const scoped = (payload: unknown) => ({ serverId: LOCAL_SERVER_ID, payload });

describe("egress proxy IPC", () => {
  it("refuses a sender that is not the app before it reads the payload", async () => {
    const { update, invoke } = register();

    await expect(invoke("host-admin:set-egress-proxy", UNTRUSTED_EVENT, scoped(VALID_UPDATE))).rejects.toThrow();
    await expect(invoke("host-admin:get-egress-proxy", UNTRUSTED_EVENT, scoped(null))).rejects.toThrow();
    await expect(invoke("host-admin:set-egress-default", UNTRUSTED_EVENT, VALID_UPDATE)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a malformed setting and never calls the service with it", async () => {
    const { update, invoke } = register();
    const malformed: unknown[] = [
      null,
      "203.0.113.10:8080:demo-user:demo-pass",
      { ...VALID_UPDATE, port: 70_000 },
      { ...VALID_UPDATE, port: "8080" },
      { ...VALID_UPDATE, host: "proxy example.test" },
      { ...VALID_UPDATE, host: "http://203.0.113.10" },
      { ...VALID_UPDATE, username: "demo:user" },
      { ...VALID_UPDATE, password: "demo\r\nInjected: header" },
      { ...VALID_UPDATE, password: "x".repeat(257) },
      { ...VALID_UPDATE, bypass: ["*.example.test", "not a rule"] },
      { ...VALID_UPDATE, bypass: Array.from({ length: 65 }, (_, index) => `host${index}.example.test`) },
      { ...VALID_UPDATE, expectedCountry: "Brazil" },
      { ...VALID_UPDATE, enabled: "yes" },
    ];

    for (const payload of malformed) {
      await expect(invoke("host-admin:set-egress-proxy", TRUSTED_EVENT, scoped(payload))).rejects.toThrow();
      await expect(invoke("host-admin:set-egress-default", TRUSTED_EVENT, payload ?? "")).rejects.toThrow();
    }
    expect(update).not.toHaveBeenCalled();
  });

  it("passes a valid setting on with its password, and null removes the default", async () => {
    const { update, setDefault, invoke } = register();

    await expect(invoke("host-admin:set-egress-proxy", TRUSTED_EVENT, scoped(VALID_UPDATE))).resolves.toEqual(VIEW);
    await invoke("host-admin:set-egress-default", TRUSTED_EVENT, null);

    expect(update).toHaveBeenCalledWith(VALID_UPDATE);
    expect(setDefault).toHaveBeenCalledWith(null);
  });

  it("keeps a password out of the view that the preload decodes, also when a host sends one", () => {
    const decoded = decodeEgressProxyView({ ...VIEW, password: "demo-pass", encryptedPassword: "c2VjcmV0" });

    expect(JSON.stringify(decoded)).not.toContain("demo-pass");
    expect(decoded).not.toHaveProperty("password");
    expect(decoded).not.toHaveProperty("encryptedPassword");
  });
});
