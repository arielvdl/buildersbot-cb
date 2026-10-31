import type { SidebarLayoutSnapshot, SidebarMarker } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  sidebarCreatedMarkerId,
  sidebarMarkerCreateSection,
  sidebarMarkerOfChats,
} from "../../../../../packages/ui/src/features/sidebar/sidebar-markers-view";
import type { SidebarChatItem } from "../../../../../packages/ui/src/features/sidebar/sidebar-types";
import { STORY_AGENTS } from "../../preview/fixtures";

const NAIA = "61111111-1111-4111-8111-111111111111";
const RED_TEAM = "62222222-2222-4222-8222-222222222222";
const base = STORY_AGENTS[0];

function agent(id: string): SidebarChatItem {
  if (!base) throw new Error("A story agent is missing.");
  return { kind: "agent", id, agent: { ...base, id } };
}

function marker(id: string, style: SidebarMarker["style"]): SidebarChatItem & { kind: "marker" } {
  const value: SidebarMarker = { id, sectionId: NAIA, label: id, style };
  return { kind: "marker", id, marker: value };
}

const layout: SidebarLayoutSnapshot = {
  revision: 1,
  sections: [
    { id: NAIA, name: "naia" },
    { id: RED_TEAM, name: "Red Team" },
  ],
  order: ["people", RED_TEAM, "unassigned", NAIA],
  agentAssignments: {},
  agentOrder: [],
};

describe("the style of the chats below a marker", () => {
  it("applies to each chat below it, up to the next marker", () => {
    const done = marker("marker:done", "dim");
    const later = marker("marker:later", "grayscale");
    const styles = sidebarMarkerOfChats([agent("a"), done, agent("b"), agent("c"), later, agent("d")]);
    expect(styles.has("a")).toBe(false);
    expect(styles.get("b")).toBe(done.marker);
    expect(styles.get("c")).toBe(done.marker);
    expect(styles.get("d")).toBe(later.marker);
  });

  it("is none in a section with no marker", () => {
    expect(sidebarMarkerOfChats([agent("a"), agent("b")]).size).toBe(0);
  });
});

describe("the section of a new marker", () => {
  it("is the section that the rail selects", () => {
    expect(sidebarMarkerCreateSection(layout, NAIA)).toBe(NAIA);
    expect(sidebarMarkerCreateSection(layout, "unassigned")).toBeNull();
  });

  it("is the first custom section of the list with All, or no section when there is none", () => {
    expect(sidebarMarkerCreateSection(layout, null)).toBe(RED_TEAM);
    expect(sidebarMarkerCreateSection({ ...layout, sections: [], order: ["people", "unassigned"] }, null)).toBeNull();
  });

  it("opens the editor of the one marker that a create added", () => {
    const one: SidebarMarker = { id: "marker:one", sectionId: NAIA, label: "", style: "normal" };
    const two: SidebarMarker = { ...one, id: "marker:two" };
    expect(sidebarCreatedMarkerId(new Set(["marker:one"]), { ...layout, markers: [one, two] })).toBe("marker:two");
    expect(
      sidebarCreatedMarkerId(new Set(["marker:one", "marker:two"]), { ...layout, markers: [one, two] }),
    ).toBeNull();
  });
});
