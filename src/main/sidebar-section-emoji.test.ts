// @vitest-environment node
import {
  isSidebarLayoutSnapshot,
  isSidebarSectionEmoji,
  isSidebarSectionIcon,
  normalizeSidebarSectionIcon,
  SIDEBAR_SECTION_GLYPHS,
  SIDEBAR_SECTION_ICON_LIMITS,
} from "@openbot/contracts/ipc";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import { describe, expect, it } from "vitest";
import { parseSidebarLayoutAction } from "./ipc/agent-inputs";
import { decodeSidebarLayoutSnapshot } from "./remote-agent-decoding";

const SECTION_ID = "11111111-1111-4111-8111-111111111111";
const RELEASED_PROTOCOLS = [1, 3, 4, 5, 6, 7, 8];

function layout(icon?: unknown) {
  return {
    revision: 3,
    sections: [{ id: SECTION_ID, name: "Naia", ...(icon === undefined ? {} : { icon }) }],
    order: ["people", SECTION_ID, "unassigned"],
    agentAssignments: { "agent-one": SECTION_ID },
    agentOrder: ["agent-one"],
  };
}

describe("an emoji section icon", () => {
  it("is one emoji: a sequence with a skin tone, a ZWJ sequence, a flag or a keycap", () => {
    for (const emoji of ["👩🏽‍💻", "🏳️‍🌈", "❤️", "❤️‍🔥", "😀", "🇧🇷", "#️⃣", "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "🧑🏻‍🤝‍🧑🏿", "👨‍👩‍👧‍👦", "🫶🏾"]) {
      expect(isSidebarSectionEmoji(emoji), emoji).toBe(true);
      expect(isSidebarSectionIcon({ kind: "emoji", emoji })).toBe(true);
    }
  });

  it("refuses text, markup, two emoji and a long string", () => {
    const long = `${"👩‍".repeat(11)}👩`;
    expect(long.length).toBeGreaterThan(SIDEBAR_SECTION_ICON_LIMITS.emojiUnits);
    for (const value of [
      "ab",
      "A",
      "7",
      "",
      " ",
      "hello",
      "<img>",
      "<img src=x onerror=alert(1)>",
      "<svg onload=alert(1)>",
      "😀😀",
      "😀a",
      " 😀",
      "😀\n",
      "‍",
      "x".repeat(100),
      long,
      7,
      null,
    ]) {
      expect(isSidebarSectionEmoji(value), String(value)).toBe(false);
      expect(isSidebarSectionIcon({ kind: "emoji", emoji: value })).toBe(false);
    }
  });

  it("has exactly the kind and the emoji", () => {
    expect(isSidebarSectionIcon({ kind: "emoji", text: "🚀" })).toBe(false);
    expect(isSidebarSectionIcon({ kind: "emoji", emoji: "🚀", color: "#ffffff" })).toBe(false);
    expect(normalizeSidebarSectionIcon({ kind: "emoji", emoji: "🚀" })).toEqual({ kind: "emoji", emoji: "🚀" });
    expect(normalizeSidebarSectionIcon({ kind: "emoji", emoji: "ab" })).toBeNull();
  });
});

describe("a glyph of the icon library", () => {
  it("is a name of the fixed table", () => {
    expect(SIDEBAR_SECTION_GLYPHS.length).toBeGreaterThan(400);
    expect(new Set(SIDEBAR_SECTION_GLYPHS).size).toBe(SIDEBAR_SECTION_GLYPHS.length);
    for (const glyph of ["rocket", "chart-pie", "shield", "bot"]) {
      expect(isSidebarSectionIcon({ kind: "glyph", glyph })).toBe(true);
    }
    for (const glyph of ["skull", "Rocket", "<svg>", "lucide-solid/icons/rocket", ""]) {
      expect(isSidebarSectionIcon({ kind: "glyph", glyph })).toBe(false);
    }
  });
});

describe("a stored section icon", () => {
  it("is never markup or an SVG, whatever the kind", () => {
    const attempts = [
      { kind: "emoji", emoji: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
      { kind: "glyph", glyph: "<svg/>" },
      { kind: "letter", text: "<s" },
      { kind: "image", dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" },
      { kind: "svg", svg: "<svg/>" },
    ];
    for (const icon of attempts) {
      const stored = normalizeSidebarSectionIcon(icon);
      expect(JSON.stringify(stored ?? "")).not.toMatch(/<svg|svg\+xml/i);
    }
  });
});

describe("the set-section-icon action with an emoji", () => {
  it("reads one emoji and refuses anything else", () => {
    expect(
      parseSidebarLayoutAction({
        type: "set-section-icon",
        sectionId: SECTION_ID,
        icon: { kind: "emoji", emoji: "🚀" },
      }),
    ).toEqual({ type: "set-section-icon", sectionId: SECTION_ID, icon: { kind: "emoji", emoji: "🚀" } });
    for (const emoji of ["ab", "<img>", "🚀🚀", "x".repeat(40)]) {
      expect(() =>
        parseSidebarLayoutAction({ type: "set-section-icon", sectionId: SECTION_ID, icon: { kind: "emoji", emoji } }),
      ).toThrow();
    }
  });

  it("decodes in a layout, and a layout with an invalid emoji fails closed", () => {
    expect(decodeSidebarLayoutSnapshot(layout({ kind: "emoji", emoji: "🏳️‍🌈" })).sections[0]?.icon).toEqual({
      kind: "emoji",
      emoji: "🏳️‍🌈",
    });
    expect(isSidebarLayoutSnapshot(layout({ kind: "emoji", emoji: "ab" }))).toBe(false);
  });
});

describe("the released Team API sidebar layout wire", () => {
  it("does not carry an emoji or library glyph icon to any released protocol", () => {
    for (const icon of [
      { kind: "emoji", emoji: "👩🏽‍💻" },
      { kind: "glyph", glyph: "rocket" },
    ]) {
      for (const protocol of RELEASED_PROTOCOLS) {
        const codec = teamHttpCodec(protocol);
        const encoded = JSON.parse(codec.encodeResponse("GET", "/v1/sidebar-layout", 200, layout(icon), {}));
        expect(encoded.sections).toEqual([{ id: SECTION_ID, name: "Naia" }]);
        expect(isSidebarLayoutSnapshot(codec.decodeResponse("GET", "/v1/sidebar-layout", 200, encoded))).toBe(true);
      }
    }
  });

  it("refuses the set-section-icon action with an emoji from a peer of any released protocol", () => {
    const action = { type: "set-section-icon", sectionId: SECTION_ID, icon: { kind: "emoji", emoji: "🚀" } };
    for (const protocol of RELEASED_PROTOCOLS) {
      const codec = teamHttpCodec(protocol);
      expect(() => codec.decodeRequest("POST", "/v1/sidebar-layout/actions", action, {})).toThrow();
    }
  });
});
