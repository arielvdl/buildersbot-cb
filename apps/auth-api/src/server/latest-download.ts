import { sourceText } from "@openbot/i18n/source";
import { Effect, Schema } from "effect";

export type AvailableDownloadPlatform = "linux" | "macos" | "windows";

/**
 * `latest-mac.yml` lists the Apple silicon and the Intel installer, so a macOS download also names
 * its architecture. electron-builder puts `arm64` in the Apple silicon asset name and no
 * architecture suffix that contains it in the Intel one. Linux has one manifest per architecture,
 * and Windows ships x64 only.
 */
export type DownloadArchitecture = "arm64" | "x64";

interface DownloadManifestConfig {
  /**
   * Compared against a lowercased asset name, so it must be lowercase itself. The Linux asset is
   * published as `.AppImage`.
   */
  extension: ".appimage" | ".dmg" | ".exe";
  manifest: "latest-linux-arm64.yml" | "latest-linux.yml" | "latest-mac.yml" | "latest.yml";
}

/**
 * The GitHub releases of the Builders Bot desktop app, or null while there are none. The upstream
 * releases are another app: it signs in to the upstream account service, not with Cultura Builder,
 * so no download button may lead there. Until Builders Bot publishes its releases, each download
 * answers that the installer is not published here yet.
 */
const RELEASES_BASE_URL: string | null = "https://github.com/arielvdl/buildersbot-cb/releases";

const DOWNLOAD_PLATFORMS = ["linux", "macos", "windows"] as const satisfies readonly AvailableDownloadPlatform[];

function downloadManifest(
  platform: AvailableDownloadPlatform,
  architecture: DownloadArchitecture,
): DownloadManifestConfig {
  if (platform === "linux")
    return {
      extension: ".appimage",
      manifest: architecture === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml",
    };
  if (platform === "macos") return { extension: ".dmg", manifest: "latest-mac.yml" };
  return { extension: ".exe", manifest: "latest.yml" };
}

export function isAvailableDownloadPlatform(value: string): value is AvailableDownloadPlatform {
  return DOWNLOAD_PLATFORMS.some((platform) => platform === value);
}

/**
 * The architecture a `?arch=` value asks for. Most Macs are Apple silicon and most Linux computers
 * are x64, so anything else gets those. Windows has only the x64 installer.
 */
export function downloadArchitecture(platform: AvailableDownloadPlatform, arch: string | null): DownloadArchitecture {
  if (platform === "macos") return arch === "x64" ? "x64" : "arm64";
  if (platform === "linux") return arch === "arm64" ? "arm64" : "x64";
  return "x64";
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location,
    },
  });
}

function findInstaller(
  manifest: string,
  extension: DownloadManifestConfig["extension"],
  macArchitecture: DownloadArchitecture | undefined,
): string | undefined {
  const assetLines = manifest.matchAll(/^\s*-\s+url:\s*["']?([^\s"']+)["']?\s*$/gim);
  for (const match of assetLines) {
    const asset = match[1];
    if (!asset?.toLowerCase().endsWith(extension) || !/^[a-z0-9][a-z0-9._+-]+$/i.test(asset)) continue;
    if (macArchitecture && asset.toLowerCase().includes("arm64") !== (macArchitecture === "arm64")) continue;
    return asset;
  }
  return undefined;
}

/**
 * The releases page is a working answer but not the one that was asked for, so each fallback says
 * why. Written to the Worker log rather than to analytics: a server event has no session, and the
 * landing reports are defined on sessions. Platform and reason only, never a URL or a response body.
 */
function fallbackToReleases(platform: AvailableDownloadPlatform, releasesUrl: string, reason: string): Response {
  console.warn(`latest-download: serving the releases page for ${platform} (${reason})`);
  return redirect(releasesUrl);
}

/** The answer while there is no Builders Bot release to download. */
function installerNotPublished(): Response {
  return new Response(sourceText("error.auth.desktopInstallerUnpublished"), {
    status: 404,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}

class DownloadManifestError extends Schema.TaggedError<DownloadManifestError>()("DownloadManifestError", {}) {}

const latestDownload = Effect.fn("LatestDownload.resolve")(function* (
  platform: AvailableDownloadPlatform,
  fetcher: typeof fetch,
  architecture: DownloadArchitecture,
  releasesUrl: string,
) {
  const config = downloadManifest(platform, architecture);
  // Cache-buster: the Workers runtime shares Cloudflare's HTTP cache with browsers, and GitHub
  // release assets are cached aggressively, so a fresh upload would keep serving a stale 404.
  const bust = `?r=${Date.now()}`;
  const manifestUrl = `${releasesUrl}/latest/download/${config.manifest}${bust}`;
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetcher(manifestUrl, {
        headers: { accept: "text/yaml, text/plain" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      }),
    catch: () => new DownloadManifestError({}),
  });
  if (!response.ok) return fallbackToReleases(platform, releasesUrl, `manifest status ${response.status}`);
  const manifest = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () => new DownloadManifestError({}),
  });
  // Only the macOS manifest lists two architectures.
  const installer = findInstaller(manifest, config.extension, platform === "macos" ? architecture : undefined);
  if (!installer) return fallbackToReleases(platform, releasesUrl, `no ${config.extension} asset in the manifest`);
  return redirect(`${releasesUrl}/latest/download/${encodeURIComponent(installer)}`);
});

export function latestDownloadResponse(
  platform: AvailableDownloadPlatform,
  fetcher: typeof fetch = fetch,
  architecture: DownloadArchitecture = downloadArchitecture(platform, null),
  releasesUrl: string | null = RELEASES_BASE_URL,
) {
  if (releasesUrl === null) return Effect.succeed(installerNotPublished());
  return latestDownload(platform, fetcher, architecture, releasesUrl).pipe(
    Effect.catch(() => Effect.sync(() => fallbackToReleases(platform, releasesUrl, "the manifest request failed"))),
  );
}
