// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CentralAuthManager } from "./central-auth-manager";

/**
 * The device grant, as the app talks to the Cultura Builder account service.
 *
 * The four poll endings are the contract: `202` keeps the dialog waiting with the interval the
 * service sent, `200` stores the session exactly like the e-mail code does, `403` is a refusal and
 * `410` is an expired flow. The fetch is injected, so no test opens a socket.
 */

/** One queued answer per call, with the requests kept for assertions. */
function service(replies: Array<{ status?: number; body?: unknown; empty?: boolean }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    const status = reply.status ?? 200;
    if (reply.empty || status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(reply.body ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetcher, calls };
}

const START = {
  flowId: "11111111-1111-4111-8111-111111111111",
  userCode: "ABCD-EFGH",
  verificationUri: "https://auth-buildersbot.culturabuilder.com/device",
  verificationUriComplete: "https://auth-buildersbot.culturabuilder.com/device?user_code=ABCD-EFGH",
  expiresIn: 900,
  interval: 5,
};

const USER = { id: "user-1", email: "pessoa@exemplo.com", name: "Pessoa", avatarUrl: null };

const SESSION = {
  status: "authorized",
  sessionToken: "sessao-opaca",
  expiresAt: "2026-11-28T00:00:00.000Z",
  user: USER,
};

const directories: string[] = [];

async function manager(replies: Array<{ status?: number; body?: unknown; empty?: boolean }>) {
  const directory = await mkdtemp(join(tmpdir(), "central-auth-device-"));
  directories.push(directory);
  const { fetcher, calls } = service(replies);
  const centralAuth = new CentralAuthManager({
    apiUrl: "https://auth-buildersbot.culturabuilder.com",
    storagePath: join(directory, "session.bin"),
    encrypt: (value) => Buffer.from(value, "utf8"),
    decrypt: (value) => value.toString("utf8"),
    fetch: fetcher,
  });
  return { centralAuth, calls, storagePath: join(directory, "session.bin") };
}

afterEach(async () => {
  while (directories.length) {
    const directory = directories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe("CentralAuthManager device grant", () => {
  it("starts a flow and turns the service seconds into a deadline and an interval", async () => {
    const { centralAuth, calls } = await manager([{ body: START }]);
    const before = Date.now();

    const code = await Effect.runPromise(centralAuth.startDeviceSignIn());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://auth-buildersbot.culturabuilder.com/v1/auth/device/start");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ clientName: "Builders Bot" });
    expect(code).toMatchObject({
      flowId: START.flowId,
      userCode: "ABCD-EFGH",
      verificationUrl: START.verificationUri,
      verificationUrlComplete: START.verificationUriComplete,
      intervalMs: 5_000,
    });
    expect(code.expiresAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(code.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
  });

  it("reads 202 as pending and keeps the interval the service sent", async () => {
    const { centralAuth, calls } = await manager([{ status: 202, body: { status: "pending", interval: 7 } }]);

    const poll = await Effect.runPromise(centralAuth.pollDeviceSignIn(START.flowId));

    expect(poll).toEqual({ status: "pending", intervalMs: 7_000 });
    expect(calls[0]?.url).toBe("https://auth-buildersbot.culturabuilder.com/v1/auth/device/poll");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ flowId: START.flowId });
    expect(centralAuth.getState()).toEqual({ status: "loading" });
  });

  it("falls back to five seconds when the pending answer carries no interval", async () => {
    const { centralAuth } = await manager([{ status: 202, body: { status: "pending" } }]);

    expect(await Effect.runPromise(centralAuth.pollDeviceSignIn(START.flowId))).toEqual({
      status: "pending",
      intervalMs: 5_000,
    });
  });

  it("stores the session on 200 and reports the account as signed in", async () => {
    const { centralAuth, storagePath } = await manager([{ body: SESSION }]);

    const poll = await Effect.runPromise(centralAuth.pollDeviceSignIn(START.flowId));

    expect(poll).toEqual({ status: "authorized" });
    expect(centralAuth.getState()).toEqual({
      status: "signed_in",
      user: { id: "user-1", email: "pessoa@exemplo.com", name: "Pessoa", avatarUrl: null },
    });
    // The file is the encrypted payload in base64; the test cipher is identity.
    const stored = JSON.parse(Buffer.from(await readFile(storagePath, "utf8"), "base64").toString("utf8"));
    expect(stored).toMatchObject({ version: 2, sessionToken: "sessao-opaca" });
  });

  it("reads 403 as refused and stores nothing", async () => {
    const { centralAuth, storagePath } = await manager([{ status: 403, body: { error: "access_denied" } }]);

    const poll = await Effect.runPromise(centralAuth.pollDeviceSignIn(START.flowId));

    expect(poll).toEqual({ status: "denied" });
    expect(centralAuth.getState()).toEqual({ status: "loading" });
    await expect(readFile(storagePath, "utf8")).rejects.toThrow();
  });

  it("reads 410 as expired and stores nothing", async () => {
    const { centralAuth } = await manager([{ status: 410, body: { error: "expired" } }]);

    expect(await Effect.runPromise(centralAuth.pollDeviceSignIn(START.flowId))).toEqual({ status: "expired" });
    expect(centralAuth.getState()).toEqual({ status: "loading" });
  });

  it("reads 429 as a pause with the seconds it must wait", async () => {
    const { centralAuth } = await manager([
      { status: 429, body: { error: "rate_limited", message: "slow down", retryAfterSeconds: 12 } },
    ]);

    const poll = await Effect.runPromise(centralAuth.pollDeviceSignIn(START.flowId));

    expect(poll).toEqual({ status: "rate_limited", retryAfterSeconds: 12 });
    expect(centralAuth.getState()).toEqual({ status: "loading" });
  });

  it("takes the wait from the Retry-After header when the body has none", async () => {
    const directory = await mkdtemp(join(tmpdir(), "central-auth-device-"));
    directories.push(directory);
    const fetcher = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "45" },
      });
    const centralAuth = new CentralAuthManager({
      apiUrl: "https://auth-buildersbot.culturabuilder.com",
      storagePath: join(directory, "session.bin"),
      encrypt: (value) => Buffer.from(value, "utf8"),
      decrypt: (value) => value.toString("utf8"),
      fetch: fetcher,
    });

    expect(await Effect.runPromise(centralAuth.pollDeviceSignIn(START.flowId))).toEqual({
      status: "rate_limited",
      retryAfterSeconds: 45,
    });
  });

  it("keeps the unknown flow and a broken service as errors, not as an ending", async () => {
    const { centralAuth } = await manager([{ status: 404, body: { error: "flow_not_found" } }]);

    await expect(Effect.runPromise(centralAuth.pollDeviceSignIn(START.flowId))).rejects.toThrow();
    expect(centralAuth.getState()).toEqual({ status: "loading" });
  });

  it("signs out through the logout endpoint", async () => {
    const { centralAuth, calls } = await manager([{ body: SESSION }, { status: 204, empty: true }]);
    await Effect.runPromise(centralAuth.pollDeviceSignIn(START.flowId));

    const state = await Effect.runPromise(centralAuth.logout());

    expect(state).toEqual({ status: "signed_out" });
    expect(calls[1]?.url).toBe("https://auth-buildersbot.culturabuilder.com/v1/auth/logout");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(new Headers(calls[1]?.init?.headers).get("Authorization")).toBe("Bearer sessao-opaca");
  });
});
