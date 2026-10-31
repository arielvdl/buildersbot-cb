import { existsSync, readFileSync } from "node:fs";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { parse as parseYaml } from "yaml";

/**
 * The origins that can serve an update feed of Builders Bot. This list is empty: no Builders Bot feed
 * exists yet, so no build reads a feed, downloads an update or installs one (phase 0 of
 * `.openbot-build/update-system/DESIGN.md`). Add an origin only together with the signed feed.
 * Never add the upstream OpenBot feed (`github.com/nightly-labs/openbot`).
 */
export const ALLOWED_UPDATE_FEED_ORIGINS: readonly string[] = [];

/**
 * The folder of `latest-linux.yml`, `latest-mac.yml` and `latest.yml` that hosted and container Linux
 * servers and the Servers panel read. Null: there is no release feed yet, so they send no request.
 */
export const RELEASE_FEED_BASE_URL: string | null = null;

/**
 * electron-updater keeps its downloads in this folder of the user cache. electron-builder names it
 * `<package name>-updater`. The upstream app has a folder with its own name, so its downloads stay out.
 */
export const UPDATER_CACHE_DIRECTORY_NAME = "buildersbot-updater";

/** Squirrel.Mac names its folder after the bundle identifier, which is `appId` in electron-builder.yml. */
export const SHIPIT_DIRECTORY_NAME = "app.buildersbot.desktop.ShipIt";

/** Larger than any app-update.yml that electron-builder writes. */
const MAX_METADATA_LENGTH = 64 * 1024;

export type UpdateFeedRefusal =
  | "no-feed"
  | "unreadable"
  | "provider-not-allowed"
  | "origin-not-allowed"
  | "cache-not-allowed";

export type UpdateFeedDecision =
  | { readonly allowed: true; readonly origin: string; readonly cacheDirName: string }
  | { readonly allowed: false; readonly reason: UpdateFeedRefusal };

export type ReleaseFeedDecision =
  | { readonly allowed: true; readonly baseUrl: string }
  | { readonly allowed: false; readonly reason: "no-feed" | "origin-not-allowed" };

/**
 * Decides if electron-updater can read the feed that `app-update.yml` names. `metadata` is the text
 * of that file, or null when the build has none. Only a `generic` feed on an HTTPS origin in
 * `allowedOrigins` passes. Each other provider (`github`, `s3`, `spaces`, `keygen`, `bitbucket`,
 * `gitlab`, `custom`) can name a feed that this check cannot see, so it is refused. Call this before
 * electron-updater loads: electron-updater reads the file by itself.
 */
export function decideUpdateFeed(
  metadata: string | null,
  allowedOrigins: readonly string[] = ALLOWED_UPDATE_FEED_ORIGINS,
): UpdateFeedDecision {
  if (metadata === null) return { allowed: false, reason: "no-feed" };
  if (metadata.length > MAX_METADATA_LENGTH) return { allowed: false, reason: "unreadable" };
  let value: unknown;
  try {
    value = parseYaml(metadata);
  } catch {
    return { allowed: false, reason: "unreadable" };
  }
  if (!isDynamicRecord(value)) return { allowed: false, reason: "unreadable" };
  if (value.provider !== "generic" || typeof value.url !== "string") {
    return { allowed: false, reason: "provider-not-allowed" };
  }
  const origin = allowedOrigin(value.url, allowedOrigins);
  if (origin === null) return { allowed: false, reason: "origin-not-allowed" };
  // electron-updater keeps and uses again the files in this folder. Another name can be the folder of
  // the upstream app, with its downloads in it.
  if ((value.updaterCacheDirName ?? UPDATER_CACHE_DIRECTORY_NAME) !== UPDATER_CACHE_DIRECTORY_NAME) {
    return { allowed: false, reason: "cache-not-allowed" };
  }
  return { allowed: true, origin, cacheDirName: UPDATER_CACHE_DIRECTORY_NAME };
}

/**
 * Decides if hosted and container Linux servers and the Servers panel can read the release feed at
 * `baseUrl`. With no feed, or a feed on an origin that is not in `allowedOrigins`, they send no request.
 */
export function decideReleaseFeed(
  baseUrl: string | null = RELEASE_FEED_BASE_URL,
  allowedOrigins: readonly string[] = ALLOWED_UPDATE_FEED_ORIGINS,
): ReleaseFeedDecision {
  if (baseUrl === null) return { allowed: false, reason: "no-feed" };
  if (allowedOrigin(baseUrl, allowedOrigins) === null) return { allowed: false, reason: "origin-not-allowed" };
  return { allowed: true, baseUrl: baseUrl.replace(/\/+$/u, "") };
}

/** Reads `app-update.yml`. Null: the file is not there. A file that cannot be read gives text that no rule accepts. */
export function readUpdateFeedMetadata(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The origin of `url` when it is HTTPS, has no user name or password, and is in `allowedOrigins`. */
function allowedOrigin(url: string, allowedOrigins: readonly string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  return allowedOrigins.includes(parsed.origin) ? parsed.origin : null;
}
