/**
 * The icon library and the emoji list of the section icon picker load with `import()`: they are their
 * own chunks, so they do not add to the start of the app. The first picker or rail mark that needs one
 * loads it once. A failed load is tried again by the next caller.
 */

import type { SidebarSectionGlyph } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";
import {
  parseSectionEmojiData,
  type SectionEmojiEntry,
  type SectionIconEntry,
  sectionEmojiIndex,
  sectionIconEntries,
} from "./section-icon-search";

type GlyphIcon = typeof import("./section-icon-library")["SECTION_ICON_COMPONENTS"][SidebarSectionGlyph];

interface SectionIconLibrary {
  entries: readonly SectionIconEntry[];
  icons: Readonly<Record<SidebarSectionGlyph, GlyphIcon>>;
}

interface SectionEmojiList {
  entries: readonly SectionEmojiEntry[];
  byEmoji: ReadonlyMap<string, SectionEmojiEntry>;
}

type SectionAssetState = "idle" | "loading" | "ready" | "failed";

const [library, setLibrary] = createSignal<SectionIconLibrary | null>(null);
const [libraryState, setLibraryState] = createSignal<SectionAssetState>("idle");
const [emojiList, setEmojiList] = createSignal<SectionEmojiList | null>(null);
const [emojiState, setEmojiState] = createSignal<SectionAssetState>("idle");

/** The icon library, or null until it loads. */
export const sectionIconLibrary = library;
export const sectionIconLibraryState = libraryState;
/** The emoji list, or null until it loads. */
export const sectionEmojiList = emojiList;
export const sectionEmojiListState = emojiState;

// Plain flags, not the signals: a signal write shows only after the next flush, and two calls in one
// task must not load twice.
let libraryLoad: "idle" | "loading" | "ready" = "idle";
let emojiLoad: "idle" | "loading" | "ready" = "idle";

export function loadSectionIconLibrary(): void {
  if (libraryLoad !== "idle") return;
  libraryLoad = "loading";
  setLibraryState("loading");
  import("./section-icon-library").then(
    (module) => {
      const value: SectionIconLibrary = {
        entries: sectionIconEntries(module.SECTION_ICON_LIBRARY_DATA),
        icons: module.SECTION_ICON_COMPONENTS,
      };
      libraryLoad = "ready";
      setLibrary(() => value);
      setLibraryState("ready");
    },
    () => {
      libraryLoad = "idle";
      setLibraryState("failed");
    },
  );
}

export function loadSectionEmojiList(): void {
  if (emojiLoad !== "idle") return;
  emojiLoad = "loading";
  setEmojiState("loading");
  import("./section-emoji-data").then(
    (module) => {
      const entries = parseSectionEmojiData(module.SECTION_EMOJI_DATA);
      const value: SectionEmojiList = { entries, byEmoji: sectionEmojiIndex(entries) };
      emojiLoad = "ready";
      setEmojiList(() => value);
      setEmojiState("ready");
    },
    () => {
      emojiLoad = "idle";
      setEmojiState("failed");
    },
  );
}
