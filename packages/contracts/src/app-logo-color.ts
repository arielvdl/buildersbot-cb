/**
 * The color the user picks for the Builders Bot logo: the Dock or taskbar icon, the Dynamic Island and
 * the logos in the app. Only a release build shows it. A dev or preview build keeps its own color,
 * so two Builders Bot apps that are open at the same time stay easy to tell apart.
 *
 * The identifiers cross the IPC boundary and are saved as written. Add a color, never rename one:
 * a renamed identifier reads back as the default on the next launch. The order is the Settings
 * order: it follows `pages/cubo.html`, the eight colorways of the cube mark.
 */
export const APP_LOGO_COLORS = [
  "noite",
  "dia",
  "signal",
  "traco",
  "papel",
  "grafite",
  "lima",
  "vidro",
] as const;

export type AppLogoColor = (typeof APP_LOGO_COLORS)[number];

/** The released brand color, `--openbot-logo-production`: the cube on ink, lime edges. */
export const DEFAULT_APP_LOGO_COLOR: AppLogoColor = "noite";

/**
 * The logo body color of each choice. The main process picks the app icon with it, and the
 * renderers set `--openbot-logo-production` to it, so the icon and the logos show the same color.
 * Every body is light enough to read on the dark canvas, because a few screens use this color as
 * an accent: `--whats-new-tone` and the first-run launch ring.
 */
export const APP_LOGO_COLOR_HEX = {
  noite: "#98f94f",
  dia: "#f2f3f5",
  signal: "#0b0d0a",
  traco: "#0b0d0a",
  papel: "#dde1d9",
  grafite: "#2a2e28",
  lima: "#7ade33",
  vidro: "#6b7168",
} as const satisfies Record<AppLogoColor, `#${string}`>;

/** The released eye color, `--openbot-logo-eye`. */
export const DEFAULT_APP_LOGO_EYE_HEX = "#0b0d0a";

/**
 * The eye color of each choice, the strokes of the mark. It is the color the icon puts on the face
 * it sits on: lime on the ink colorways, ink on the paper ones.
 */
export const APP_LOGO_EYE_HEX = {
  noite: "#0b0d0a",
  dia: "#0b0d0a",
  signal: "#98f94f",
  traco: "#f2f3f5",
  papel: "#0b0d0a",
  grafite: "#98f94f",
  lima: "#0b0d0a",
  vidro: "#f2f3f5",
} as const satisfies Record<AppLogoColor, `#${string}`>;

/** The preference as it is stored and as it crosses IPC. */
export interface AppLogoColorPreference {
  color: AppLogoColor;
}

export type SetAppLogoColorPreferenceInput = AppLogoColorPreference;

export function isAppLogoColor(value: unknown): value is AppLogoColor {
  return APP_LOGO_COLORS.some((color) => color === value);
}
