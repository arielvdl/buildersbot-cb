import type { SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { newChatSectionId } from "./new-chat-section";

const NAIA = "11111111-1111-4111-8111-111111111111";
const GONE = "44444444-4444-4444-8444-444444444444";

const layout: SidebarLayoutSnapshot = {
  revision: 1,
  sections: [{ id: NAIA, name: "naia" }],
  order: ["people", NAIA, "unassigned"],
  agentAssignments: {},
  agentOrder: [],
};

describe("newChatSectionId", () => {
  it("returns the selected custom section while the rail is on screen", () => {
    expect(newChatSectionId(layout, NAIA, true)).toBe(NAIA);
  });

  it("leaves a chat without a section for All, No section and a hidden rail", () => {
    expect(newChatSectionId(layout, null, true)).toBeNull();
    expect(newChatSectionId(layout, "unassigned", true)).toBeNull();
    expect(newChatSectionId(layout, NAIA, false)).toBeNull();
  });

  it("ignores a section that is no longer in the layout", () => {
    expect(newChatSectionId(layout, GONE, true)).toBeNull();
  });
});
