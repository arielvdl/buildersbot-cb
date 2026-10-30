/**
 * The background color of a section box. The layout stores `#rrggbb` or no color; the box shows the
 * color as a light tint over the sidebar (`sidebar-section-color.css`), so text keeps its contrast in
 * the light and the dark theme. The color names are the agent color names.
 */

import {
  isSidebarSectionColor,
  normalizeSidebarSectionColor,
  type SidebarLayoutAction,
  type SidebarSection,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";

export interface SidebarSectionColorPreset {
  color: string;
  label: AppTextKey;
}

/** Mid-tone colors: at the tint strength, each one shows on the light and on the dark sidebar. */
export const SIDEBAR_SECTION_COLOR_PRESETS: readonly SidebarSectionColorPreset[] = [
  { color: "#ef4444", label: "agent.color.red" },
  { color: "#f97316", label: "agent.color.orange" },
  { color: "#eab308", label: "agent.color.yellow" },
  { color: "#84cc16", label: "agent.color.lime" },
  { color: "#22c55e", label: "agent.color.green" },
  { color: "#06b6d4", label: "agent.color.cyan" },
  { color: "#3b82f6", label: "agent.color.blue" },
  { color: "#6366f1", label: "agent.color.indigo" },
  { color: "#a855f7", label: "agent.color.violet" },
  { color: "#ec4899", label: "agent.color.magenta" },
];

/** The radio value of "No color" in the color menu. It is not a color, so no stored value can match it. */
export const SIDEBAR_SECTION_NO_COLOR = "none";

/** The custom picker starts on this color when the section has none. */
const DEFAULT_PICKER_COLOR = "#3b82f6";

/**
 * The inline style that gives the box its color. Empty for no color, and for any value that is not a
 * stored `#rrggbb`: the value goes into a style attribute, so nothing else may reach it.
 */
export function sidebarSectionColorStyle(color: string | undefined): string {
  return isSidebarSectionColor(color) ? `--sidebar-section-color: ${color};` : "";
}

/** True for a stored color that is not one of the presets. The menu then shows it as "Custom". */
export function isCustomSidebarSectionColor(color: string | undefined): color is string {
  return isSidebarSectionColor(color) && !SIDEBAR_SECTION_COLOR_PRESETS.some((preset) => preset.color === color);
}

/** The color the custom picker opens on. */
export function sidebarSectionPickerColor(color: string | undefined): string {
  return isSidebarSectionColor(color) ? color : DEFAULT_PICKER_COLOR;
}

/**
 * The layout action for a choice in the color control. Null when the choice changes nothing or is
 * not a `#rrggbb` color, so the control sends no request for it.
 */
export function sidebarSectionColorAction(
  section: SidebarSection,
  color: string | null,
): Extract<SidebarLayoutAction, { type: "set-section-color" }> | null {
  const next = color === null ? null : normalizeSidebarSectionColor(color);
  if (color !== null && next === null) return null;
  if ((section.color ?? null) === next) return null;
  return { type: "set-section-color", sectionId: section.id, color: next };
}
