// Decoders of what main sends about Hub connections. Each one checks the whole value with the
// contract and copies only the known fields, so a field that main did not mean to send never reaches
// the page.

import {
  type HubConnectionAccessRequestResult,
  type HubConnectionAccessView,
  type HubConnectionsView,
  type HubConnectionUsageRow,
  type HubConnectionUsageView,
  isHubConnectionAccessRequestResult,
  isHubConnectionsView,
  isHubConnectionUsageView,
} from "@openbot/contracts/ipc";

function copyCap(cap: HubConnectionAccessView["cap"]): HubConnectionAccessView["cap"] {
  return cap.kind === "limited"
    ? { kind: "limited", amountMicros: cap.amountMicros }
    : { kind: "unlimited", dailyMicros: cap.dailyMicros };
}

function copyAccess(row: HubConnectionAccessView): HubConnectionAccessView {
  return {
    orgId: row.orgId,
    orgName: row.orgName,
    personal: row.personal,
    org: row.org,
    user: row.user,
    consented: row.consented,
    currency: row.currency,
    cap: copyCap(row.cap),
    settledMicros: row.settledMicros,
    reservedMicros: row.reservedMicros,
    availableMicros: row.availableMicros,
    effectiveAvailableMicros: row.effectiveAvailableMicros,
    bindingScope: row.bindingScope,
    state: row.state,
    maxCostPerCallMicros: row.maxCostPerCallMicros,
    confirmAboveMicros: row.confirmAboveMicros,
    resetsAt: row.resetsAt,
    asOf: row.asOf,
    counterVersion: row.counterVersion,
    categories: [...row.categories],
    priceFromMicros: row.priceFromMicros,
    requestedAt: row.requestedAt,
    moreRequestedAt: row.moreRequestedAt,
  };
}

export function decodeHubConnectionsView(value: unknown): HubConnectionsView {
  if (!isHubConnectionsView(value)) throw new Error("Invalid Hub connections view.");
  return {
    status: value.status,
    readAt: value.readAt,
    connections: value.connections.map((connection) => ({
      id: connection.id,
      name: connection.name,
      tagline: connection.tagline,
      description: connection.description,
      operations: [...connection.operations],
      itemsCount: connection.itemsCount,
      dataPolicy: {
        vendor: connection.dataPolicy.vendor,
        region: connection.dataPolicy.region,
        retentionDays: connection.dataPolicy.retentionDays,
      },
      access: connection.access.map(copyAccess),
      payer: connection.payer,
      payerOrgId: connection.payerOrgId,
      enabled: connection.enabled,
    })),
  };
}

function copyUsageRow(row: HubConnectionUsageRow): HubConnectionUsageRow {
  return {
    id: row.id,
    name: row.name,
    settledMicros: row.settledMicros,
    reservedMicros: row.reservedMicros,
    calls: row.calls,
    availableMicros: row.availableMicros,
    effectiveAvailableMicros: row.effectiveAvailableMicros,
    state: row.state,
    cap: row.cap ? copyCap(row.cap) : null,
    bindingScope: row.bindingScope,
    platforms: row.platforms.map(({ platform, settledMicros, calls }) => ({ platform, settledMicros, calls })),
  };
}

export function decodeHubConnectionUsageView(value: unknown): HubConnectionUsageView {
  if (!isHubConnectionUsageView(value)) throw new Error("Invalid Hub connection usage.");
  return {
    status: value.status,
    orgs: value.orgs.map((org) => ({
      orgId: org.orgId,
      orgName: org.orgName,
      personal: org.personal,
      periodKey: org.periodKey,
      resetsAt: org.resetsAt,
      timeZone: org.timeZone,
      currency: org.currency,
      asOf: org.asOf,
      connections: org.connections.map(copyUsageRow),
    })),
  };
}

export function decodeHubConnectionAccessRequestResult(value: unknown): HubConnectionAccessRequestResult {
  if (!isHubConnectionAccessRequestResult(value)) throw new Error("Invalid Hub connection access request result.");
  return { status: value.status, requestedAt: value.requestedAt, failure: value.failure };
}
