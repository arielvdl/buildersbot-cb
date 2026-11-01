// The values that main gives the renderer about Hub connections (packages/contracts/src/
// ipc-hub-connections.ts), built from Hub answers that the contract decoders already checked. They
// carry the Hub's texts, states and amounts, and nothing that opens a route: no token, no
// confirmation id, no Hub URL. The decoders of the preload check each value again.

import type {
  HubConnectionCatalog,
  HubConnectionEntry,
  HubConnectionUsage,
  HubOrgView,
} from "@openbot/contracts/hub-connections";
import type {
  HubConnectionOrgUsage,
  HubConnectionsView,
  HubConnectionsViewStatus,
  HubConnectionView,
} from "@openbot/contracts/ipc";
import type { HubClientFailureCode } from "./hub-connection-client";
import { canPay, choosePayer, PERSONAL_ORG } from "./hub-connection-payer";

/** The view status of a failure of the Hub client. */
export function failureStatus(code: HubClientFailureCode): HubConnectionsViewStatus {
  if (code === "signed_out") return "signed_out";
  if (code === "disabled" || code === "token_refused") return "off";
  return "unavailable";
}

function orgName(orgs: readonly HubOrgView[], orgId: string): string {
  return orgId === PERSONAL_ORG ? "" : (orgs.find((org) => org.id === orgId)?.name ?? orgId);
}

function connectionView(
  entry: HubConnectionEntry,
  orgs: readonly HubOrgView[],
  anchor: string | null,
  enabled: boolean,
): HubConnectionView {
  const decision = choosePayer(entry, orgs, anchor);
  return {
    id: entry.id,
    name: entry.name,
    tagline: entry.tagline,
    description: entry.description,
    operations: entry.operations.filter((operation) => operation.effect === "read").map((operation) => operation.title),
    itemsCount: entry.itemsCount,
    dataPolicy: { ...entry.dataPolicy },
    access: entry.access.map((row) => ({
      ...row,
      categories: [...row.categories],
      cap: { ...row.cap },
      orgName: orgName(orgs, row.orgId),
      personal: row.orgId === PERSONAL_ORG,
    })),
    payer: decision.kind,
    payerOrgId: decision.kind === "pay" ? decision.access.orgId : null,
    enabled,
  };
}

/**
 * The connections of the catalog for the Marketplace. `enabled` is the `/session` capability of each
 * connection; `anchor` is the organization that the person chose, or that paid the last call.
 */
export function connectionsView(
  catalog: HubConnectionCatalog,
  enabled: (connectionId: string) => boolean,
  anchor: (connectionId: string) => string | null,
  readAt: string,
): HubConnectionsView {
  return {
    status: "ready",
    connections: catalog.connections.map((entry) =>
      connectionView(entry, catalog.orgs, anchor(entry.id), enabled(entry.id)),
    ),
    readAt,
  };
}

/** The organizations whose use the person can read: each one with a row that this app may spend. */
export function usageOrgs(catalog: HubConnectionCatalog): string[] {
  const ids = new Set<string>();
  for (const entry of catalog.connections)
    for (const row of entry.access) if (canPay(row) || (row.consented && row.settledMicros > 0)) ids.add(row.orgId);
  return [...ids];
}

/** The person's own use in one organization, with the names of the catalog. */
export function orgUsageView(usage: HubConnectionUsage, catalog: HubConnectionCatalog): HubConnectionOrgUsage {
  return {
    orgId: usage.orgId,
    orgName: orgName(catalog.orgs, usage.orgId),
    personal: usage.orgId === PERSONAL_ORG,
    periodKey: usage.periodKey,
    resetsAt: usage.resetsAt,
    timeZone: usage.timeZone,
    currency: usage.currency,
    asOf: usage.asOf,
    connections: usage.connections.map((row) => ({
      id: row.id,
      name: catalog.connections.find((entry) => entry.id === row.id)?.name ?? row.id,
      settledMicros: row.settledMicros,
      reservedMicros: row.reservedMicros,
      calls: row.calls,
      availableMicros: row.availableMicros,
      effectiveAvailableMicros: row.effectiveAvailableMicros,
      state: row.state,
      cap: row.cap ? { ...row.cap } : null,
      bindingScope: row.bindingScope,
      platforms: row.platforms.map((platform) => ({ ...platform })),
    })),
  };
}
