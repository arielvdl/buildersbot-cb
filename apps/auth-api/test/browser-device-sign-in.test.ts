import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AuthServiceError } from "../src/server/auth-service";
import { type BrowserApiServices, handleBrowserApi } from "../src/server/browser-api";
import {
  type DeviceAuthorizationStart,
  DeviceBridgeError,
  type DevicePollResult,
  type DeviceSignInBridge,
} from "../src/server/device-bridge";
import type { AuthUser } from "../src/server/types";
import { webDeviceFlowCookie } from "../src/server/web-device-flow";

// The web app's Cultura Builder sign-in, through the browser API with a fake bridge: the flow is bound
// to the browser by an HttpOnly cookie, the page gets only the code and the Hub address, and the
// approval gives the session cookie, never a token in the answer.

const ORIGIN = "https://buildersbot.test";
const FLOW_ID = "flow-7f3a9c2e";
const SESSION_TOKEN = "session-token-0123456789abcdef";
const PREVIOUS_TOKEN = "previous-token-0123456789abcdef";
const USER: AuthUser = {
  id: "user-1",
  email: "person@example.com",
  name: "Person",
  avatarUrl: null,
  analyticsEnabled: null,
};
const STARTED: DeviceAuthorizationStart = {
  flowId: FLOW_ID,
  userCode: "ABCD-EFGH",
  verificationUri: "https://hub.culturabuilder.com/hub/builder-ai/device",
  verificationUriComplete: "https://hub.culturabuilder.com/hub/builder-ai/device?code=ABCD-EFGH",
  expiresIn: 900,
  interval: 5,
};

interface Calls {
  starts: number;
  polls: string[];
  limits: string[];
  signIns: Array<{ email: string; surface: string; client: { id: string; label: string } | null | undefined }>;
  endedSessions: string[];
}

function services(
  options: {
    start?: () => Promise<DeviceAuthorizationStart>;
    poll?: (flowId: string) => Promise<DevicePollResult>;
    bridge?: boolean;
    limited?: "start" | "poll";
  } = {},
) {
  const calls: Calls = { starts: 0, polls: [], limits: [], signIns: [], endedSessions: [] };
  const unused = () => Effect.die(new Error("The device sign-in does not use this service."));
  const bridge: DeviceSignInBridge = {
    url: "https://auth-buildersbot.culturabuilder.com",
    start: () => {
      calls.starts += 1;
      return options.start ? options.start() : Promise.resolve(STARTED);
    },
    poll: (flowId) => {
      calls.polls.push(flowId);
      return options.poll ? options.poll(flowId) : Promise.resolve({ status: "pending", interval: 5 });
    },
  };
  const value: BrowserApiServices = {
    auth: {
      enforceDeviceSignInRateLimit: (step, sourceIp) => {
        calls.limits.push(`${step}:${sourceIp}`);
        return options.limited === step
          ? Effect.fail(new AuthServiceError(429, "rate_limited", "Too many sign-in attempts. Try again later.", 60))
          : Effect.void;
      },
      signInWithDeviceAccount: (input) => {
        calls.signIns.push({ email: input.email, surface: input.surface, client: input.client });
        return Effect.succeed({ sessionToken: SESSION_TOKEN, user: USER });
      },
      authenticate: (token) => Effect.succeed(token === PREVIOUS_TOKEN ? { ...USER, id: "user-previous" } : null),
      enforceTeamInviteRateLimit: unused,
      updateAnalytics: unused,
      updateName: unused,
      updateAvatar: unused,
      listAccountSessions: unused,
      revokeAccountSession: unused,
    },
    remote: {
      listHosts: unused,
      removeOwnedHost: unused,
      startSession: unused,
      issueSessionTicket: unused,
      endSession: unused,
      endAccountSession: (userId) =>
        Effect.sync(() => {
          calls.endedSessions.push(userId);
        }),
      previewInvite: unused,
      acceptInvite: unused,
      listMembers: unused,
      listInvites: unused,
      createInvite: unused,
      revokeInvite: unused,
      changeMembership: unused,
      hostAsset: unused,
      emailableInvite: unused,
    },
    hostLogo: unused,
    hosting: () => {
      throw new Error("unused");
    },
    inviteEmailDelivery: () => null,
    attribution: () => {
      throw new Error("unused");
    },
    billing: () => null,
    avatarBucket: () => {
      throw new Error("unused");
    },
    hostedSites: () => {
      throw new Error("unused");
    },
    webPush: () => null,
    deviceBridge: () => (options.bridge === false ? null : bridge),
    sourceIp: () => "203.0.113.7",
    errorResponse: (error) => {
      if (!(error instanceof AuthServiceError))
        return Response.json({ error: { code: "internal_error" } }, { status: 500 });
      const response = Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
      if (error.retryAfterSeconds !== undefined) response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return response;
    },
  };
  return { services: value, calls };
}

/** A same-origin write from the web app, as `WebApp.tsx` sends it. */
function browserPost(path: string, cookies: string[] = [], body: unknown = {}): Request {
  return new Request(`${ORIGIN}/api/browser/${path}`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "X-OpenBot-Browser": "1",
      "X-OpenBot-Install": "install-1234abcd",
      "X-OpenBot-Install-Label": "iPhone Safari",
      ...(cookies.length > 0 ? { Cookie: cookies.join("; ") } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** The cookie pair that the start answer set, as the browser sends it back. */
function flowCookie(): string {
  const [pair = ""] = webDeviceFlowCookie({ flowId: FLOW_ID, maxAgeSeconds: 900 }).split(";");
  return pair;
}

function cookieNamed(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

/** The `{ error: { code, message } }` refusal of the account service. */
async function refusal(response: Response): Promise<{ code: string; message: string }> {
  const body = await response.json<{ error: { code: string; message: string } }>();
  return body.error;
}

async function errorCode(response: Response): Promise<string> {
  return (await refusal(response)).code;
}

describe("web app Cultura Builder sign-in", () => {
  it("starts a flow, binds it to this browser and gives the page only the code and the Hub address", async () => {
    const { services: api, calls } = services();
    const response = await handleBrowserApi(browserPost("device/start"), api);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      userCode: "ABCD-EFGH",
      verificationUri: STARTED.verificationUri,
      verificationUriComplete: STARTED.verificationUriComplete,
      expiresIn: 900,
      interval: 5,
    });
    expect(JSON.stringify(body)).not.toContain(FLOW_ID);
    const cookie = cookieNamed(response, "__Host-buildersbot-device") ?? "";
    expect(cookie).not.toContain(FLOW_ID);
    expect(cookie.split("; ").slice(1)).toEqual(["Path=/", "Secure", "HttpOnly", "SameSite=Strict", "Max-Age=900"]);
    expect(calls.limits).toEqual(["start:203.0.113.7"]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses a start from another site or without the browser header", async () => {
    const { services: api, calls } = services();
    const crossSite = new Request(`${ORIGIN}/api/browser/device/start`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json", "X-OpenBot-Browser": "1" },
      body: "{}",
    });
    const noHeader = new Request(`${ORIGIN}/api/browser/device/start`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    });
    for (const request of [crossSite, noHeader]) {
      const response = await handleBrowserApi(request, api);
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("browser_request_refused");
    }
    expect(calls.starts).toBe(0);
  });

  it("opens no address outside Cultura Builder", async () => {
    const offDomain = services({
      start: () => Promise.resolve({ ...STARTED, verificationUri: "https://culturabuilder.com.evil.example/device" }),
    });
    const refused = await handleBrowserApi(browserPost("device/start"), offDomain.services);
    expect(refused.status).toBe(502);
    expect(cookieNamed(refused, "__Host-buildersbot-device")).toBeUndefined();

    const plainHttp = services({
      start: () => Promise.resolve({ ...STARTED, verificationUriComplete: "http://hub.culturabuilder.com/device" }),
    });
    const started = await handleBrowserApi(browserPost("device/start"), plainHttp.services);
    expect(started.status).toBe(200);
    expect((await started.json<{ verificationUriComplete: string | null }>()).verificationUriComplete).toBeNull();
  });

  it("polls only the flow of this browser's cookie, never a flow ID that the page sends", async () => {
    const { services: api, calls } = services();
    const stranger = await handleBrowserApi(browserPost("device/poll", [], { flowId: FLOW_ID }), api);
    expect(stranger.status).toBe(410);
    expect(await errorCode(stranger)).toBe("expired_token");
    const twice = await handleBrowserApi(browserPost("device/poll", [flowCookie(), flowCookie()]), api);
    expect(twice.status).toBe(410);
    expect(calls.polls).toEqual([]);

    const pending = await handleBrowserApi(browserPost("device/poll", [flowCookie()]), api);
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "pending", interval: 5 });
    expect(calls.polls).toEqual([FLOW_ID]);
    expect(calls.limits).toEqual(["poll:203.0.113.7"]);
  });

  it("passes the Hub's slow_down on with its wait", async () => {
    const { services: api } = services({
      poll: () => Promise.resolve({ status: "rate_limited", retryAfterSeconds: 10 }),
    });
    const response = await handleBrowserApi(browserPost("device/poll", [flowCookie()]), api);
    expect(response.status).toBe(429);
    expect(await errorCode(response)).toBe("slow_down");
    expect(response.headers.get("Retry-After")).toBe("10");
    expect(cookieNamed(response, "__Host-buildersbot-device")).toBeUndefined();
  });

  it.each([
    ["denied", 403, "access_denied"],
    ["expired", 410, "expired_token"],
  ] as const)("ends the flow of this browser when the Hub says %s", async (status, httpStatus, code) => {
    const { services: api, calls } = services({ poll: () => Promise.resolve({ status }) });
    const response = await handleBrowserApi(browserPost("device/poll", [flowCookie()]), api);
    expect(response.status).toBe(httpStatus);
    expect(await errorCode(response)).toBe(code);
    expect(cookieNamed(response, "__Host-buildersbot-device")).toMatch(/Max-Age=0$/u);
    expect(calls.signIns).toEqual([]);
  });

  it("signs in with the session cookie after the approval and ends the earlier session", async () => {
    const { services: api, calls } = services({
      poll: () =>
        Promise.resolve({
          status: "authorized",
          user: { email: "person@example.com", name: "Person", avatarUrl: null },
        }),
    });
    const response = await handleBrowserApi(
      browserPost("device/poll", [flowCookie(), `__Host-openbot-web=${PREVIOUS_TOKEN}`]),
      api,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ user: USER });
    expect(text).not.toContain(SESSION_TOKEN);
    expect(cookieNamed(response, "__Host-openbot-web")).toBe(
      `__Host-openbot-web=${SESSION_TOKEN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000`,
    );
    expect(cookieNamed(response, "__Host-buildersbot-device")).toMatch(/Max-Age=0$/u);
    expect(calls.signIns).toEqual([
      {
        email: "person@example.com",
        surface: "web",
        client: { id: "install-1234abcd", label: "iPhone Safari" },
      },
    ]);
    expect(calls.endedSessions).toEqual(["user-previous"]);
  });

  it("checks the rate limit before it asks the bridge", async () => {
    const { services: api, calls } = services({ limited: "poll" });
    const response = await handleBrowserApi(browserPost("device/poll", [flowCookie()]), api);
    expect(response.status).toBe(429);
    expect(await errorCode(response)).toBe("rate_limited");
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(calls.polls).toEqual([]);
  });

  it("keeps the bridge failure detail out of the page", async () => {
    const { services: api } = services({
      start: () => Promise.reject(new DeviceBridgeError("The sign-in service refused to start (500): internal")),
    });
    const response = await handleBrowserApi(browserPost("device/start"), api);
    expect(response.status).toBe(502);
    const error = await refusal(response);
    expect(error.code).toBe("sign_in_service_unavailable");
    expect(error.message).not.toContain("internal");
  });

  it("answers 503 when no sign-in service is configured", async () => {
    const { services: api } = services({ bridge: false });
    const response = await handleBrowserApi(browserPost("device/start"), api);
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("device_sign_in_disabled");
  });

  it("forgets the flow on cancel", async () => {
    const { services: api, calls } = services();
    const response = await handleBrowserApi(browserPost("device/cancel", [flowCookie()]), api);
    expect(response.status).toBe(200);
    expect(cookieNamed(response, "__Host-buildersbot-device")).toMatch(/Max-Age=0$/u);
    expect(calls.polls).toEqual([]);
  });

  it("gives the email code no way in", async () => {
    const { services: api } = services();
    for (const path of ["email/start", "email/verify"]) {
      const response = await handleBrowserApi(browserPost(path, [], { email: "person@example.com" }), api);
      expect(response.status).toBe(410);
      expect(await errorCode(response)).toBe("email_sign_in_retired");
      expect(cookieNamed(response, "__Host-openbot-web")).toBeUndefined();
    }
  });
});
