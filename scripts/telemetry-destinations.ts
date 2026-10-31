// The analytics and telemetry destinations of the upstream OpenBot project. Builders Bot does not
// control them, so no build may send data to them (phase 0 of .openbot-build/bug-reports/DESIGN.md).
// This file is the one place that names them: `scripts/telemetry-destination-guard.ts` looks for each
// string in the source and the build output, and E2E scripts check that no request goes to a host.
// Nothing in the app imports this file.

/** Upstream analytics: the OpenPanel service of the upstream project and the default of its SDK. */
export const BLOCKED_ANALYTICS_HOSTS = ["analytics.openbot.run", "api.openpanel.dev"] as const;

/**
 * Strings that only an OpenPanel client of the upstream project contains: the client ID of the
 * upstream project, the SDK default host, the SDK class and the SDK packages.
 */
export const BLOCKED_ANALYTICS_STRINGS = [
  "analytics.openbot.run",
  "6c989975-87ef-4f0c-857e-ab449a65b5c2",
  "openpanel.dev",
  "OpenPanelBase",
  "@openpanel/",
] as const;

/**
 * Upstream services that the desktop app and its development stack must not use: the test account
 * Worker of the upstream project and its production account API.
 */
export const BLOCKED_UPSTREAM_HOSTS = ["internal9671.workers.dev", "api.openbot.run"] as const;

/** True when a URL goes to an upstream analytics host or a subdomain of one. */
export function isBlockedAnalyticsUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const host = new URL(url).hostname.toLowerCase();
  return BLOCKED_ANALYTICS_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}
