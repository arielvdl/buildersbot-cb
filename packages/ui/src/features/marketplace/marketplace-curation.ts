import type { AppProfile } from "@openbot/contracts/app-profile";
import type { MarketplaceApp } from "./marketplace-model";

/**
 * The apps that the Apps tab lists before "Show all apps" when no organization profile applies.
 * The owner chose them on 2026-10-31. The other apps stay in the catalog: "Show all apps", the
 * search and a link still reach each one.
 */
export const DEFAULT_SHOWN_APP_IDS: readonly string[] = [
  // Coding
  "github",
  // Productivity
  "slack",
  "telegram",
  "whatsapp",
  "trello",
  "obsidian",
  "notion",
  "atlassian",
  "apple-apps",
  "discord",
  "onepassword",
  // Research
  "context7",
  // Automation
  "playwright",
];

const DEFAULT_SHOWN = new Set(DEFAULT_SHOWN_APP_IDS);

/**
 * Which apps the Apps tab lists. The client keeps the choice and the profile; the view only reads
 * them. Absent from the model: the tab lists every app.
 */
export interface MarketplaceAppCuration {
  /** The app profile of the signed-in organization. Null: the default list applies. */
  profile: () => AppProfile | null;
  /** The user chose to see every app. The client keeps the choice. */
  showAll: () => boolean;
  setShowAll: (show: boolean) => void;
}

export interface CuratedApps {
  /** The apps of the list, in the order of `apps`. */
  shown: MarketplaceApp[];
  /** How many apps the list does not show. */
  hidden: number;
  /** The profile that chose the list. Null when the default list applies or every app shows. */
  profile: AppProfile | null;
}

/**
 * The user has the app: a server that the user added, or an app that is connected, connecting or
 * partly set up. The list always shows it, so a curated list never takes away an app in use.
 */
function inUse(app: MarketplaceApp): boolean {
  return app.kind === "custom" || app.status !== "idle";
}

function profileShows(profile: AppProfile, app: MarketplaceApp): boolean {
  if (app.kind === "custom" || profile.apps.hide.includes(app.id)) return false;
  return profile.apps.show.includes(app.id) || profile.categories.includes(app.category);
}

/**
 * The apps that the Apps tab lists. With `showAll`, every app. Otherwise each app in use, and the
 * apps that the profile shows, or the default apps when there is no profile. A profile that names no
 * app of this catalog does not apply, and a list that would be empty shows every app: the tab is
 * never empty while the catalog has apps.
 */
export function curateApps(apps: readonly MarketplaceApp[], profile: AppProfile | null, showAll: boolean): CuratedApps {
  if (showAll) return { shown: [...apps], hidden: 0, profile: null };
  const applies = profile !== null && apps.some((app) => profileShows(profile, app)) ? profile : null;
  const shown = apps.filter((app) => inUse(app) || (applies ? profileShows(applies, app) : DEFAULT_SHOWN.has(app.id)));
  if (shown.length === 0) return { shown: [...apps], hidden: 0, profile: null };
  return { shown, hidden: apps.length - shown.length, profile: applies };
}
