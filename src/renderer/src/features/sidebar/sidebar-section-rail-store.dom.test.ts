import type { SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { createEffect, createRoot, createStore, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { SidebarProps } from "../../../../../packages/ui/src/features/sidebar/sidebar-types";
import { createSidebarDataStore } from "../../../../../packages/ui/src/features/sidebar/stores/data-store";
import { STORY_AGENTS } from "../../preview/fixtures";

const NAIA = "61111111-1111-4111-8111-111111111111";
const RED_TEAM = "62222222-2222-4222-8222-222222222222";

const layout: SidebarLayoutSnapshot = {
  revision: 1,
  sections: [
    { id: NAIA, name: "naia" },
    { id: RED_TEAM, name: "Red Team" },
  ],
  order: ["people", NAIA, RED_TEAM, "unassigned"],
  agentAssignments: { chief: NAIA, research: NAIA, sales: RED_TEAM },
  agentOrder: ["chief", "research", "sales"],
};

const noop = () => undefined;

function sidebarProps(): SidebarProps {
  return {
    serverName: "Local",
    agents: STORY_AGENTS,
    activeAgentId: "chief",
    people: [],
    directThreads: [],
    activeDirectMemberId: null,
    agentStates: { research: { kind: "working" } },
    agentMoods: {},
    layout,
    // The user collapsed naia while the list showed every section.
    collapsedSectionIds: [NAIA],
    onMutateLayout: async () => undefined,
    onToggleSection: noop,
    pinnedItems: [],
    peopleOrder: [],
    onPin: noop,
    onUnpin: noop,
    onReorderPinned: noop,
    onReorderPeople: noop,
    onSelectAgent: noop,
    onSelectPerson: noop,
    onCreateAgent: noop,
    onEditAgent: noop,
    onDeleteAgent: async () => undefined,
    compact: false,
    onExpand: noop,
    onOpenSearch: noop,
    onOpenMarketplace: noop,
    sectionRail: { selectedId: null, onSelect: noop },
  };
}

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function mount() {
  return createRoot((dispose) => {
    disposers.push(dispose);
    const [props, setProps] = createStore<SidebarProps>(sidebarProps());
    const data = createSidebarDataStore({ props, dragActive: () => false });
    // The list observes these, as the rendered sidebar does. A memo that nothing observes keeps its value.
    createEffect(
      () => [
        data.visibleSectionIds(),
        data.filteredChats(),
        data.filteredChatsBySection(),
        data.sectionRail.items(),
        data.sectionRail.order(),
      ],
      noop,
    );
    flush();
    const select = (selectedId: string | null) => {
      setProps((draft) => {
        draft.sectionRail = { selectedId, onSelect: noop };
      });
      flush();
    };
    const chatIds = (sectionId: string) => (data.filteredChatsBySection().get(sectionId) ?? []).map((chat) => chat.id);
    return { data, props, setProps, select, chatIds };
  });
}

describe("a section that the rail selects", () => {
  it("shows its chats, open, also when the user collapsed it under All", () => {
    const { data, select, chatIds } = mount();
    expect(data.visibleSectionIds()).toEqual([NAIA, RED_TEAM]);
    expect(data.sectionIsCollapsed(NAIA)).toBe(true);

    select(NAIA);
    expect(data.visibleSectionIds()).toEqual([NAIA]);
    expect(data.sectionRail.order()).toEqual([NAIA]);
    expect(data.sectionIsCollapsed(NAIA)).toBe(false);
    expect(chatIds(NAIA)).toEqual(["chief", "research"]);
    expect(chatIds(RED_TEAM)).toEqual([]);
  });

  it("changes to another section, and back to All with the saved collapse state", () => {
    const { data, select, chatIds } = mount();
    select(NAIA);
    select(RED_TEAM);
    expect(data.visibleSectionIds()).toEqual([RED_TEAM]);
    expect(data.sectionIsCollapsed(RED_TEAM)).toBe(false);
    expect(chatIds(RED_TEAM)).toEqual(["sales"]);

    select(null);
    expect(data.visibleSectionIds()).toEqual([NAIA, RED_TEAM]);
    expect(data.sectionIsCollapsed(NAIA)).toBe(true);
    expect(chatIds(NAIA)).toEqual(["chief", "research"]);
  });

  it("keeps the same rows and the same rail items when the user opens another agent", () => {
    const { data, setProps, select } = mount();
    select(NAIA);
    const rows = data.filteredChats();
    const items = data.sectionRail.items();
    setProps((draft) => {
      draft.activeAgentId = "research";
      draft.agentStates = { research: { kind: "working" } };
    });
    flush();
    expect(data.sectionRail.items()).toBe(items);
    expect(data.filteredChats().every((chat, index) => chat === rows[index])).toBe(true);
    expect(data.sectionIsCollapsed(NAIA)).toBe(false);
  });
});
