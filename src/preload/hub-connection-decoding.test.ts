// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  decodeHubConnectionAccessRequestResult,
  decodeHubConnectionsView,
  decodeHubConnectionUsageView,
} from "./hub-connection-decoding";

const ROW = {
  orgId: "org_a",
  orgName: "Empresa A",
  personal: false,
  org: "enabled",
  user: "allowed",
  consented: true,
  currency: "BRL",
  cap: { kind: "limited", amountMicros: 25_000_000 },
  settledMicros: 20_400_000,
  reservedMicros: 0,
  availableMicros: 4_600_000,
  effectiveAvailableMicros: 4_600_000,
  bindingScope: "user",
  state: "warning",
  maxCostPerCallMicros: 1_000_000,
  confirmAboveMicros: 250_000,
  resetsAt: "2026-12-01T03:00:00.000Z",
  asOf: "2026-11-18T14:05:00.000Z",
  counterVersion: 42,
  categories: ["SEO e palavras-chave"],
  priceFromMicros: 10_000,
  requestedAt: null,
  moreRequestedAt: null,
};

const CONNECTION = {
  id: "tool-catalog",
  name: "Catálogo de ferramentas",
  tagline: "Dados externos pagos",
  description: "",
  operations: ["Search", "Describe", "Call"],
  itemsCount: 312,
  dataPolicy: { vendor: "treg.to", region: "us", retentionDays: 0 },
  access: [ROW],
  payer: "pay",
  payerOrgId: "org_a",
  enabled: true,
  platforms: [
    { id: "google-ads", name: "Google Ads", group: "seo", endpoints: 4 },
    { id: "app-store", name: "Lojas de apps", group: "reviews", endpoints: 2 },
  ],
};

const PLATFORM = CONNECTION.platforms[0];

const VIEW = { status: "ready", connections: [CONNECTION], readAt: "2026-11-18T14:05:00.000Z" };

const USAGE = {
  status: "ready",
  orgs: [
    {
      orgId: "org_a",
      orgName: "Empresa A",
      personal: false,
      periodKey: "2026-11",
      resetsAt: "2026-12-01T03:00:00.000Z",
      timeZone: "America/Sao_Paulo",
      currency: "BRL",
      asOf: "2026-11-18T14:05:00.000Z",
      connections: [
        {
          id: "tool-catalog",
          name: "Catálogo de ferramentas",
          settledMicros: 20_400_000,
          reservedMicros: 0,
          calls: 214,
          availableMicros: 4_600_000,
          effectiveAvailableMicros: 4_600_000,
          state: "warning",
          cap: { kind: "limited", amountMicros: 25_000_000 },
          bindingScope: "user",
          platforms: [{ platform: "google-ads", settledMicros: 11_220_000, calls: 120 }],
        },
      ],
    },
  ],
};

describe("decodeHubConnectionsView", () => {
  it("keeps a valid view", () => {
    expect(decodeHubConnectionsView(VIEW)).toEqual(VIEW);
  });

  it("drops a field that main did not mean to send", () => {
    const decoded = decodeHubConnectionsView({
      ...VIEW,
      token: "cbp_secret",
      connections: [
        {
          ...CONNECTION,
          hubUrl: "https://hub",
          access: [{ ...ROW, refresh: "x" }],
          platforms: CONNECTION.platforms.map((platform) => ({ ...platform, logoUrl: "https://example.com/x.png" })),
        },
      ],
    });
    expect(decoded).toEqual(VIEW);
  });

  it.each([
    ["markup in a name", { ...CONNECTION, name: "<img src=x onerror=alert(1)>" }],
    ["a connection id with a path", { ...CONNECTION, id: "../tool-catalog" }],
    ["an amount that is not a safe integer", { ...CONNECTION, access: [{ ...ROW, settledMicros: 2 ** 60 }] }],
    ["a negative amount", { ...CONNECTION, access: [{ ...ROW, availableMicros: -1 }] }],
    ["a payer with no organization", { ...CONNECTION, payerOrgId: null }],
    ["an organization id with markup", { ...CONNECTION, access: [{ ...ROW, orgId: "<b>" }] }],
    ["a category with markup", { ...CONNECTION, access: [{ ...ROW, categories: ["<script>"] }] }],
    ["an unknown cap state", { ...CONNECTION, access: [{ ...ROW, state: "over" }] }],
    ["a vendor with markup", { ...CONNECTION, dataPolicy: { ...CONNECTION.dataPolicy, vendor: "<a href=x>" } }],
    ["no enabled flag", { ...CONNECTION, enabled: undefined }],
    ["no platform list", { ...CONNECTION, platforms: undefined }],
    ["a platform name with markup", { ...CONNECTION, platforms: [{ ...PLATFORM, name: "<img src=x>" }] }],
    ["a platform id that is not a slug", { ...CONNECTION, platforms: [{ ...PLATFORM, id: "../x" }] }],
    ["a platform group that the contract does not know", { ...CONNECTION, platforms: [{ ...PLATFORM, group: "x" }] }],
    ["a platform with no endpoint", { ...CONNECTION, platforms: [{ ...PLATFORM, endpoints: 0 }] }],
    ["the same platform twice", { ...CONNECTION, platforms: [PLATFORM, PLATFORM] }],
    [
      "more than 40 platforms",
      {
        ...CONNECTION,
        platforms: Array.from({ length: 41 }, (_, index) => ({ ...PLATFORM, id: `p${index}` })),
      },
    ],
  ])("refuses %s", (_name, connection) => {
    expect(() => decodeHubConnectionsView({ ...VIEW, connections: [connection] })).toThrow();
  });

  it("refuses an unknown status", () => {
    expect(() => decodeHubConnectionsView({ ...VIEW, status: "maybe" })).toThrow();
  });
});

describe("decodeHubConnectionUsageView", () => {
  it("keeps a valid usage", () => {
    expect(decodeHubConnectionUsageView(USAGE)).toEqual(USAGE);
  });

  it("refuses a platform that is not a slug and a period that is not a month", () => {
    const [org] = USAGE.orgs;
    const [row] = org?.connections ?? [];
    expect(() =>
      decodeHubConnectionUsageView({
        ...USAGE,
        orgs: [{ ...org, connections: [{ ...row, platforms: [{ platform: "<b>", settledMicros: 1, calls: 1 }] }] }],
      }),
    ).toThrow();
    expect(() => decodeHubConnectionUsageView({ ...USAGE, orgs: [{ ...org, periodKey: "2026-13" }] })).toThrow();
  });
});

describe("decodeHubConnectionAccessRequestResult", () => {
  it("keeps a sent request and a failed one", () => {
    const sent = { status: "sent", requestedAt: "2026-11-18T14:05:00.000Z", failure: null };
    const failed = { status: "failed", requestedAt: null, failure: "offline" };
    expect(decodeHubConnectionAccessRequestResult(sent)).toEqual(sent);
    expect(decodeHubConnectionAccessRequestResult(failed)).toEqual(failed);
  });

  it("refuses a failure with a date, and a sent request with a failure", () => {
    expect(() =>
      decodeHubConnectionAccessRequestResult({
        status: "failed",
        requestedAt: "2026-11-18T14:05:00Z",
        failure: "offline",
      }),
    ).toThrow();
    expect(() =>
      decodeHubConnectionAccessRequestResult({
        status: "sent",
        requestedAt: "2026-11-18T14:05:00Z",
        failure: "offline",
      }),
    ).toThrow();
  });
});
