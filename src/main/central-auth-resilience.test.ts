// @vitest-environment node

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CentralAuthManager } from "./central-auth-manager";

/**
 * What keeps people signed in when the account service misbehaves.
 *
 * A host that answers 5xx, HTML or nothing must not lock out a person who already has a session:
 * the app tries the fallback address, and when no address answers it opens with the account it
 * last saw and checks again in the background. Only a real 401 ends the session.
 */

const PRIMARY = "https://buildersbot.culturabuilder.com";
const FALLBACK = "https://auth-buildersbot.culturabuilder.com";
const USER = { id: "user-1", email: "pessoa@exemplo.com", name: "Pessoa", avatarUrl: null };

type Reply = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const html = (status: number) =>
  new Response("<!DOCTYPE html><html></html>", { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

const directories: string[] = [];

afterEach(async () => {
  while (directories.length) {
    const directory = directories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function setup(options: { reply: Reply; stored?: object | null; fallback?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), "central-auth-resilience-"));
  directories.push(directory);
  const storagePath = join(directory, "session.bin");
  if (options.stored) await writeFile(storagePath, Buffer.from(JSON.stringify(options.stored)).toString("base64"));
  const calls: string[] = [];
  const centralAuth = new CentralAuthManager({
    apiUrl: PRIMARY,
    ...(options.fallback === false ? {} : { fallbackApiUrl: FALLBACK }),
    storagePath,
    encrypt: (value) => Buffer.from(value, "utf8"),
    decrypt: (value) => value.toString("utf8"),
    startupRetryWindowMs: 60,
    startupRequestTimeoutMs: 40,
    startupRetryDelaysMs: [5],
    revalidateDelaysMs: [10],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${url.origin}${url.pathname}`);
      return options.reply(url, init);
    },
  });
  return { centralAuth, calls, storagePath };
}

const session = (extra: { user?: typeof USER } = {}) => ({
  version: 2,
  sessionToken: "sessao-opaca",
  teamHostTokens: {},
  ...extra,
});

async function waitFor(check: () => boolean, ms = 2_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("fallback address", () => {
  const start = (centralAuth: CentralAuthManager) => Effect.runPromise(centralAuth.startDeviceSignIn());
  const STARTED = {
    flowId: "11111111-1111-4111-8111-111111111111",
    userCode: "ABCD-EFGH",
    verificationUri: `${FALLBACK}/device`,
    verificationUriComplete: `${FALLBACK}/device?user_code=ABCD-EFGH`,
    expiresIn: 900,
    interval: 5,
  };

  it("retries on the fallback when the primary answers 5xx", async () => {
    const { centralAuth, calls } = await setup({
      reply: (url) => (url.origin === PRIMARY ? json(500, { error: "x" }) : json(200, STARTED)),
    });

    await expect(start(centralAuth)).resolves.toMatchObject({ flowId: STARTED.flowId });
    expect(calls).toEqual([`${PRIMARY}/v1/auth/device/start`, `${FALLBACK}/v1/auth/device/start`]);
  });

  it("retries on the fallback when the primary is taken over by a site that answers HTML", async () => {
    const { centralAuth, calls } = await setup({
      reply: (url) => (url.origin === PRIMARY ? html(404) : json(200, STARTED)),
    });

    await expect(start(centralAuth)).resolves.toMatchObject({ flowId: STARTED.flowId });
    expect(calls[1]).toBe(`${FALLBACK}/v1/auth/device/start`);
  });

  it("retries on the fallback when the primary cannot be reached", async () => {
    const { centralAuth } = await setup({
      reply: (url) => {
        if (url.origin === PRIMARY) throw new TypeError("fetch failed");
        return json(200, STARTED);
      },
    });

    await expect(start(centralAuth)).resolves.toMatchObject({ flowId: STARTED.flowId });
  });

  it("does not leave the primary for a real answer such as 401", async () => {
    const { centralAuth, calls } = await setup({
      reply: () => json(401, { error: { code: "unauthorized", message: "Sign in is required." } }),
    });

    await expect(start(centralAuth)).rejects.toBeDefined();
    expect(calls).toEqual([`${PRIMARY}/v1/auth/device/start`]);
  });

  it("keeps the primary's own answer when the fallback fails too", async () => {
    const { centralAuth } = await setup({
      reply: (url) => json(url.origin === PRIMARY ? 503 : 502, { error: { code: "down", message: "down" } }),
    });

    await expect(start(centralAuth)).rejects.toMatchObject({ cause: { status: 503 } });
  });

  it("asks the fallback first for a while after the primary failed", async () => {
    const { centralAuth, calls } = await setup({
      reply: (url) => (url.origin === PRIMARY ? json(500, { error: "x" }) : json(200, STARTED)),
    });

    await start(centralAuth);
    await start(centralAuth);

    expect(calls).toEqual([
      `${PRIMARY}/v1/auth/device/start`,
      `${FALLBACK}/v1/auth/device/start`,
      `${FALLBACK}/v1/auth/device/start`,
    ]);
  });

  it("behaves as before when no fallback is configured", async () => {
    const { centralAuth, calls } = await setup({ fallback: false, reply: () => json(500, { error: "x" }) });

    await expect(start(centralAuth)).rejects.toBeDefined();
    expect(calls).toEqual([`${PRIMARY}/v1/auth/device/start`]);
  });
});

describe("start with a stored session", () => {
  it("opens with the last known account when no address answers", async () => {
    const { centralAuth } = await setup({
      stored: session({ user: USER }),
      reply: () => json(503, { error: { code: "down", message: "down" } }),
    });

    await Effect.runPromise(centralAuth.initialize());

    expect(centralAuth.getState()).toEqual({ status: "signed_in", user: USER });
  });

  it("still shows the retry screen when no account was ever saved", async () => {
    const { centralAuth } = await setup({
      stored: session(),
      reply: () => json(503, { error: { code: "down", message: "down" } }),
    });

    await Effect.runPromise(centralAuth.initialize());

    expect(centralAuth.getState()).toMatchObject({ status: "error", issue: { code: "auth_api_unavailable" } });
  });

  it("signs out on a real 401 and removes the stored session", async () => {
    const { centralAuth, storagePath } = await setup({
      stored: session({ user: USER }),
      reply: () => json(401, { error: { code: "unauthorized", message: "Sign in is required." } }),
    });

    await Effect.runPromise(centralAuth.initialize());

    expect(centralAuth.getState()).toEqual({ status: "signed_out" });
    await expect(stat(storagePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saves the account it just read, so the next start can open without the service", async () => {
    const { centralAuth, storagePath } = await setup({
      stored: session(),
      reply: () => json(200, USER),
    });

    await Effect.runPromise(centralAuth.initialize());

    const stored = JSON.parse(Buffer.from(await readFile(storagePath, "utf8"), "base64").toString("utf8"));
    expect(stored.user).toEqual(USER);
    expect(stored.sessionToken).toBe("sessao-opaca");
  });

  it("checks again in the background and signs out when the session turns out to be revoked", async () => {
    let phase: "down" | "revoked" = "down";
    const { centralAuth, storagePath } = await setup({
      stored: session({ user: USER }),
      reply: () =>
        phase === "down"
          ? json(503, { error: { code: "down", message: "down" } })
          : json(401, { error: { code: "unauthorized", message: "Sign in is required." } }),
    });

    await Effect.runPromise(centralAuth.initialize());
    expect(centralAuth.getState().status).toBe("signed_in");
    phase = "revoked";

    await waitFor(() => centralAuth.getState().status === "signed_out");
    await expect(stat(storagePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks again in the background and takes the fresh account once the service is back", async () => {
    let back = false;
    const { centralAuth } = await setup({
      stored: session({ user: USER }),
      reply: () =>
        back ? json(200, { ...USER, name: "Novo" }) : json(503, { error: { code: "down", message: "down" } }),
    });

    await Effect.runPromise(centralAuth.initialize());
    expect(centralAuth.getState()).toEqual({ status: "signed_in", user: USER });
    back = true;

    await waitFor(() => {
      const state = centralAuth.getState();
      return state.status === "signed_in" && state.user.name === "Novo";
    });
  });
});
