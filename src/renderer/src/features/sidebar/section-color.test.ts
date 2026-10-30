import type { SidebarLayoutAction, SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { duplicateSection } from "../../../../../packages/ui/src/features/sidebar/duplicate-section";
import {
  isCustomSidebarSectionColor,
  SIDEBAR_SECTION_COLOR_PRESETS,
  sidebarSectionColorAction,
  sidebarSectionColorStyle,
  sidebarSectionPickerColor,
} from "../../../../../packages/ui/src/features/sidebar/section-color";
import { applySidebarLayoutAction } from "../../preview/mock-sidebar-layout";

const SECTION_ID = "11111111-1111-4111-8111-111111111111";

describe("the box color of a section", () => {
  it("is a CSS custom property only for a stored #rrggbb color", () => {
    expect(sidebarSectionColorStyle("#3b82f6")).toBe("--sidebar-section-color: #3b82f6;");
    expect(sidebarSectionColorStyle(undefined)).toBe("");
    for (const color of ["", "blue", "#3B82F6", "#fff", "#3b82f6;background:url(x)", "#3b82f6} .x{"]) {
      expect(sidebarSectionColorStyle(color)).toBe("");
    }
  });

  it("offers 8 to 10 distinct presets, each a stored #rrggbb color", () => {
    const colors = SIDEBAR_SECTION_COLOR_PRESETS.map((preset) => preset.color);
    expect(colors.length).toBeGreaterThanOrEqual(8);
    expect(colors.length).toBeLessThanOrEqual(10);
    expect(new Set(colors).size).toBe(colors.length);
    for (const color of colors) expect(sidebarSectionColorStyle(color)).not.toBe("");
    expect(new Set(SIDEBAR_SECTION_COLOR_PRESETS.map((preset) => preset.label)).size).toBe(colors.length);
  });

  it("tells a custom color from a preset and from no color", () => {
    const preset = SIDEBAR_SECTION_COLOR_PRESETS[0]?.color;
    expect(isCustomSidebarSectionColor(preset)).toBe(false);
    expect(isCustomSidebarSectionColor(undefined)).toBe(false);
    expect(isCustomSidebarSectionColor("#123456")).toBe(true);
  });

  it("starts the custom picker on the section color, or on a preset when there is none", () => {
    expect(sidebarSectionPickerColor("#123456")).toBe("#123456");
    expect(SIDEBAR_SECTION_COLOR_PRESETS.map((preset) => preset.color)).toContain(sidebarSectionPickerColor(undefined));
  });
});

describe("a choice in the section color control", () => {
  const plain = { id: SECTION_ID, name: "Design" };
  const blue = { id: SECTION_ID, name: "Design", color: "#3b82f6" };

  it("sets, changes and clears the color", () => {
    expect(sidebarSectionColorAction(plain, "#3b82f6")).toEqual({
      type: "set-section-color",
      sectionId: SECTION_ID,
      color: "#3b82f6",
    });
    expect(sidebarSectionColorAction(blue, "#EF4444")).toEqual({
      type: "set-section-color",
      sectionId: SECTION_ID,
      color: "#ef4444",
    });
    expect(sidebarSectionColorAction(blue, null)).toEqual({
      type: "set-section-color",
      sectionId: SECTION_ID,
      color: null,
    });
  });

  it("asks for nothing when the color does not change or is not valid", () => {
    expect(sidebarSectionColorAction(blue, "#3B82F6")).toBeNull();
    expect(sidebarSectionColorAction(plain, null)).toBeNull();
    expect(sidebarSectionColorAction(plain, "blue")).toBeNull();
    expect(sidebarSectionColorAction(plain, "#3b82f6;x:y")).toBeNull();
  });
});

describe("a duplicated section", () => {
  function run(source: SidebarLayoutSnapshot) {
    let layout = source;
    const actions: SidebarLayoutAction[] = [];
    const done = duplicateSection(
      {
        layout: source,
        agentIds: [],
        duplicateAgent: async () => null,
        mutateLayout: async (action) => {
          actions.push(action);
          layout = applySidebarLayoutAction(layout, action);
          return layout;
        },
      },
      SECTION_ID,
    );
    return { done, actions, layout: () => layout };
  }

  function source(color?: string): SidebarLayoutSnapshot {
    return {
      revision: 1,
      sections: [{ id: SECTION_ID, name: "Design", ...(color === undefined ? {} : { color }) }],
      order: ["people", SECTION_ID, "unassigned"],
      agentAssignments: {},
      agentOrder: [],
    };
  }

  it("keeps the color of the source", async () => {
    const copy = run(source("#a855f7"));
    const copyId = await copy.done;
    expect(copy.layout().sections.find((section) => section.id === copyId)).toMatchObject({
      name: "Design copy",
      color: "#a855f7",
    });
    expect(copy.layout().sections.find((section) => section.id === SECTION_ID)?.color).toBe("#a855f7");
  });

  it("asks for no color when the source has none", async () => {
    const copy = run(source());
    const copyId = await copy.done;
    expect(copy.actions.some((action) => action.type === "set-section-color")).toBe(false);
    expect(copy.layout().sections.find((section) => section.id === copyId)).toEqual({
      id: copyId,
      name: "Design copy",
    });
  });
});
