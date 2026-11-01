import type {
  BuildersBotDesktopApi,
  HubConnectionAccessView,
  HubConnectionsView,
  HubConnectionUsageView,
  HubConnectionView,
} from "@openbot/contracts/ipc";

/** The states of the tool catalog that the preview and the stories show. */
export type StoryConnectionState =
  | "ok"
  | "warning"
  | "reached"
  | "notEnabled"
  | "choose"
  | "paused"
  | "pausedUnused"
  | "consent";

const TEXT = {
  en: {
    name: "Tool catalog",
    tagline: "Paid external data, with a monthly limit for each person",
    categories: ["SEO and keywords", "Company data", "App stores", "Reviews", "Open web"],
  },
  pt: {
    name: "Catálogo de ferramentas",
    tagline: "Dados externos pagos, com teto mensal por pessoa",
    categories: ["SEO e palavras-chave", "Dados de empresas", "Lojas de apps", "Avaliações", "Web aberta"],
  },
} as const;

const RESETS_AT = "2026-12-01T03:00:00.000Z";
const AS_OF = "2026-11-18T14:05:00.000Z";

function accessRow(
  orgId: string,
  orgName: string,
  settledMicros: number,
  change: Partial<HubConnectionAccessView>,
  locale: "en" | "pt",
): HubConnectionAccessView {
  const capMicros = 25_000_000;
  const available = Math.max(0, capMicros - settledMicros);
  return {
    orgId,
    orgName,
    personal: false,
    org: "enabled",
    user: "allowed",
    consented: true,
    currency: "BRL",
    cap: { kind: "limited", amountMicros: capMicros },
    settledMicros,
    reservedMicros: 0,
    availableMicros: available,
    effectiveAvailableMicros: available,
    bindingScope: "user",
    state: settledMicros >= capMicros ? "reached" : settledMicros >= capMicros * 0.8 ? "warning" : "ok",
    maxCostPerCallMicros: 1_000_000,
    confirmAboveMicros: 250_000,
    resetsAt: RESETS_AT,
    asOf: AS_OF,
    counterVersion: 42,
    categories: [...TEXT[locale].categories],
    priceFromMicros: 10_000,
    requestedAt: null,
    moreRequestedAt: null,
    ...change,
  };
}

/** The tool catalog in one state, in one language, as main gives it to the page. */
export function storyToolCatalogView(state: StoryConnectionState, locale: "en" | "pt" = "en"): HubConnectionView {
  const text = TEXT[locale];
  const spent = state === "warning" ? 20_400_000 : state === "reached" ? 25_000_000 : 6_180_000;
  const empresaA = accessRow("org_a", "Empresa A", spent, {}, locale);
  const access: HubConnectionAccessView[] =
    state === "notEnabled"
      ? [accessRow("org_a", "Empresa A", 0, { org: "not_enabled", user: "not_allowed" }, locale)]
      : state === "consent"
        ? [accessRow("org_a", "Empresa A", 0, { consented: false }, locale)]
        : state === "choose"
          ? [empresaA, accessRow("org_b", "Empresa B", 0, {}, locale)]
          : state === "paused"
            ? [accessRow("org_a", "Empresa A", spent, { org: "paused" }, locale)]
            : // The Hub paused it for everyone, and the person spent nothing yet this month.
              state === "pausedUnused"
              ? [accessRow("org_a", "Empresa A", 0, {}, locale)]
              : [empresaA];
  const payer =
    state === "choose"
      ? "choose_org"
      : state === "notEnabled" || state === "paused" || state === "pausedUnused" || state === "consent"
        ? "none"
        : "pay";
  return {
    id: "tool-catalog",
    name: text.name,
    tagline: text.tagline,
    description: "",
    operations: ["Search", "Describe", "Call"],
    itemsCount: 312,
    dataPolicy: { vendor: "treg.to", region: "us", retentionDays: 0 },
    access,
    payer,
    payerOrgId: payer === "pay" ? "org_a" : null,
    enabled: state !== "paused" && state !== "pausedUnused",
  };
}

export function storyHubConnectionsView(state: StoryConnectionState, locale: "en" | "pt" = "en"): HubConnectionsView {
  return { status: "ready", connections: [storyToolCatalogView(state, locale)], readAt: AS_OF };
}

/** The person's own use in Empresa A, with the platforms of the vendor catalog. */
export function storyHubConnectionUsage(state: "ok" | "warning" = "warning"): HubConnectionUsageView {
  const settled = state === "warning" ? 20_400_000 : 6_180_000;
  return {
    status: "ready",
    orgs: [
      {
        orgId: "org_a",
        orgName: "Empresa A",
        personal: false,
        periodKey: "2026-11",
        resetsAt: RESETS_AT,
        timeZone: "America/Sao_Paulo",
        currency: "BRL",
        asOf: AS_OF,
        connections: [
          {
            id: "tool-catalog",
            name: "Catálogo de ferramentas",
            settledMicros: settled,
            reservedMicros: 0,
            calls: 214,
            availableMicros: 25_000_000 - settled,
            effectiveAvailableMicros: 25_000_000 - settled,
            state,
            cap: { kind: "limited", amountMicros: 25_000_000 },
            bindingScope: "user",
            platforms: [
              { platform: "google-ads", settledMicros: Math.round(settled * 0.55), calls: 120 },
              { platform: "trustpilot", settledMicros: Math.round(settled * 0.3), calls: 61 },
              { platform: "app-store", settledMicros: Math.round(settled * 0.15), calls: 33 },
            ],
          },
        ],
      },
    ],
  };
}

export interface MockHubConnectionsOptions {
  view?: HubConnectionsView;
  usage?: HubConnectionUsageView;
}

/**
 * The Hub connections of the preview. With no options the preview has no Cultura Builder connection
 * on, so the Marketplace and Usage look as they do without one.
 */
export function createMockHubConnections(
  options: MockHubConnectionsOptions = {},
): BuildersBotDesktopApi["hubConnections"] {
  const off: HubConnectionsView = { status: "off", connections: [], readAt: null };
  let view = structuredClone(options.view ?? off);
  const usage: HubConnectionUsageView = structuredClone(options.usage ?? { status: "off", orgs: [] });
  return {
    getView: async () => structuredClone(view),
    refresh: async () => structuredClone(view),
    getUsage: async () => structuredClone(usage),
    choosePayer: async ({ connectionId, orgId }) => {
      view = {
        ...view,
        connections: view.connections.map((connection) =>
          connection.id === connectionId && connection.access.some((row) => row.orgId === orgId)
            ? { ...connection, payer: "pay", payerOrgId: orgId }
            : connection,
        ),
      };
      return structuredClone(view);
    },
    requestAccess: async () => ({ status: "sent", requestedAt: new Date().toISOString(), failure: null }),
  };
}
