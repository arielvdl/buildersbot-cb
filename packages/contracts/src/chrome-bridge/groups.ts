/**
 * The tab group of a project in the person's Chrome: its title and its color. The app computes them;
 * the extension applies them again before each `tabGroups.update`, so a title that reaches it by
 * another way is also clean.
 */

/** The colors of `chrome.tabGroups.Color`. */
export const TAB_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;
export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

/** Grey means "no agent acts here": stopped, paused, quarantined or shared. No project gets it. */
export const PAUSED_GROUP_COLOR: TabGroupColor = "grey";

/** The colors a project can have, with the hue that a section color maps to. */
const PROJECT_COLOR_HUES: readonly { readonly color: Exclude<TabGroupColor, "grey">; readonly hue: number }[] = [
  { color: "red", hue: 0 },
  { color: "orange", hue: 30 },
  { color: "yellow", hue: 55 },
  { color: "green", hue: 120 },
  { color: "cyan", hue: 185 },
  { color: "blue", hue: 220 },
  { color: "purple", hue: 275 },
  { color: "pink", hue: 330 },
];

export const PROJECT_GROUP_COLORS: readonly Exclude<TabGroupColor, "grey">[] = PROJECT_COLOR_HUES.map(
  (entry) => entry.color,
);

/** The longest title the tab strip shows well. A longer one ends with "…". */
export const MAX_GROUP_TITLE = 40;

// Controls, line and paragraph separators, and the bidi controls (marks, embeddings, overrides and
// isolates), which can make a title read as another one.
const UNSAFE_TITLE_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu;

/**
 * The title of a project group: the project name only, with no product prefix, normalized to NFC,
 * with no control or direction characters, on one line, and at most `MAX_GROUP_TITLE` characters.
 */
export function projectGroupTitle(name: string): string {
  const clean = name.normalize("NFC").replace(UNSAFE_TITLE_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  const characters = [...clean];
  if (characters.length <= MAX_GROUP_TITLE) return clean;
  return `${characters
    .slice(0, MAX_GROUP_TITLE - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * The titles of several projects in one profile. Two projects with the same title get " (2)", " (3)"
 * in the order given, so the person can tell the groups apart. A group of the person never collides:
 * the extension knows its own groups by id, not by title.
 */
export function distinctGroupTitles(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const title = projectGroupTitle(name);
    const count = (seen.get(title) ?? 0) + 1;
    seen.set(title, count);
    if (count === 1) return title;
    const suffix = ` (${count})`;
    return `${[...title]
      .slice(0, MAX_GROUP_TITLE - suffix.length)
      .join("")
      .trimEnd()}${suffix}`;
  });
}

/**
 * The group color for a sidebar section color `#rrggbb`: the project color with the nearest hue. A
 * color with saturation below 0.15 has no clear hue, and gives null; the hash rule applies then.
 */
export function groupColorForHex(hex: string): Exclude<TabGroupColor, "grey"> | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (!match) return null;
  const [red, green, blue] = [match[1], match[2], match[3]].map((part) => Number.parseInt(part ?? "0", 16) / 255);
  if (red === undefined || green === undefined || blue === undefined) return null;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (saturation < 0.15) return null;
  let hue =
    max === red ? ((green - blue) / delta) % 6 : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  let best = PROJECT_COLOR_HUES[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of PROJECT_COLOR_HUES) {
    const distance = Math.min(Math.abs(hue - entry.hue), 360 - Math.abs(hue - entry.hue));
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best?.color ?? null;
}

/**
 * The group color of a project with no section color: the first byte of SHA-256 of its project key,
 * modulo 8. When another of our groups in the same window has it, the next free color; when all are
 * taken, the hashed one.
 */
export function groupColorForHash(
  firstDigestByte: number,
  usedInWindow: readonly TabGroupColor[] = [],
): Exclude<TabGroupColor, "grey"> {
  const start = Math.abs(Math.trunc(firstDigestByte)) % PROJECT_GROUP_COLORS.length;
  for (let step = 0; step < PROJECT_GROUP_COLORS.length; step += 1) {
    const color = PROJECT_GROUP_COLORS[(start + step) % PROJECT_GROUP_COLORS.length];
    if (color && !usedInWindow.includes(color)) return color;
  }
  return PROJECT_GROUP_COLORS[start] ?? "blue";
}
