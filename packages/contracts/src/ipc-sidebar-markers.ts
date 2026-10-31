import { isDynamicRecord, isOneOf, isString } from "./runtime-values";

/**
 * A marker in a section of the chat list: a thin line with a short text, such as "Done". The chats
 * below it, up to the next marker of the section, take its style. Only the local layout keeps markers:
 * no released Team API protocol carries `markers` or `itemOrder`, and each frozen codec drops them, so
 * a remote peer sees the chats in their order and no marker.
 */
export interface SidebarMarker {
  /** `marker:` and a UUID, so a marker id can never be the id of an agent or a channel. */
  id: string;
  /** The custom section, or null for the chats with no section. */
  sectionId: string | null;
  /** Plain text, at most `SIDEBAR_MARKER_LIMITS.label` characters. It can be empty. */
  label: string;
  style: SidebarMarkerStyle;
  /** `#rrggbb` in lower case, only with the `tint` style. */
  color?: string;
}

/** What the chats below a marker look like: as usual, dimmed, black and white, or tinted with a color. */
export const SIDEBAR_MARKER_STYLES = ["normal", "dim", "grayscale", "tint"] as const;
export type SidebarMarkerStyle = (typeof SIDEBAR_MARKER_STYLES)[number];

export const SIDEBAR_MARKER_LIMITS = {
  label: 40,
  perSection: 12,
} as const;

export const SIDEBAR_MARKER_ID_PREFIX = "marker:";

const MARKER_ID = /^marker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MARKER_COLOR = /^#[0-9a-f]{6}$/;
const MARKER_COLOR_INPUT = /^#[0-9a-f]{6}$/i;
// No control characters: the label is one line of plain text.
const CONTROL = /\p{Cc}/u;

export function isSidebarMarkerId(value: unknown): value is string {
  return isString(value) && MARKER_ID.test(value);
}

export function isSidebarMarkerLabel(value: unknown): value is string {
  return (
    isString(value) && value === value.trim() && value.length <= SIDEBAR_MARKER_LIMITS.label && !CONTROL.test(value)
  );
}

export function isSidebarMarker(value: unknown): value is SidebarMarker {
  if (!isDynamicRecord(value)) return false;
  const known = ["id", "sectionId", "label", "style", "color"];
  if (Object.keys(value).some((key) => !known.includes(key))) return false;
  if (!isSidebarMarkerId(value.id) || !isSidebarMarkerLabel(value.label)) return false;
  if (value.sectionId !== null && !isString(value.sectionId)) return false;
  if (!isString(value.style) || !isOneOf(SIDEBAR_MARKER_STYLES, value.style)) return false;
  if (value.style === "tint") return isString(value.color) && MARKER_COLOR.test(value.color);
  return value.color === undefined;
}

/**
 * The fields of a marker in their stored form: the label without the spaces around it, and a color only
 * with `tint`, in lower case. Null when a field is not valid, such as a long label or a tint without a
 * `#rrggbb` color.
 */
export function normalizeSidebarMarkerFields(input: {
  label: unknown;
  style: unknown;
  color: unknown;
}): Pick<SidebarMarker, "label" | "style" | "color"> | null {
  if (!isString(input.label) || !isString(input.style) || !isOneOf(SIDEBAR_MARKER_STYLES, input.style)) return null;
  const label = input.label.trim();
  if (!isSidebarMarkerLabel(label)) return null;
  if (input.style !== "tint")
    return input.color === null || input.color === undefined ? { label, style: input.style } : null;
  if (!isString(input.color) || !MARKER_COLOR_INPUT.test(input.color)) return null;
  return { label, style: "tint", color: input.color.toLowerCase() };
}
