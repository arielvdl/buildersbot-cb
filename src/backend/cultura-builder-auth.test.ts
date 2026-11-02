// @vitest-environment node

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { providerFailureStatus } from "./agent/provider-status";
import {
  CULTURA_BUILDER_CLIENT_ID,
  ensureCulturaBuilderToken,
  pollCulturaBuilderToken,
  readCulturaBuilderAccess,
  readCulturaBuilderSession,
  refreshCulturaBuilderSession,
  requireCulturaBuilderSession,
  serializeCulturaBuilderSession,
  sessionIsFresh,
  startCulturaBuilderSignIn,
} from "./cultura-builder-auth";
import { ProviderSignInError } from "./provider-client-effects";

/** A fetch for a test: the answer comes from `answer`, and nothing goes over the network. */
function fakeFetch(answer: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(answer, { preconnect: () => undefined });
}

/** A fake Hub: each call answers with the next queued reply, and the requests are kept for assertions. */
function hub(replies: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher = fakeFetch(async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return { fetcher, calls };
}

const DEVICE = {
  device_code: "device-1",
  user_code: "ABCD-EFGH",
  verification_uri: "https://hub.culturabuilder.com/hub/builder-ai/device",
  verification_uri_complete: "https://hub.culturabuilder.com/hub/builder-ai/device?code=ABCD-EFGH",
  expires_in: 900,
  interval: 5,
};

describe("readCulturaBuilderSession", () => {
  it("reads a stored session and a legacy plain key", () => {
    const stored = serializeCulturaBuilderSession({ access: "cbmcp_1", refresh: "r", expires: 10, empresa: "ariel" });
    expect(readCulturaBuilderSession(stored)).toEqual({
      access: "cbmcp_1",
      refresh: "r",
      expires: 10,
      empresa: "ariel",
    });
    expect(readCulturaBuilderSession("cbk_legacy")).toEqual({
      access: "cbk_legacy",
      refresh: "",
      expires: 0,
      empresa: null,
    });
  });

  it("refuses an empty or malformed value", () => {
    expect(readCulturaBuilderSession(null)).toBeNull();
    expect(readCulturaBuilderSession("")).toBeNull();
    expect(readCulturaBuilderSession("{")).toBeNull();
    expect(readCulturaBuilderSession('{"refresh":"r"}')).toBeNull();
  });
});

describe("sessionIsFresh", () => {
  it("keeps a minute of margin before the expiry", () => {
    const now = 1_000_000;
    expect(sessionIsFresh({ access: "a", refresh: "", expires: now + 61_000, empresa: null }, now)).toBe(true);
    expect(sessionIsFresh({ access: "a", refresh: "", expires: now + 59_000, empresa: null }, now)).toBe(false);
  });
});

describe("startCulturaBuilderSignIn", () => {
  it("asks for a code for the fixed client, with no registration", async () => {
    const { fetcher, calls } = hub([{ body: DEVICE }]);
    const flow = await Effect.runPromise(startCulturaBuilderSignIn(fetcher));
    expect(flow.userCode).toBe("ABCD-EFGH");
    expect(flow.verificationUrlComplete).toContain("ABCD-EFGH");
    expect(flow.clientId).toBe(CULTURA_BUILDER_CLIENT_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/mcp-oauth/device");
    expect(String(calls[0]?.init?.body)).toContain("scope=builder-ai");
    expect(String(calls[0]?.init?.body)).toContain(`client_id=${CULTURA_BUILDER_CLIENT_ID}`);
  });

  it("fails when the Hub answers without a code", async () => {
    const { fetcher } = hub([{ status: 400, body: { error: "invalid" } }]);
    const result = await Effect.runPromise(Effect.result(startCulturaBuilderSignIn(fetcher)));
    expect(result._tag).toBe("Failure");
  });
});

describe("pollCulturaBuilderToken", () => {
  const flow = { clientId: "client-1", deviceCode: "device-1" };

  it("treats pending and slow_down as part of the flow", async () => {
    const { fetcher } = hub([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
    ]);
    expect((await Effect.runPromise(pollCulturaBuilderToken(flow, fetcher))).status).toBe("pending");
    expect((await Effect.runPromise(pollCulturaBuilderToken(flow, fetcher))).status).toBe("slow_down");
  });

  it("keeps polling through a dropped network", async () => {
    const fetcher = fakeFetch(async () => {
      throw new Error("offline");
    });
    expect((await Effect.runPromise(pollCulturaBuilderToken(flow, fetcher))).status).toBe("pending");
  });

  it("returns the session the Hub grants", async () => {
    const { fetcher } = hub([{ body: { access_token: "cbmcp_1", refresh_token: "r", expires_in: 900 } }]);
    const outcome = await Effect.runPromise(pollCulturaBuilderToken(flow, fetcher));
    expect(outcome.status).toBe("ready");
    expect(outcome.status === "ready" ? outcome.session.access : null).toBe("cbmcp_1");
  });

  it("stops on a refused or expired grant", async () => {
    const { fetcher } = hub([
      { status: 400, body: { error: "access_denied" } },
      { status: 400, body: { error: "expired_token" } },
    ]);
    expect((await Effect.runPromise(pollCulturaBuilderToken(flow, fetcher))).status).toBe("stop");
    expect((await Effect.runPromise(pollCulturaBuilderToken(flow, fetcher))).status).toBe("stop");
  });

  it("keeps polling through an error code this flow does not know, instead of giving up on it", async () => {
    const { fetcher } = hub([{ status: 500, body: { error: "internal_error" } }]);
    expect((await Effect.runPromise(pollCulturaBuilderToken(flow, fetcher))).status).toBe("pending");
  });

  it("keeps polling through a 200 with no token, a malformed answer rather than a refusal", async () => {
    const { fetcher } = hub([{ body: { ok: true } }]);
    expect((await Effect.runPromise(pollCulturaBuilderToken(flow, fetcher))).status).toBe("pending");
  });
});

describe("readCulturaBuilderAccess", () => {
  it("reads the account's answer", async () => {
    const { fetcher, calls } = hub([{ body: { active: true, empresa: "ariel" } }]);
    const access = await Effect.runPromise(readCulturaBuilderAccess("cbmcp_1", fetcher));
    expect(access).toEqual({ active: true, empresa: "ariel" });
    expect(calls[0]?.url).toContain("/api/builder-ai/gateway/v1/session");
  });

  it("reads a refusal as the sign-in it is", async () => {
    const { fetcher } = hub([{ status: 401, body: {} }]);
    const result = await Effect.runPromise(Effect.result(readCulturaBuilderAccess("expired", fetcher)));
    expect(result._tag).toBe("Failure");
    expect(String(result._tag === "Failure" ? result.failure.cause : "")).toContain("login required");
  });
});

describe("refreshCulturaBuilderSession", () => {
  it("keeps the company and the old refresh token when none comes back", async () => {
    const { fetcher } = hub([{ body: { access_token: "cbmcp_2", expires_in: 900 } }]);
    const refreshed = await Effect.runPromise(
      refreshCulturaBuilderSession({ access: "cbmcp_1", refresh: "r", expires: 0, empresa: "ariel" }, fetcher),
    );
    expect(refreshed.access).toBe("cbmcp_2");
    expect(refreshed.refresh).toBe("r");
    expect(refreshed.empresa).toBe("ariel");
  });
});

describe("requireCulturaBuilderSession", () => {
  // The report: a host with no Cultura Builder sign-in showed "Unavailable" and "Cultura Builder
  // login required." because the missing session was a plain error, which reads as a broken provider.
  it("reads a missing session as a sign-in to do, so the row says Not connected", async () => {
    const result = await Effect.runPromise(Effect.result(requireCulturaBuilderSession(null)));
    expect(result._tag).toBe("Failure");
    const failure = result._tag === "Failure" ? result.failure : null;
    expect(failure).toBeInstanceOf(ProviderSignInError);
    expect(providerFailureStatus("cultura-builder", failure, "1.18.27")).toMatchObject({
      state: "sign-in-required",
      message: "Cultura Builder login required.",
    });
  });

  it("gives the stored session", async () => {
    const stored = serializeCulturaBuilderSession({ access: "cbmcp_1", refresh: "r", expires: 0, empresa: null });
    const session = await Effect.runPromise(requireCulturaBuilderSession(stored));
    expect(session.access).toBe("cbmcp_1");
  });
});

describe("ensureCulturaBuilderToken", () => {
  it("uses a fresh token without a request", async () => {
    const { fetcher, calls } = hub([]);
    const saved: string[] = [];
    const token = await Effect.runPromise(
      ensureCulturaBuilderToken(
        serializeCulturaBuilderSession({ access: "fresh", refresh: "r", expires: Date.now() + 600_000, empresa: null }),
        (value) => Effect.sync(() => void saved.push(value)),
        fetcher,
      ),
    );
    expect(token).toBe("fresh");
    expect(calls).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it("refreshes and saves a token that is about to end", async () => {
    const { fetcher } = hub([{ body: { access_token: "new", expires_in: 900 } }]);
    const saved: string[] = [];
    const token = await Effect.runPromise(
      ensureCulturaBuilderToken(
        serializeCulturaBuilderSession({ access: "old", refresh: "r", expires: 0, empresa: null }),
        (value) => Effect.sync(() => void saved.push(value)),
        fetcher,
      ),
    );
    expect(token).toBe("new");
    expect(saved).toHaveLength(1);
  });

  it("asks for a sign-in when nothing is stored", async () => {
    const result = await Effect.runPromise(Effect.result(ensureCulturaBuilderToken(null, () => Effect.void, fetch)));
    expect(result._tag).toBe("Failure");
  });
});
