// @vitest-environment node
import { isSidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import { describe, expect, it } from "vitest";
import { parseSidebarLayoutAction } from "./ipc/agent-inputs";

const SECTION_ID = "11111111-1111-4111-8111-111111111111";
const MARKER_ID = "marker:11111111-2222-4333-8444-555555555555";
const RELEASED_PROTOCOLS = [1, 3, 4, 5, 6, 7, 8];

function layout(markers?: unknown, itemOrder?: unknown) {
  return {
    revision: 3,
    sections: [{ id: SECTION_ID, name: "naia" }],
    order: ["people", SECTION_ID, "unassigned"],
    agentAssignments: { scout: SECTION_ID },
    agentOrder: ["scout"],
    ...(markers === undefined ? {} : { markers }),
    ...(itemOrder === undefined ? {} : { itemOrder }),
  };
}

const done = { id: MARKER_ID, sectionId: SECTION_ID, label: "Done", style: "dim" };

describe("the marker actions at the renderer boundary", () => {
  it("read a marker in its stored form", () => {
    expect(
      parseSidebarLayoutAction({
        type: "create-marker",
        sectionId: null,
        label: " Done ",
        style: "tint",
        color: "#3B82F6",
      }),
    ).toEqual({ type: "create-marker", sectionId: null, label: "Done", style: "tint", color: "#3b82f6" });
    expect(
      parseSidebarLayoutAction({ type: "move-marker", markerId: MARKER_ID, sectionId: SECTION_ID, beforeId: null }),
    ).toEqual({ type: "move-marker", markerId: MARKER_ID, sectionId: SECTION_ID, beforeId: null });
    expect(parseSidebarLayoutAction({ type: "delete-marker", markerId: MARKER_ID })).toEqual({
      type: "delete-marker",
      markerId: MARKER_ID,
    });
  });

  it("refuse a bad id, style, color or text", () => {
    const bad = [
      { type: "delete-marker", markerId: "scout" },
      { type: "update-marker", markerId: MARKER_ID, label: "x", style: "glow", color: null },
      { type: "update-marker", markerId: MARKER_ID, label: "x", style: "tint", color: "red" },
      { type: "update-marker", markerId: MARKER_ID, label: "x", style: "dim", color: "#3b82f6" },
      { type: "create-marker", sectionId: null, label: "x".repeat(41), style: "dim", color: null },
      { type: "create-marker", sectionId: 7, label: "x", style: "dim", color: null },
      { type: "move-marker", markerId: MARKER_ID, sectionId: null, beforeId: 7 },
    ];
    for (const action of bad) expect(() => parseSidebarLayoutAction(action)).toThrow();
  });
});

describe("a layout with markers", () => {
  it("decodes with and without them", () => {
    expect(isSidebarLayoutSnapshot(layout())).toBe(true);
    expect(isSidebarLayoutSnapshot(layout([done], [MARKER_ID, "scout"]))).toBe(true);
  });

  it("fails closed on a marker that is not valid or not in the sequence", () => {
    expect(isSidebarLayoutSnapshot(layout([{ ...done, style: "glow" }], [MARKER_ID]))).toBe(false);
    expect(isSidebarLayoutSnapshot(layout([{ ...done, sectionId: "gone" }], [MARKER_ID]))).toBe(false);
    expect(isSidebarLayoutSnapshot(layout([done], ["scout"]))).toBe(false);
    expect(isSidebarLayoutSnapshot(layout([done]))).toBe(false);
    expect(isSidebarLayoutSnapshot(layout(undefined, ["scout"]))).toBe(false);
  });
});

describe("the released Team API sidebar layout wire", () => {
  it("does not carry markers or their sequence to any released protocol", () => {
    for (const protocol of RELEASED_PROTOCOLS) {
      const codec = teamHttpCodec(protocol);
      const encoded = JSON.parse(
        codec.encodeResponse("GET", "/v1/sidebar-layout", 200, layout([done], [MARKER_ID, "scout"]), {}),
      );
      expect(encoded).not.toHaveProperty("markers");
      expect(encoded).not.toHaveProperty("itemOrder");
      expect(encoded.agentOrder).toEqual(["scout"]);
      expect(isSidebarLayoutSnapshot(codec.decodeResponse("GET", "/v1/sidebar-layout", 200, encoded))).toBe(true);
    }
  });

  it("refuses the marker actions from a peer of any released protocol", () => {
    const action = { type: "create-marker", sectionId: null, label: "Done", style: "dim", color: null };
    for (const protocol of RELEASED_PROTOCOLS) {
      const codec = teamHttpCodec(protocol);
      expect(() => codec.decodeRequest("POST", "/v1/sidebar-layout/actions", action, {})).toThrow();
      expect(() => codec.encodeRequest("POST", "/v1/sidebar-layout/actions", action, {})).toThrow();
    }
  });
});
