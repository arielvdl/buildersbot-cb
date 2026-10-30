// @vitest-environment node
import { isSidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import { describe, expect, it } from "vitest";
import { parseSidebarLayoutAction } from "./ipc/agent-inputs";
import { decodeSidebarLayoutSnapshot } from "./remote-agent-decoding";

const SECTION_ID = "11111111-1111-4111-8111-111111111111";
const RELEASED_PROTOCOLS = [1, 3, 4, 5, 6, 7, 8];

/** A layout with one section. `color` is any value, so a test can send one that is not valid. */
function layout(color?: unknown) {
  return {
    revision: 3,
    sections: [{ id: SECTION_ID, name: "Core team", ...(color === undefined ? {} : { color }) }],
    order: ["people", SECTION_ID, "unassigned"],
    agentAssignments: { "agent-one": SECTION_ID },
    agentOrder: ["agent-one"],
  };
}

describe("the set-section-color action at the renderer boundary", () => {
  it("reads a color in any case and stores it in lower case", () => {
    expect(parseSidebarLayoutAction({ type: "set-section-color", sectionId: SECTION_ID, color: "#3B82F6" })).toEqual({
      type: "set-section-color",
      sectionId: SECTION_ID,
      color: "#3b82f6",
    });
  });

  it("reads null as no color", () => {
    expect(parseSidebarLayoutAction({ type: "set-section-color", sectionId: SECTION_ID, color: null })).toEqual({
      type: "set-section-color",
      sectionId: SECTION_ID,
      color: null,
    });
  });

  it("refuses every other value", () => {
    for (const color of [undefined, 0, "", "red", "#fff", "#12345g", "#3b82f6 ", "#3b82f6;x:y", { r: 0 }]) {
      expect(() => parseSidebarLayoutAction({ type: "set-section-color", sectionId: SECTION_ID, color })).toThrow();
    }
    expect(() =>
      parseSidebarLayoutAction({ type: "set-section-color", sectionId: "x".repeat(10_000), color: "#3b82f6" }),
    ).toThrow();
  });
});

describe("a layout with a section color", () => {
  it("decodes with and without the field", () => {
    expect(decodeSidebarLayoutSnapshot(layout()).sections[0]).toEqual({ id: SECTION_ID, name: "Core team" });
    expect(decodeSidebarLayoutSnapshot(layout("#3b82f6")).sections[0]?.color).toBe("#3b82f6");
  });

  it("fails closed on a color that is not a stored #rrggbb", () => {
    for (const color of ["#3B82F6", "blue", null, 12, "#3b82f6;background:url(x)"]) {
      expect(isSidebarLayoutSnapshot(layout(color))).toBe(false);
      expect(() => decodeSidebarLayoutSnapshot(layout(color))).toThrow();
    }
  });
});

describe("the released Team API sidebar layout wire", () => {
  it("does not carry a section color to any released protocol", () => {
    for (const protocol of RELEASED_PROTOCOLS) {
      const codec = teamHttpCodec(protocol);
      const encoded = JSON.parse(codec.encodeResponse("GET", "/v1/sidebar-layout", 200, layout("#3b82f6"), {}));
      expect(encoded.sections).toEqual([{ id: SECTION_ID, name: "Core team" }]);
      const decoded = codec.decodeResponse("GET", "/v1/sidebar-layout", 200, encoded);
      expect(isSidebarLayoutSnapshot(decoded)).toBe(true);
    }
  });

  it("refuses the set-section-color action from a peer of any released protocol", () => {
    const action = { type: "set-section-color", sectionId: SECTION_ID, color: "#3b82f6" };
    for (const protocol of RELEASED_PROTOCOLS) {
      const codec = teamHttpCodec(protocol);
      expect(() => codec.decodeRequest("POST", "/v1/sidebar-layout/actions", action, {})).toThrow();
      expect(() => codec.encodeRequest("POST", "/v1/sidebar-layout/actions", action, {})).toThrow();
    }
  });
});
