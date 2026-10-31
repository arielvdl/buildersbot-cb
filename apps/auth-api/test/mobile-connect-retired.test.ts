import { describe, expect, it, vi } from "vitest";

// The router of the site does not load in Node. A route file only gives its options to it.
vi.mock("@tanstack/solid-router", () => ({
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}));

// The routes that made or redeemed a Mobile Connect code or link answer 410 before they read the
// request or touch the account store. The account services throw here, so a call to one fails the test.
vi.mock("../src/server/request-auth", () => {
  const unexpected = () => {
    throw new Error("The retired route used the account service.");
  };
  return {
    apiError: unexpected,
    bearerToken: unexpected,
    json: unexpected,
    remoteControlPlaneErrorResponse: unexpected,
    requestAuthService: unexpected,
    requestRemoteControlPlane: unexpected,
  };
});

const ROUTES = {
  ticket: "../src/routes/v1/mobile-auth/ticket",
  link: "../src/routes/v1/mobile-auth/link",
  redeem: "../src/routes/v1/mobile-auth/redeem",
} as const;

/** The methods that a route file serves. */
async function routeMethods(path: string): Promise<string[]> {
  const module = await import(path);
  return Object.keys(module.Route.options.server.handlers).sort();
}

async function post(path: string, url: string): Promise<Response> {
  const module = await import(path);
  const handler = module.Route.options.server.handlers.POST;
  if (typeof handler !== "function") throw new Error(`${path} has no POST handler.`);
  return handler({
    request: new Request(url, {
      method: "POST",
      headers: { Authorization: "Bearer desktop-session", "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: "x".repeat(43), deviceId: "phone", deviceName: "Phone", platform: "ios" }),
    }),
  });
}

describe("retired Mobile Connect routes", () => {
  it.each(Object.entries(ROUTES))("%s refuses to make or redeem a code with 410", async (name, path) => {
    const response = await post(path, `https://buildersbot.test/v1/mobile-auth/${name}`);
    expect(response.status).toBe(410);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.error.code).toBe("mobile_connect_retired");
    expect(body.error.message).not.toMatch(/openbot/iu);
  });

  it("keeps cancel and revoke, so a code or link that exists can still be removed", async () => {
    expect(await routeMethods(ROUTES.ticket)).toEqual(["DELETE", "POST"]);
    expect(await routeMethods(ROUTES.link)).toEqual(["DELETE", "POST"]);
    expect(await routeMethods(ROUTES.redeem)).toEqual(["POST"]);
  });
});
