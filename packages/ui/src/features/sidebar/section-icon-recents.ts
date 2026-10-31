/**
 * The recent glyphs and emoji of the section icon picker, and the skin tone of its emoji. They are a
 * convenience of this browser profile, so they stay in `localStorage`. Each read checks each value,
 * so a changed or broken entry is left out. Storage that throws (blocked, or full) gives no recents.
 */

import { isSidebarSectionEmoji, SIDEBAR_SECTION_GLYPHS, type SidebarSectionGlyph } from "@openbot/contracts/ipc";
import { isDynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";
import { createSignal } from "solid-js";
import type { SectionEmojiTone } from "./section-icon-search";

const RECENT_KEY = "openbot.sidebar.sectionIcon.recent";
const TONE_KEY = "openbot.sidebar.sectionIcon.skinTone";
/** One row of the grid. */
const SECTION_ICON_RECENT_LIMIT = 8;

interface StoredRecents {
  glyphs: SidebarSectionGlyph[];
  emoji: string[];
}

/** `value` first, without an earlier copy, and at most `limit` values. */
export function withRecentSectionIcon<T>(list: readonly T[], value: T, limit = SECTION_ICON_RECENT_LIMIT): T[] {
  return [value, ...list.filter((item) => item !== value)].slice(0, limit);
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is blocked or full: the recents stay for this session only.
  }
}

/** The recents in a stored text. Values that are not a glyph name or one emoji are left out. */
export function parseSectionIconRecents(text: string | null): StoredRecents {
  let value: unknown = null;
  try {
    value = text === null ? null : JSON.parse(text);
  } catch {
    value = null;
  }
  const list = (key: string): unknown[] => {
    const items = isDynamicRecord(value) ? value[key] : undefined;
    return Array.isArray(items) ? items : [];
  };
  return {
    glyphs: list("glyphs")
      .filter((item): item is SidebarSectionGlyph => typeof item === "string" && isOneOf(SIDEBAR_SECTION_GLYPHS, item))
      .slice(0, SECTION_ICON_RECENT_LIMIT),
    emoji: list("emoji").filter(isSidebarSectionEmoji).slice(0, SECTION_ICON_RECENT_LIMIT),
  };
}

function parseTone(text: string | null): SectionEmojiTone {
  const tone = Number(text);
  return tone === 1 || tone === 2 || tone === 3 || tone === 4 || tone === 5 ? tone : 0;
}

const [recents, setRecents] = createSignal<StoredRecents | null>(null);
const [tone, setToneSignal] = createSignal<SectionEmojiTone | null>(null);

/** The recents, read from storage the first time. */
export function sectionIconRecents(): StoredRecents {
  return recents() ?? parseSectionIconRecents(readStorage(RECENT_KEY));
}

export function rememberSectionIcon(
  icon: { kind: "glyph"; glyph: SidebarSectionGlyph } | { kind: "emoji"; emoji: string },
): void {
  const current = sectionIconRecents();
  const next: StoredRecents =
    icon.kind === "glyph"
      ? { ...current, glyphs: withRecentSectionIcon(current.glyphs, icon.glyph) }
      : { ...current, emoji: withRecentSectionIcon(current.emoji, icon.emoji) };
  setRecents(() => next);
  writeStorage(RECENT_KEY, JSON.stringify(next));
}

export function sectionEmojiTone(): SectionEmojiTone {
  return tone() ?? parseTone(readStorage(TONE_KEY));
}

export function setSectionEmojiTone(value: SectionEmojiTone): void {
  setToneSignal(value);
  writeStorage(TONE_KEY, String(value));
}
