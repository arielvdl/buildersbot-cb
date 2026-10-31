import type { AppInfo, HostStatus, ServerSummary } from "@openbot/contracts/ipc";
import { MCP_SERVERS_CAPABILITY } from "@openbot/contracts/ipc";
import { AGENT_ACCESS_CAPABILITY } from "@openbot/contracts/team-protocol/agent-access-v1";
import { BROWSER_PROFILES_CAPABILITY } from "@openbot/contracts/team-protocol/browser-profiles-v1";
import { VAULT_CAPABILITY } from "@openbot/contracts/team-protocol/vault-v1";
import type { AppTextKey } from "@openbot/i18n";
import {
  AppWindow,
  ArrowLeftRight,
  Blocks,
  CalendarClock,
  Download,
  Globe2,
  HardDrive,
  KeyRound,
  Monitor,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "@openbot/ui";
import { serverHasStorage } from "../files/storage-usage";
import type { SettingsSearchKeys } from "../settings/settings-search";
import {
  activeServerHasProviderSettings,
  remoteUpdateServer,
  serverCanAdminister,
  serverSupportsCapability,
} from "./server-capabilities";

/** The sections of the server settings, in the order of the section list. */
const SERVER_SETTINGS_SECTION_LIST = [
  "general",
  "vault",
  "members",
  "roles",
  "desktop",
  "mcp",
  "storage",
  "sites",
  "providers",
  "updates",
  "import",
  "transfer",
  "routines",
  "browser-profiles",
] as const;

export type ServerSettingsSection = (typeof SERVER_SETTINGS_SECTION_LIST)[number];

/**
 * The title, the description and the icon of each section of the server settings, in the order of
 * the section list. The settings search and the command palette read the same keys.
 */
export const SERVER_SETTINGS_SECTIONS = {
  general: {
    title: "server.settings.generalTitle",
    description: "server.settings.generalDescription",
    keywords: "settings.search.keywords.serverGeneral",
    icon: Settings,
  },
  vault: {
    title: "server.settings.vaultTitle",
    description: "server.settings.vaultDescription",
    keywords: "settings.search.keywords.vault",
    icon: KeyRound,
  },
  members: {
    title: "server.settings.membersTitle",
    description: "server.settings.membersDescription",
    keywords: "settings.search.keywords.members",
    icon: UsersRound,
  },
  roles: {
    title: "server.settings.rolesTitle",
    description: "server.settings.rolesDescription",
    keywords: "settings.search.keywords.roles",
    icon: ShieldCheck,
  },
  desktop: {
    title: "server.settings.desktopTitle",
    description: "server.settings.desktopDescription",
    keywords: "settings.search.keywords.remoteDesktop",
    icon: Monitor,
  },
  mcp: {
    title: "server.settings.mcpTitle",
    description: "server.settings.mcpDescription",
    keywords: "settings.search.keywords.mcp",
    icon: Blocks,
  },
  storage: {
    title: "server.settings.storageTitle",
    description: "server.settings.storageDescription",
    keywords: "settings.search.keywords.storage",
    icon: HardDrive,
  },
  sites: {
    title: "server.settings.hostedSitesTitle",
    description: "server.settings.hostedSitesDescription",
    keywords: "settings.search.keywords.sites",
    icon: Globe2,
  },
  providers: {
    title: "server.settings.providersTitle",
    description: "server.settings.providersDescription",
    keywords: "settings.search.keywords.providers",
    icon: Sparkles,
  },
  updates: {
    title: "server.settings.updatesTitle",
    description: "server.settings.updatesDescription",
    keywords: "settings.search.keywords.updates",
    icon: RefreshCw,
  },
  import: {
    title: "server.settings.importTitle",
    description: "server.settings.importDescription",
    keywords: "settings.search.keywords.import",
    icon: Download,
  },
  transfer: {
    title: "server.settings.transferTitle",
    description: "server.settings.transferDescription",
    keywords: "settings.search.keywords.transfer",
    icon: ArrowLeftRight,
  },
  routines: {
    title: "server.settings.routinesTitle",
    description: "server.settings.routinesDescription",
    keywords: "settings.search.keywords.routineFeed",
    icon: CalendarClock,
  },
  "browser-profiles": {
    title: "browser.profiles.title",
    description: "browser.profiles.subtitle",
    keywords: "settings.search.keywords.browserProfiles",
    icon: AppWindow,
  },
} as const satisfies Record<
  ServerSettingsSection,
  { title: AppTextKey; description: AppTextKey; keywords: AppTextKey; icon: typeof Settings }
>;

/** The host answers admin calls only while it is this computer or online. */
function actionsAvailable(server: ServerSummary): boolean {
  return server.kind === "local" || server.state === "online";
}

/**
 * Whether the settings of `server` show the section. The settings overlay gives a section its
 * options only when this is true, and the search lists only these sections, so the two cannot
 * disagree. For Roles on this computer, the search also reads the host status (`SECTION_SHOWN`).
 */
export function serverSettingsSectionShown(
  section: ServerSettingsSection,
  server: ServerSummary,
  platform: AppInfo["platform"] | undefined,
): boolean {
  switch (section) {
    case "general":
    case "members":
      return true;
    case "vault":
      return serverCanAdminister(server, VAULT_CAPABILITY);
    case "roles":
      return serverCanAdminister(server, AGENT_ACCESS_CAPABILITY) && actionsAvailable(server);
    case "desktop":
      return platform === "darwin";
    case "mcp":
      return serverCanAdminister(server, MCP_SERVERS_CAPABILITY);
    case "storage":
      return serverHasStorage(server);
    case "sites":
      return serverSupportsCapability(server, "hosted-sites-v1");
    case "providers":
      return activeServerHasProviderSettings(server);
    case "updates":
      return remoteUpdateServer(server) !== undefined;
    case "import":
      return serverSupportsCapability(server, "agent-import-v1");
    case "transfer":
      return server.kind === "local" || serverCanAdminister(server, "instance-transfer-v1");
    case "routines":
      return server.kind === "local";
    case "browser-profiles":
      return serverCanAdminister(server, BROWSER_PROFILES_CAPABILITY);
  }
}

/**
 * What the server settings read besides the server: the platform of this computer and the status of
 * its host. Roles and the server key show for this computer only after its host was set up or published.
 */
export interface ServerSettingsSearchContext {
  platform: AppInfo["platform"] | undefined;
  host: Pick<HostStatus, "configured" | "phase"> | null;
  /**
   * The hosted servers of the account, or null until they load. Billing deletes a hosted server, so
   * General offers Remove only for a server that is not in this list.
   */
  hostedServerIds: ReadonlySet<string> | null;
  /** False where the settings cannot leave a server, such as the web client, which stays on one host. */
  canLeave: boolean;
}

/**
 * A search entry of the server settings: a section, or a row of General. A row has an anchor: its
 * markup sets `data-settings-row` to it, so a result can move to the row.
 */
export interface ServerSettingsSearchEntry extends SettingsSearchKeys {
  section: ServerSettingsSection;
  anchor?: AppTextKey;
  /** False when the dialog does not show the entry for this server, as `ServerSettingsModal` decides. */
  shown?: (server: ServerSummary, context: ServerSettingsSearchContext) => boolean;
}

/** The dialog shows Roles for this computer only after its host was set up (`configured`). */
const SECTION_SHOWN: Partial<Record<ServerSettingsSection, ServerSettingsSearchEntry["shown"]>> = {
  roles: (server, context) => server.kind !== "local" || context.host?.configured === true,
};

/** The rows of General, in page order. `ServerGeneralSection.tsx` has the same rules. */
const GENERAL_ROWS: ReadonlyArray<ServerSettingsSearchEntry> = [
  {
    section: "general",
    anchor: "server.settings.name",
    titleKey: "server.settings.name",
    descriptionKey: "server.settings.nameDescription",
    keywordsKey: "settings.search.keywords.serverName",
  },
  {
    section: "general",
    anchor: "server.settings.logo",
    titleKey: "server.settings.logo",
    descriptionKey: "server.settings.logoDescription",
    keywordsKey: "settings.search.keywords.serverLogo",
  },
  {
    section: "general",
    anchor: "server.settings.timezone",
    titleKey: "server.settings.timezone",
    descriptionKey: "server.settings.timezoneDescription",
    keywordsKey: "settings.search.keywords.timezone",
    shown: (server) => serverCanAdminister(server, "host-timezone-v1") && actionsAvailable(server),
  },
  {
    section: "general",
    anchor: "server.settings.memoryLimit",
    titleKey: "server.settings.memoryLimit",
    descriptionKey: "server.settings.memoryLimitDescription",
    keywordsKey: "settings.search.keywords.memory",
    shown: (server) => serverCanAdminister(server, "agent-memory-limit-v1") && actionsAvailable(server),
  },
  {
    section: "general",
    anchor: "server.settings.memoryReview",
    titleKey: "server.settings.memoryReview",
    descriptionKey: "server.settings.memoryReviewDescription",
    keywordsKey: "settings.search.keywords.memory",
    shown: (server) => serverCanAdminister(server, "memory-review-v1") && actionsAvailable(server),
  },
  {
    section: "general",
    anchor: "server.settings.hostKeyRotate",
    titleKey: "server.settings.hostKeyRotate",
    descriptionKey: "server.settings.hostKeyDescription",
    keywordsKey: "settings.search.keywords.hostKey",
    // Only a published host has a key to change.
    shown: (server, context) => server.kind === "local" && context.host?.phase === "online",
  },
  {
    section: "general",
    anchor: "server.settings.leaveTitle",
    titleKey: "server.settings.leaveTitle",
    descriptionKey: "server.settings.leaveDescription",
    keywordsKey: "settings.search.keywords.leaveServer",
    shown: (server, context) => context.canLeave && server.kind === "remote" && server.role !== "owner",
  },
  {
    section: "general",
    anchor: "server.settings.removeTitle",
    titleKey: "server.settings.removeTitle",
    descriptionKey: "server.settings.removeDescription",
    keywordsKey: "settings.search.keywords.removeServer",
    // Billing deletes a hosted server, so the dialog offers Remove only for another server.
    shown: (server, context) =>
      server.kind === "remote" &&
      server.role === "owner" &&
      context.hostedServerIds !== null &&
      !context.hostedServerIds.has(server.id),
  },
];

/**
 * The place of each entry of the server settings: "server" names it, so "cofre do servidor" finds the
 * Vault section and "servidor" finds each section, also in the user settings.
 */
const SERVER_SCOPE: AppTextKey = "settings.search.keywords.server";

/**
 * Each section in the order of the section list, then the rows of General. A query that names only
 * the server finds the sections before the rows.
 */
export const SERVER_SETTINGS_SEARCH: ReadonlyArray<ServerSettingsSearchEntry> = [
  ...SERVER_SETTINGS_SECTION_LIST.map(
    (section): ServerSettingsSearchEntry => ({
      section,
      titleKey: SERVER_SETTINGS_SECTIONS[section].title,
      descriptionKey: SERVER_SETTINGS_SECTIONS[section].description,
      keywordsKey: SERVER_SETTINGS_SECTIONS[section].keywords,
      scopeKey: SERVER_SCOPE,
      shown: SECTION_SHOWN[section],
    }),
  ),
  ...GENERAL_ROWS.map((row) => ({ ...row, scopeKey: SERVER_SCOPE })),
];

/** Whether the settings of `server` show the entry: its section, and for a row of General, the row. */
export function serverSettingsEntryShown(
  entry: ServerSettingsSearchEntry,
  server: ServerSummary,
  context: ServerSettingsSearchContext,
): boolean {
  return (
    serverSettingsSectionShown(entry.section, server, context.platform) && (entry.shown?.(server, context) ?? true)
  );
}
