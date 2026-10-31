import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fetchLatestLinuxRelease, HostReleaseService, type ReleaseRequest } from "./host-release-service";
import { HostedUpdateAdapter } from "./hosted-update-adapter";
import type { ReleaseFeedDecision } from "./update-feed-policy";

/** A fetch that records each address. With no body, a request fails the test. */
function recordingFetch(body?: string) {
  const urls: string[] = [];
  const request: ReleaseRequest = async (url) => {
    urls.push(url);
    if (body === undefined) throw new Error("A request was sent.");
    return new Response(body);
  };
  return { request, urls };
}

const signal = new AbortController().signal;
// A feed that a later version can allow. The default policy allows none.
const TEST_FEED: ReleaseFeedDecision = { allowed: true, baseUrl: "https://updates.example.test/feeds" };

describe("fetchLatestLinuxRelease", () => {
  it("sends no request while no release feed is allowed", async () => {
    const { request, urls } = recordingFetch();

    await expect(fetchLatestLinuxRelease("arm64", request, signal)).rejects.toThrow(
      "No release feed is available in this version",
    );
    expect(urls).toEqual([]);
  });

  it("asks the allowed feed for the manifest of the architecture", async () => {
    const manifest = ["version: 0.54.0", "files:", "  - url: Builders Bot-0.54.0-arm64.AppImage"].join("\n");
    const { request, urls } = recordingFetch(manifest);

    await expect(fetchLatestLinuxRelease("arm64", request, signal, TEST_FEED)).resolves.toBe("0.54.0");
    expect(urls).toEqual(["https://updates.example.test/feeds/latest-linux-arm64.yml"]);
  });

  it("refuses a release for another architecture", async () => {
    const manifest = ["version: 0.54.0", "files:", "  - url: Builders Bot-0.54.0-x86_64.AppImage"].join("\n");

    await expect(fetchLatestLinuxRelease("arm64", recordingFetch(manifest).request, signal, TEST_FEED)).rejects.toThrow(
      "No compatible release",
    );
  });
});

describe("release checks with no allowed feed", () => {
  it("the Servers panel reports that release checks are not available, with no request", async () => {
    const { request, urls } = recordingFetch();
    const release = new HostReleaseService({
      currentVersion: "0.56.0",
      packaged: true,
      platform: "linux",
      arch: "x64",
      environment: { OPENBOT_HOSTED_SERVER: "1" },
      installationMode: null,
      updateStatus: () => ({ phase: "unsupported" }),
      fetch: request,
    });

    const status = await Effect.runPromise(release.check());

    expect(status.phase).toBe("unavailable");
    expect(status.latestVersion).toBeNull();
    expect(urls).toEqual([]);
  });

  it("the Servers panel shows the manual path for each kind of installation", () => {
    const unsupported = { phase: "unsupported" } as const;
    const installations = [
      { platform: "linux", environment: { OPENBOT_HOSTED_SERVER: "1" }, mode: null, status: unsupported },
      { platform: "linux", environment: {}, mode: "self", status: unsupported },
      { platform: "linux", environment: {}, mode: "container", status: unsupported },
      { platform: "darwin", environment: {}, mode: null, status: { phase: "unsupported", managedByHost: true } },
      { platform: "darwin", environment: {}, mode: null, status: { phase: "idle" } },
    ] as const;

    const methods = installations.map((installation) => {
      const release = new HostReleaseService({
        currentVersion: "0.56.0",
        packaged: true,
        platform: installation.platform,
        arch: "arm64",
        environment: installation.environment,
        installationMode: installation.mode,
        updateStatus: () => installation.status,
        fetch: recordingFetch().request,
      });
      return release.snapshot().method;
    });

    expect(methods).toEqual(["manual", "manual", "manual", "manual", "manual"]);
  });

  it("the Servers panel keeps the path of the host when a release feed is allowed", () => {
    const release = new HostReleaseService({
      currentVersion: "0.56.0",
      packaged: true,
      platform: "linux",
      arch: "x64",
      environment: { OPENBOT_HOSTED_SERVER: "1" },
      installationMode: null,
      updateStatus: () => ({ phase: "unsupported" }),
      fetch: recordingFetch().request,
      releaseFeed: TEST_FEED,
    });

    expect(release.snapshot().method).toBe("hosted");
  });

  it("the hosted installer finds no update, with no request", async () => {
    const { request, urls } = recordingFetch();
    const adapter = new HostedUpdateAdapter({ currentVersion: "0.56.0", arch: "x64", fetch: request });

    await expect(adapter.checkForUpdates()).rejects.toThrow("No release feed is available in this version");
    expect(urls).toEqual([]);
  });
});
