import { describe, expect, it } from "vitest";
import { fetchLatestLinuxRelease } from "./host-release-service";

function feed(body: string): typeof fetch {
  return (() => Promise.resolve(new Response(body))) as unknown as typeof fetch;
}

const signal = new AbortController().signal;

describe("fetchLatestLinuxRelease", () => {
  it("accepts the upstream Builders Bot asset name", async () => {
    const manifest = ["version: 0.54.0", "files:", "  - url: Builders Bot-0.54.0-arm64.AppImage"].join("\n");

    await expect(fetchLatestLinuxRelease("arm64", feed(manifest), signal)).resolves.toBe("0.54.0");
  });

  it("accepts the Builders Bot asset name", async () => {
    const manifest = ["version: 0.54.0", "files:", "  - url: Builders Bot-0.54.0-arm64.AppImage"].join("\n");

    await expect(fetchLatestLinuxRelease("arm64", feed(manifest), signal)).resolves.toBe("0.54.0");
  });

  it("refuses a release for another architecture", async () => {
    const manifest = ["version: 0.54.0", "files:", "  - url: Builders Bot-0.54.0-x86_64.AppImage"].join("\n");

    await expect(fetchLatestLinuxRelease("arm64", feed(manifest), signal)).rejects.toThrow("No compatible release");
  });
});
