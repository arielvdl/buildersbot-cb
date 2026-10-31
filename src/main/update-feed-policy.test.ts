import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_UPDATE_FEED_ORIGINS,
  decideReleaseFeed,
  decideUpdateFeed,
  RELEASE_FEED_BASE_URL,
  UPDATER_CACHE_DIRECTORY_NAME,
} from "./update-feed-policy";
import { type UpdateAdapter, UpdateService } from "./update-service";

// The app-update.yml that an upstream OpenBot build carries.
const UPSTREAM_METADATA = [
  "owner: nightly-labs",
  "repo: openbot",
  "provider: github",
  "updaterCacheDirName: openbot-updater",
].join("\n");
const TEST_ORIGIN = "https://updates.example.test";

function generic(url: string, cacheDirName?: string): string {
  return [
    "provider: generic",
    `url: ${url}`,
    ...(cacheDirName === undefined ? [] : [`updaterCacheDirName: ${cacheDirName}`]),
  ].join("\n");
}

describe("decideUpdateFeed", () => {
  it("allows no origin in this version", () => {
    expect(ALLOWED_UPDATE_FEED_ORIGINS).toEqual([]);
    expect(RELEASE_FEED_BASE_URL).toBeNull();
  });

  it("refuses a build with no app-update.yml", () => {
    expect(decideUpdateFeed(null)).toEqual({ allowed: false, reason: "no-feed" });
  });

  it("refuses the upstream GitHub feed, also when its origin is in the list", () => {
    expect(decideUpdateFeed(UPSTREAM_METADATA)).toEqual({ allowed: false, reason: "provider-not-allowed" });
    expect(decideUpdateFeed(UPSTREAM_METADATA, ["https://github.com"])).toEqual({
      allowed: false,
      reason: "provider-not-allowed",
    });
  });

  it("refuses each provider that is not generic", () => {
    for (const provider of ["s3", "spaces", "keygen", "bitbucket", "gitlab", "custom", "snapStore"]) {
      expect(decideUpdateFeed(`provider: ${provider}\nurl: ${TEST_ORIGIN}/feed`, [TEST_ORIGIN])).toEqual({
        allowed: false,
        reason: "provider-not-allowed",
      });
    }
  });

  it("refuses a generic feed over HTTP, with credentials, or on another origin", () => {
    expect(decideUpdateFeed(generic("http://updates.example.test/feed"), ["http://updates.example.test"])).toEqual({
      allowed: false,
      reason: "origin-not-allowed",
    });
    expect(decideUpdateFeed(generic("https://user:secret@updates.example.test/feed"), [TEST_ORIGIN])).toEqual({
      allowed: false,
      reason: "origin-not-allowed",
    });
    expect(decideUpdateFeed(generic("https://other.example.test/feed"), [TEST_ORIGIN])).toEqual({
      allowed: false,
      reason: "origin-not-allowed",
    });
  });

  it("refuses a generic feed on a listed origin while the default list is empty", () => {
    expect(decideUpdateFeed(generic(`${TEST_ORIGIN}/feed`))).toEqual({ allowed: false, reason: "origin-not-allowed" });
  });

  it("allows a generic HTTPS feed on a listed origin, with the Builders Bot cache folder", () => {
    expect(decideUpdateFeed(generic(`${TEST_ORIGIN}/feed`), [TEST_ORIGIN])).toEqual({
      allowed: true,
      origin: TEST_ORIGIN,
      cacheDirName: UPDATER_CACHE_DIRECTORY_NAME,
    });
    expect(decideUpdateFeed(generic(`${TEST_ORIGIN}/feed`, "buildersbot-updater"), [TEST_ORIGIN]).allowed).toBe(true);
  });

  it("refuses a feed that names another cache folder, such as the upstream one", () => {
    expect(decideUpdateFeed(generic(`${TEST_ORIGIN}/feed`, "openbot-updater"), [TEST_ORIGIN])).toEqual({
      allowed: false,
      reason: "cache-not-allowed",
    });
  });

  it("refuses a file that is not a YAML map", () => {
    expect(decideUpdateFeed("")).toEqual({ allowed: false, reason: "unreadable" });
    expect(decideUpdateFeed("provider: [generic")).toEqual({ allowed: false, reason: "unreadable" });
    expect(decideUpdateFeed("- generic")).toEqual({ allowed: false, reason: "unreadable" });
  });
});

describe("decideReleaseFeed", () => {
  it("refuses the hosted and Servers panel feed in this version", () => {
    expect(decideReleaseFeed()).toEqual({ allowed: false, reason: "no-feed" });
  });

  it("refuses the upstream release feed, and allows only a listed HTTPS origin", () => {
    expect(decideReleaseFeed("https://github.com/nightly-labs/openbot/releases/latest/download")).toEqual({
      allowed: false,
      reason: "origin-not-allowed",
    });
    expect(decideReleaseFeed(`${TEST_ORIGIN}/feeds/`, [TEST_ORIGIN])).toEqual({
      allowed: true,
      baseUrl: `${TEST_ORIGIN}/feeds`,
    });
  });
});

function spyAdapter() {
  const adapter = {
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    on: vi.fn(() => undefined),
    quitAndInstall: vi.fn(() => undefined),
  } satisfies UpdateAdapter;
  return adapter;
}

describe("UpdateService with no allowed feed", () => {
  it("says that updates are not available in this version, and never checks, downloads or installs", async () => {
    const adapter = spyAdapter();
    const service = new UpdateService(adapter, {
      currentVersion: "0.56.0",
      enabled: false,
      noUpdateFeed: true,
      autoDownload: true,
      beforeInstall: async () => undefined,
      platform: "linux",
    });
    service.start();

    expect(service.getStatus()).toMatchObject({
      phase: "unsupported",
      message: sourceText("error.update.notAvailableInThisVersion"),
      errorCode: null,
    });
    // The saved preference turns automatic downloads on. It must not start one.
    await Effect.runPromise(service.setAutoDownload(true));
    expect((await Effect.runPromise(service.checkForUpdates())).phase).toBe("unsupported");
    expect((await Effect.runPromise(service.downloadUpdate())).phase).toBe("unsupported");
    await expect(Effect.runPromise(service.installUpdate())).rejects.toThrow();

    expect(adapter.checkForUpdates).not.toHaveBeenCalled();
    expect(adapter.downloadUpdate).not.toHaveBeenCalled();
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
    expect(service.getStatus().phase).toBe("unsupported");
    await Effect.runPromise(service.stop());
  });

  it("keeps the earlier message for a development run", () => {
    const service = new UpdateService(spyAdapter(), {
      currentVersion: "0.56.0",
      enabled: false,
      autoDownload: true,
      beforeInstall: async () => undefined,
      platform: "linux",
    });

    expect(service.getStatus().message).toBe(sourceText("error.update.unsupported"));
  });
});
