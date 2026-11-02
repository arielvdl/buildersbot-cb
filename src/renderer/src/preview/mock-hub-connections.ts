import {
  HUB_CONNECTIONS_LIMITS,
  HUB_PLATFORM_GROUPS,
  type HubConnectionPlatform,
} from "@openbot/contracts/hub-connections";
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
  | "consent"
  /**
   * Every provider of the vendor catalog is on: as many platforms as the contract keeps (40), in every
   * group, thousands of endpoints, and the person's cap in US dollars (US$ 20).
   */
  | "allProviders";

const TEXT = {
  en: {
    name: "Tool catalog",
    tagline: "Paid external data, with a monthly limit for each person",
    categories: ["SEO and keywords", "Company data", "App stores", "Reviews", "Open web"],
    platforms: {
      appStores: "App stores",
      companyData: "Company data",
      marketData: "Market data",
      openWeb: "Open web",
      imageTools: "Image tools",
      developerData: "Developer data",
      adsLibrary: "Ads library",
    },
  },
  pt: {
    name: "Catálogo de ferramentas",
    tagline: "Dados externos pagos, com teto mensal por pessoa",
    categories: ["SEO e palavras-chave", "Dados de empresas", "Lojas de apps", "Avaliações", "Web aberta"],
    platforms: {
      appStores: "Lojas de apps",
      companyData: "Dados de empresas",
      marketData: "Dados de mercado",
      openWeb: "Web aberta",
      imageTools: "Ferramentas de imagem",
      developerData: "Dados para devs",
      adsLibrary: "Biblioteca de anúncios",
    },
  },
} as const;

/** The platforms of the tool catalog in the stories: one or more in each category that the tiles fill. */
function storyPlatforms(locale: "en" | "pt"): HubConnectionPlatform[] {
  const names = TEXT[locale].platforms;
  return [
    { id: "google-ads", name: "Google Ads", group: "seo", endpoints: 6 },
    { id: "app-store", name: names.appStores, group: "reviews", endpoints: 3 },
    { id: "trustpilot", name: "Trustpilot", group: "reviews", endpoints: 1 },
    { id: "company-data", name: names.companyData, group: "enrichment", endpoints: 5 },
    { id: "market-data", name: names.marketData, group: "market", endpoints: 4 },
    { id: "open-web", name: names.openWeb, group: "research", endpoints: 7 },
    { id: "image-tools", name: names.imageTools, group: "generation", endpoints: 2 },
    { id: "developer-data", name: names.developerData, group: "developer", endpoints: 3 },
    { id: "ads-library", name: names.adsLibrary, group: "advertising", endpoints: 2 },
  ];
}

/**
 * As many platforms as the contract keeps, in every group, with a few names at the length limit, as
 * the catalog holds them with every provider on. The Hub sorts them by endpoints, most first.
 */
function storyAllPlatforms(locale: "en" | "pt"): HubConnectionPlatform[] {
  const label = locale === "pt" ? "Fonte de dados" : "Data source";
  const longTail =
    locale === "pt" ? "com um nome longo que ocupa a linha toda" : "with a long name that fills the whole line";
  const known = storyPlatforms(locale);
  const more = Array.from({ length: HUB_CONNECTIONS_LIMITS.platforms - known.length }, (_, index) => {
    const number = String(index + known.length + 1).padStart(2, "0");
    const long = index % 9 === 0;
    return {
      id: `source-${number}`,
      name: long
        ? `${label} ${number} ${longTail}`.slice(0, HUB_CONNECTIONS_LIMITS.platformNameChars)
        : `${label} ${number}`,
      group: HUB_PLATFORM_GROUPS[index % HUB_PLATFORM_GROUPS.length] ?? "other",
      endpoints: Math.max(1, 90 - index * 2),
    } satisfies HubConnectionPlatform;
  });
  return [...more, ...known].sort((a, b) => b.endpoints - a.endpoints || a.id.localeCompare(b.id));
}

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
          : state === "allProviders"
            ? [
                accessRow(
                  "org_a",
                  "Empresa A",
                  4_180_000,
                  {
                    currency: "USD",
                    cap: { kind: "limited", amountMicros: 20_000_000 },
                    availableMicros: 15_820_000,
                    effectiveAvailableMicros: 15_820_000,
                    maxCostPerCallMicros: 2_000_000,
                    confirmAboveMicros: 500_000,
                    priceFromMicros: 1_000,
                  },
                  locale,
                ),
              ]
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
    itemsCount: state === "allProviders" ? 4_120 : 312,
    dataPolicy: { vendor: "treg.to", region: "us", retentionDays: 0 },
    access,
    payer,
    payerOrgId: payer === "pay" ? "org_a" : null,
    enabled: state !== "paused" && state !== "pausedUnused",
    platforms: state === "allProviders" ? storyAllPlatforms(locale) : storyPlatforms(locale),
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
    // The preview has no Hub and no browser of the person: the page stays as it is.
    openConsent: async () => undefined,
  };
}
