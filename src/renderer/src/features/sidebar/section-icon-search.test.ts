import { isSidebarSectionEmoji, SIDEBAR_SECTION_GLYPHS } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { SECTION_EMOJI_DATA } from "../../../../../packages/ui/src/features/sidebar/section-emoji-data";
import { SECTION_ICON_LIBRARY_DATA } from "../../../../../packages/ui/src/features/sidebar/section-icon-library-data";
import {
  parseSectionIconRecents,
  withRecentSectionIcon,
} from "../../../../../packages/ui/src/features/sidebar/section-icon-recents";
import {
  foldSectionSearchText,
  parseSectionEmojiData,
  SECTION_EMOJI_CATEGORIES,
  SECTION_EMOJI_TONES,
  SECTION_ICON_CATEGORIES,
  searchSectionPicker,
  sectionEmojiIndex,
  sectionEmojiWithTone,
  sectionIconEntries,
} from "../../../../../packages/ui/src/features/sidebar/section-icon-search";

const icons = sectionIconEntries(SECTION_ICON_LIBRARY_DATA);
const emoji = parseSectionEmojiData(SECTION_EMOJI_DATA);
const glyphsFor = (query: string, category: string | null = null) =>
  searchSectionPicker(icons, query, category).map((entry) => entry.glyph);
const emojiFor = (query: string) => searchSectionPicker(emoji, query, null).map((entry) => entry.emoji);

describe("the icon library", () => {
  it("has a drawing entry for each stored glyph name, in the same order", () => {
    expect(icons.map((entry) => entry.glyph)).toEqual([...SIDEBAR_SECTION_GLYPHS]);
    expect(icons.length).toBeGreaterThan(400);
    for (const category of SECTION_ICON_CATEGORIES) {
      expect(
        icons.some((entry) => entry.category === category),
        category,
      ).toBe(true);
    }
  });
});

describe("the icon search", () => {
  it("finds a name or a keyword in Portuguese or English, with or without accents", () => {
    for (const query of ["segurança", "seguranca", "SEGURANÇA", "security", "  Segur "]) {
      expect(glyphsFor(query)[0], query).toBe("shield");
    }
    expect(glyphsFor("foguete")).toContain("rocket");
    expect(glyphsFor("fogu")).toContain("rocket");
    expect(glyphsFor("gráfico pizza")).toEqual(["chart-pie"]);
    expect(glyphsFor("chart-pie")).toContain("chart-pie");
  });

  it("puts a name match before a keyword match", () => {
    const results = glyphsFor("cadeado");
    expect(results[0]).toBe("lock");
  });

  it("searches every category, and an empty query shows one category or all", () => {
    expect(glyphsFor("pizza", "code")).toContain("pizza");
    const food = searchSectionPicker(icons, "", "food");
    expect(food.length).toBeGreaterThan(10);
    expect(food.every((entry) => entry.category === "food")).toBe(true);
    expect(glyphsFor("", null)).toHaveLength(icons.length);
  });

  it("finds nothing for a word that no icon has", () => {
    expect(glyphsFor("xyzzy")).toEqual([]);
    expect(glyphsFor("rocket xyzzy")).toEqual([]);
  });

  it("folds case, accents and signs", () => {
    expect(foldSectionSearchText("  Copo d'Água! ")).toBe("copo d agua");
    expect(foldSectionSearchText("ÇÃO")).toBe("cao");
  });
});

describe("the emoji list", () => {
  it("has each category, and each emoji and skin tone is a valid stored emoji", () => {
    expect(emoji.length).toBeGreaterThan(1800);
    for (const category of SECTION_EMOJI_CATEGORIES) {
      expect(
        emoji.some((entry) => entry.category === category),
        category,
      ).toBe(true);
    }
    for (const entry of emoji) {
      expect(isSidebarSectionEmoji(entry.emoji), entry.en).toBe(true);
      if (!entry.skin) continue;
      for (const tone of SECTION_EMOJI_TONES) {
        expect(isSidebarSectionEmoji(sectionEmojiWithTone(entry.emoji, tone)), `${entry.en} ${tone}`).toBe(true);
      }
    }
  });

  it("finds an emoji in Portuguese or English, with or without accents", () => {
    expect(emojiFor("coração vermelho")[0]).toBe("❤️");
    expect(emojiFor("coracao")).toContain("❤️");
    expect(emojiFor("red heart")[0]).toBe("❤️");
    expect(emojiFor("bandeira brasil")).toEqual(["🇧🇷"]);
    expect(emojiFor("foguete")[0]).toBe("🚀");
    expect(emojiFor("computador").length).toBeGreaterThan(0);
    expect(emojiFor("xyzzy")).toEqual([]);
  });

  it("puts the skin tone after each person or hand", () => {
    expect(sectionEmojiWithTone("👩‍💻", 3)).toBe("👩🏽‍💻");
    expect(sectionEmojiWithTone("☝️", 5)).toBe("☝🏿");
    expect(sectionEmojiWithTone("👍️", 1)).toBe("👍🏻");
    expect(sectionEmojiWithTone("🕵️‍♀️", 2)).toBe("🕵🏼‍♀️");
    expect(sectionEmojiWithTone("👍️", 0)).toBe("👍️");
    expect(sectionEmojiWithTone("🚀", 4)).toBe("🚀");
  });

  it("finds the entry of an emoji with a tone", () => {
    const index = sectionEmojiIndex(emoji);
    expect(index.get("👩🏽‍💻")?.en).toBe("woman technologist");
    expect(index.get("🇧🇷")?.pt).toBe("bandeira: Brasil");
  });
});

describe("the recent icons", () => {
  it("put the newest first, once, and keep one row", () => {
    expect(withRecentSectionIcon(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(withRecentSectionIcon(["a", "b", "c", "d", "e", "f", "g", "h"], "z")).toEqual([
      "z",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
  });

  it("leave out a stored value that is not a glyph name or one emoji", () => {
    expect(
      parseSectionIconRecents(
        JSON.stringify({ glyphs: ["rocket", "skull", 7, "<svg>"], emoji: ["🚀", "ab", "<img>", "👩🏽‍💻"] }),
      ),
    ).toEqual({ glyphs: ["rocket"], emoji: ["🚀", "👩🏽‍💻"] });
    expect(parseSectionIconRecents("{")).toEqual({ glyphs: [], emoji: [] });
    expect(parseSectionIconRecents(null)).toEqual({ glyphs: [], emoji: [] });
    expect(parseSectionIconRecents(JSON.stringify({ glyphs: "rocket" }))).toEqual({ glyphs: [], emoji: [] });
  });
});
