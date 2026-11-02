import type {
  HubAccessRequestKind,
  HubConnectionAccessRequestResult,
  HubConnectionAccessView,
  HubConnectionsViewStatus,
  HubConnectionView,
  HubPlatformGroup,
  SkillCategory,
} from "@openbot/contracts/ipc";
import type { MarketplaceAgent, MarketplaceApp, MarketplaceAppStatus } from "./marketplace-model";

/**
 * The Hub connections of the Marketplace (docs/architecture/hub-connections.md): paid APIs that
 * Cultura Builder offers through its Hub, with the key in the Hub. Each one is an app of the Apps
 * tab, so the curated list, the search and a link reach it as they reach any app
 * (docs/architecture/marketplace-apps-curation.md). The renderer reads them from main; a story builds
 * them from fixtures.
 */
export interface MarketplaceConnections {
  /** Whether main could read the connections, or why not. `loading` until its first answer. */
  status: () => HubConnectionsViewStatus | "loading";
  /** When main read the catalog. */
  readAt: () => string | null;
  /** Reads the Hub again. */
  refresh: () => void;
  /** An action of the connection runs. */
  busy: (connectionId: string) => boolean;
  /** The person chooses the organization that pays the connection. */
  choosePayer: (connectionId: string, orgId: string) => Promise<void>;
  /** Asks the admins of an organization for access, or for more money in this period. */
  requestAccess: (
    connectionId: string,
    orgId: string,
    kind: HubAccessRequestKind,
  ) => Promise<HubConnectionAccessRequestResult>;
  /** The agents of this computer. Empty when the Marketplace is for another server. */
  agents: () => readonly MarketplaceConnectionAgent[];
  /** Turns the connection on or off for one agent. Off: the agent does not get the connection's tools. */
  setAgentConnection: (agentId: string, connectionId: string, on: boolean) => Promise<void>;
  /**
   * Opens the connections page of the Hub in the browser, where the person allows this app to spend an
   * organization's connections. Absent where this client cannot open it.
   */
  openConsent?: (() => Promise<void>) | undefined;
}

export interface MarketplaceConnectionAgent extends MarketplaceAgent {
  /** The connections that this agent may not use. */
  connectionsOff: readonly string[];
}

export type ConnectionApp = Extract<MarketplaceApp, { kind: "connection" }>;
export type ConnectionPlatformApp = Extract<MarketplaceApp, { kind: "connection-platform" }>;

/**
 * The category of the Apps tab for each platform group, as the owner chose on 2026-10-31: the tiles
 * fill the categories whose catalog apps the default list hides.
 */
export const PLATFORM_CATEGORY = {
  seo: "research",
  research: "research",
  reviews: "research",
  community: "research",
  enrichment: "data-analytics",
  market: "data-analytics",
  commerce: "data-analytics",
  developer: "coding",
  generation: "design",
  advertising: "other",
  social: "other",
  other: "other",
} as const satisfies Record<HubPlatformGroup, SkillCategory>;

/** A row that can pay: the organization turned the connection on, the person may use it, and this app may spend. */
export function canPayRow(row: HubConnectionAccessView): boolean {
  return row.org === "enabled" && row.user === "allowed" && row.consented;
}

/**
 * The row that the page shows the cap of: the payer of the next call, else the first row that can
 * pay, else the first row with spend in this period, else the first row.
 */
export function shownAccess(view: HubConnectionView): HubConnectionAccessView | undefined {
  return (
    view.access.find((row) => row.orgId === view.payerOrgId) ??
    view.access.find(canPayRow) ??
    view.access.find((row) => row.settledMicros > 0) ??
    view.access[0]
  );
}

/**
 * The status of a connection in the Apps list and on its page:
 * - `connected`: the person can use it, and its cap is not near the end.
 * - `attention`: in use, but something needs the person: 80 % or more of the cap, the cap reached, a
 *   payer to choose, a consent to give on the Hub, or a pause of a connection that the person could
 *   pay for or has spend in this period.
 * - `idle`: the organization did not turn it on for the person, and it has no spend in this period.
 * A connection that is not `idle` is in use (installed), so the curated list always shows it, also
 * while the Hub pauses it.
 */
export function connectionStatus(view: HubConnectionView): MarketplaceAppStatus {
  const charged = view.access.some((row) => row.settledMicros > 0 || row.reservedMicros > 0);
  const allowed = view.access.filter((row) => row.org === "enabled" && row.user === "allowed");
  // Paused by the Hub: installed (a row that can pay, or spend) needs the person; else it is idle.
  if (!view.enabled) return charged || allowed.some((row) => row.consented) ? "attention" : "idle";
  if (allowed.length === 0) return charged ? "attention" : "idle";
  if (!allowed.some((row) => row.consented)) return "attention";
  if (view.payer === "choose_org") return "attention";
  const row = shownAccess(view);
  return row && row.state !== "ok" ? "attention" : "connected";
}

/** The app of the Apps tab for one connection. Its category is Research, for an organization profile. */
export function connectionApp(view: HubConnectionView): ConnectionApp {
  return {
    kind: "connection",
    id: view.id,
    name: view.name,
    tagline: view.tagline,
    status: connectionStatus(view),
    category: "research",
    connection: view,
  };
}

/**
 * The tiles of a connection's platforms, one per platform, with the status of the connection. Only
 * while Cultura Builder has the connection on and the person uses it (`connectionStatus` is not
 * `idle`): an account without the connection, or a paused one, has no tile. `tagline` writes the line
 * under the name, such as "Via Cultura Builder · 4 tools".
 */
export function connectionPlatformApps(
  view: HubConnectionView,
  tagline: (endpoints: number) => string,
): ConnectionPlatformApp[] {
  const status = connectionStatus(view);
  if (!view.enabled || status === "idle") return [];
  return view.platforms.map((platform) => ({
    kind: "connection-platform",
    id: `${view.id}:${platform.id}`,
    name: platform.name,
    tagline: tagline(platform.endpoints),
    status,
    category: PLATFORM_CATEGORY[platform.group],
    connectionId: view.id,
    platform,
  }));
}

/** The apps of the Apps tab for the Hub connections: each connection's row, then the tiles of its platforms. */
export function hubConnectionApps(
  views: readonly HubConnectionView[],
  tagline: (endpoints: number) => string,
): MarketplaceApp[] {
  return views.flatMap((view) => [connectionApp(view), ...connectionPlatformApps(view, tagline)]);
}

/**
 * How much of the cap is spent, from 0 to 1, with what is reserved for calls that still run. Null for
 * a cap with no amount, as an exception with no monthly limit.
 */
export function capUsed(row: HubConnectionAccessView): number | null {
  if (row.cap.kind !== "limited" || row.cap.amountMicros <= 0) return null;
  return Math.min(1, (row.settledMicros + row.reservedMicros) / row.cap.amountMicros);
}

/** The share of the cap where the Hub warns, as the contract says. */
export const CAP_WARNING_SHARE = 0.8;
