// @vitest-environment node
import {
  isSidebarLayoutSnapshot,
  isSidebarSectionIcon,
  isSidebarSectionImage,
  normalizeSidebarSectionIcon,
  SIDEBAR_SECTION_ICON_LIMITS,
} from "@openbot/contracts/ipc";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import { describe, expect, it } from "vitest";
import { parseSidebarLayoutAction } from "./ipc/agent-inputs";
import { decodeSidebarLayoutSnapshot } from "./remote-agent-decoding";

const SECTION_ID = "11111111-1111-4111-8111-111111111111";
const RELEASED_PROTOCOLS = [1, 3, 4, 5, 6, 7, 8];

function dataUrl(type: string, bytes: Uint8Array): string {
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** The PNG signature and an IHDR chunk of this size, then zero bytes up to `length`. */
function png(width: number, height: number, length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A RIFF WebP whose first chunk is `chunk` with this body. */
function webp(chunk: "VP8X" | "VP8L" | "VP8 ", body: number[], length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from(chunk), 0, 0, 0, 0, ...body]);
  return bytes;
}

const littleEndian = (value: number, size: number) =>
  Array.from({ length: size }, (_, index) => (value >>> (8 * index)) & 0xff);

function webpExtended(width: number, height: number): Uint8Array {
  return webp("VP8X", [0, 0, 0, 0, ...littleEndian(width - 1, 3), ...littleEndian(height - 1, 3)]);
}

function webpLossless(width: number, height: number): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14);
  return webp("VP8L", [0x2f, ...littleEndian(bits, 4)]);
}

function webpLossy(width: number, height: number): Uint8Array {
  return webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...littleEndian(width, 2), ...littleEndian(height, 2)]);
}

/** A layout with one section. `icon` is any value, so a test can send one that is not valid. */
function layout(icon?: unknown) {
  return {
    revision: 3,
    sections: [{ id: SECTION_ID, name: "Naia", ...(icon === undefined ? {} : { icon }) }],
    order: ["people", SECTION_ID, "unassigned"],
    agentAssignments: { "agent-one": SECTION_ID },
    agentOrder: ["agent-one"],
  };
}

describe("a section icon", () => {
  it("is one or two characters, a known glyph, or a small PNG or WebP image", () => {
    for (const text of ["N", "AB", "🔥", "Ñ", "7"]) expect(isSidebarSectionIcon({ kind: "letter", text })).toBe(true);
    expect(isSidebarSectionIcon({ kind: "glyph", glyph: "shield" })).toBe(true);
    for (const image of [
      dataUrl("image/png", png(96, 96)),
      dataUrl("image/png", png(1, 1)),
      dataUrl("image/webp", webpExtended(96, 96)),
      dataUrl("image/webp", webpLossless(64, 40)),
      dataUrl("image/webp", webpLossy(48, 48)),
    ]) {
      expect(isSidebarSectionIcon({ kind: "image", dataUrl: image })).toBe(true);
    }
  });

  it("refuses letters that are empty, long, spaces or invisible characters", () => {
    for (const text of ["", "ABC", " ", "A ", "​", "a\n", 7, null]) {
      expect(isSidebarSectionIcon({ kind: "letter", text })).toBe(false);
    }
  });

  it("refuses an unknown glyph, an unknown kind and extra fields", () => {
    expect(isSidebarSectionIcon({ kind: "glyph", glyph: "skull" })).toBe(false);
    expect(isSidebarSectionIcon({ kind: "emoji", text: "A" })).toBe(false);
    expect(isSidebarSectionIcon({ kind: "letter", text: "A", color: "#ffffff" })).toBe(false);
    expect(isSidebarSectionIcon("N")).toBe(false);
  });

  it("refuses SVG, a remote URL, another type and a type that the bytes do not match", () => {
    for (const image of [
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
      "https://example.com/icon.png",
      "http://127.0.0.1/icon.png",
      "file:///etc/passwd",
      dataUrl("image/jpeg", png(96, 96)),
      dataUrl("image/png", webpExtended(96, 96)),
      dataUrl("image/webp", png(96, 96)),
      `${dataUrl("image/png", png(96, 96))}"onerror="x`,
      dataUrl("image/png", png(96, 96)).replace("base64,", "base64, "),
      "data:image/png;base64,iVBORw0KGgo",
    ]) {
      expect(isSidebarSectionImage(image)).toBe(false);
    }
  });

  it("refuses an image larger than 96 pixels or than the byte limit", () => {
    expect(isSidebarSectionImage(dataUrl("image/png", png(97, 96)))).toBe(false);
    expect(isSidebarSectionImage(dataUrl("image/png", png(96, 0)))).toBe(false);
    expect(isSidebarSectionImage(dataUrl("image/webp", webpExtended(4000, 4000)))).toBe(false);
    expect(isSidebarSectionImage(dataUrl("image/webp", webpLossless(200, 10)))).toBe(false);
    const limit = SIDEBAR_SECTION_ICON_LIMITS.imageBytes;
    expect(isSidebarSectionImage(dataUrl("image/png", png(96, 96, limit)))).toBe(true);
    expect(isSidebarSectionImage(dataUrl("image/png", png(96, 96, limit + 1)))).toBe(false);
  });

  it("stores a letter without the spaces around it", () => {
    expect(normalizeSidebarSectionIcon({ kind: "letter", text: "  rt " })).toEqual({ kind: "letter", text: "rt" });
    expect(normalizeSidebarSectionIcon({ kind: "letter", text: "   " })).toBeNull();
    expect(normalizeSidebarSectionIcon({ kind: "glyph", glyph: "nope" })).toBeNull();
  });
});

describe("the set-section-icon action at the renderer boundary", () => {
  it("reads an icon, and null as no icon", () => {
    expect(
      parseSidebarLayoutAction({
        type: "set-section-icon",
        sectionId: SECTION_ID,
        icon: { kind: "letter", text: " N " },
      }),
    ).toEqual({ type: "set-section-icon", sectionId: SECTION_ID, icon: { kind: "letter", text: "N" } });
    expect(parseSidebarLayoutAction({ type: "set-section-icon", sectionId: SECTION_ID, icon: null })).toEqual({
      type: "set-section-icon",
      sectionId: SECTION_ID,
      icon: null,
    });
  });

  it("refuses every other value", () => {
    for (const icon of [
      undefined,
      "N",
      { kind: "glyph", glyph: "skull" },
      { kind: "image", dataUrl: "https://example.com/icon.png" },
      { kind: "image", dataUrl: dataUrl("image/png", png(512, 512)) },
    ]) {
      expect(() => parseSidebarLayoutAction({ type: "set-section-icon", sectionId: SECTION_ID, icon })).toThrow();
    }
    expect(() =>
      parseSidebarLayoutAction({
        type: "set-section-icon",
        sectionId: "x".repeat(10_000),
        icon: { kind: "glyph", glyph: "bot" },
      }),
    ).toThrow();
  });
});

describe("a layout with a section icon", () => {
  it("decodes with and without the field", () => {
    expect(decodeSidebarLayoutSnapshot(layout()).sections[0]).toEqual({ id: SECTION_ID, name: "Naia" });
    expect(decodeSidebarLayoutSnapshot(layout({ kind: "glyph", glyph: "bot" })).sections[0]?.icon).toEqual({
      kind: "glyph",
      glyph: "bot",
    });
  });

  it("fails closed on an icon that is not valid", () => {
    for (const icon of [
      null,
      "N",
      { kind: "image", dataUrl: "https://example.com/a.png" },
      { kind: "letter", text: "" },
    ]) {
      expect(isSidebarLayoutSnapshot(layout(icon))).toBe(false);
      expect(() => decodeSidebarLayoutSnapshot(layout(icon))).toThrow();
    }
  });
});

describe("the released Team API sidebar layout wire", () => {
  it("does not carry a section icon to any released protocol", () => {
    const icon = { kind: "image", dataUrl: dataUrl("image/png", png(96, 96)) };
    for (const protocol of RELEASED_PROTOCOLS) {
      const codec = teamHttpCodec(protocol);
      const encoded = JSON.parse(codec.encodeResponse("GET", "/v1/sidebar-layout", 200, layout(icon), {}));
      expect(encoded.sections).toEqual([{ id: SECTION_ID, name: "Naia" }]);
      expect(isSidebarLayoutSnapshot(codec.decodeResponse("GET", "/v1/sidebar-layout", 200, encoded))).toBe(true);
    }
  });

  it("refuses the set-section-icon action from a peer of any released protocol", () => {
    const action = { type: "set-section-icon", sectionId: SECTION_ID, icon: { kind: "glyph", glyph: "bot" } };
    for (const protocol of RELEASED_PROTOCOLS) {
      const codec = teamHttpCodec(protocol);
      expect(() => codec.decodeRequest("POST", "/v1/sidebar-layout/actions", action, {})).toThrow();
      expect(() => codec.encodeRequest("POST", "/v1/sidebar-layout/actions", action, {})).toThrow();
    }
  });
});
