// @vitest-environment node
// The `openbot-app` protocol serves the renderer bundle to the trusted origin. Failure modes: a path
// outside the renderer root is served; an HTML page is cached, so a new build keeps an old page; a
// hashed asset is not cached, so each reload reads and compiles the bundle again.
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

type ProtocolHandler = (request: Request) => Promise<Response>;
const handlers = new Map<string, ProtocolHandler>();

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "" },
  session: {
    defaultSession: {
      protocol: {
        handle(scheme: string, handler: ProtocolHandler) {
          handlers.set(scheme, handler);
        },
      },
    },
  },
}));

const { applicationCacheControl, configureApplicationProtocol } = await import("./session-configuration");

function applicationHandler(): ProtocolHandler {
  configureApplicationProtocol();
  const handler = handlers.get("openbot-app");
  if (!handler) throw new Error("The openbot-app protocol was not registered.");
  return handler;
}

describe("openbot-app protocol", () => {
  it("serves an HTML page with no-store", async () => {
    const response = await applicationHandler()(new Request("openbot-app://app/index.html"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("refuses a path that leaves the renderer root", async () => {
    // The URL parser keeps `%2f`, and the handler decodes it to `/../../package.json`: the
    // package.json of the repository, which exists. Without the root check the answer is 200.
    const response = await applicationHandler()(new Request("openbot-app://app/..%2f..%2fpackage.json"));

    expect(response.status).toBe(404);
  });

  it("refuses another host", async () => {
    const response = await applicationHandler()(new Request("openbot-app://other/index.html"));

    expect(response.status).toBe(404);
  });

  it("lets the renderer keep only the hashed files under assets", () => {
    expect(applicationCacheControl(join("assets", "index-Bx1Yz2.js"))).toBe("public, max-age=31536000, immutable");
    expect(applicationCacheControl(join("assets", "fonts", "inter-Q9.woff2"))).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(applicationCacheControl("assets")).toBe("no-store");
    expect(applicationCacheControl("index.html")).toBe("no-store");
    expect(applicationCacheControl("helper.html")).toBe("no-store");
    expect(applicationCacheControl("assets-index.js")).toBe("no-store");
  });
});
