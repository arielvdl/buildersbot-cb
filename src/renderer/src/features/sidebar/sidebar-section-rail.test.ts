import type { SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  sidebarSectionIconSide,
  sidebarSectionIconSourceProblem,
} from "../../../../../packages/ui/src/features/sidebar/section-icon-image";
import {
  resolveSidebarSectionRailSelection,
  sidebarChatSectionId,
  sidebarSectionLetter,
  sidebarSectionMark,
  sidebarSectionRailBadgeKind,
  sidebarSectionRailItems,
  sidebarSectionRailOrder,
} from "../../../../../packages/ui/src/features/sidebar/sidebar-section-rail";

const NAIA = "11111111-1111-4111-8111-111111111111";
const RED_TEAM = "22222222-2222-4222-8222-222222222222";
const CLAUDE_BOTS = "33333333-3333-4333-8333-333333333333";
const GONE = "44444444-4444-4444-8444-444444444444";

const layout: SidebarLayoutSnapshot = {
  revision: 2,
  sections: [
    { id: NAIA, name: "naia" },
    { id: RED_TEAM, name: "Red Team", icon: { kind: "glyph", glyph: "shield" } },
    { id: CLAUDE_BOTS, name: "Claude Bots" },
  ],
  order: ["people", RED_TEAM, NAIA, "unassigned", CLAUDE_BOTS],
  agentAssignments: {
    scout: NAIA,
    writer: NAIA,
    hacker: RED_TEAM,
    "launch-room": NAIA,
    orphan: GONE,
  },
  agentOrder: [],
};

const agents = [{ id: "scout" }, { id: "writer" }, { id: "hacker" }, { id: "loose" }, { id: "orphan" }];
const channels = [
  { id: "launch-room", unreadCount: 4, activeTasks: 1 },
  { id: "lobby", unreadCount: 0, activeTasks: 0 },
];

describe("the section rail items", () => {
  const items = sidebarSectionRailItems({
    layout,
    agents,
    channels,
    agentStates: {
      scout: { kind: "waiting", reason: "question", detail: null },
      writer: { kind: "unread", count: 2 },
      hacker: { kind: "working" },
      loose: { kind: "routine", phase: "running", count: 1 },
    },
    channelWaits: { "launch-room": { kind: "waiting", reason: "approval", detail: null } },
  });

  it("lists the custom sections in the layout order, then the unassigned section", () => {
    expect(items.map((item) => item.id)).toEqual([RED_TEAM, NAIA, CLAUDE_BOTS, "unassigned"]);
    expect(items.map((item) => item.chatCount)).toEqual([1, 3, 0, 3]);
  });

  it("counts the waits, the work in flight and the unread messages of each section", () => {
    const badge = (id: string) => items.find((item) => item.id === id)?.badge;
    expect(badge(NAIA)).toEqual({ waiting: 2, working: 1, unread: 6 });
    expect(badge(RED_TEAM)).toEqual({ waiting: 0, working: 1, unread: 0 });
    expect(badge(CLAUDE_BOTS)).toEqual({ waiting: 0, working: 0, unread: 0 });
    expect(badge("unassigned")).toEqual({ waiting: 0, working: 1, unread: 0 });
  });

  it("leaves out the unassigned section while it holds no chat", () => {
    const placed = sidebarSectionRailItems({
      layout: { ...layout, agentAssignments: { scout: NAIA } },
      agents: [{ id: "scout" }],
      channels: [],
      agentStates: {},
    });
    expect(placed.map((item) => item.id)).toEqual([RED_TEAM, NAIA, CLAUDE_BOTS]);
  });

  it("counts a hidden agent in its section, but not in the badge", () => {
    const [naia] = sidebarSectionRailItems({
      layout: { ...layout, order: ["people", NAIA, "unassigned", RED_TEAM, CLAUDE_BOTS] },
      agents: [{ id: "scout" }],
      channels: [],
      agentStates: { scout: { kind: "waiting", reason: "question", detail: null } },
      hiddenAgentIds: new Set(["scout"]),
    });
    expect(naia).toMatchObject({ id: NAIA, chatCount: 1, badge: { waiting: 0, working: 0, unread: 0 } });
  });

  it("shows the most urgent badge: a wait, then unread messages, then work", () => {
    expect(sidebarSectionRailBadgeKind({ waiting: 1, working: 3, unread: 9 })).toBe("waiting");
    expect(sidebarSectionRailBadgeKind({ waiting: 0, working: 3, unread: 9 })).toBe("unread");
    expect(sidebarSectionRailBadgeKind({ waiting: 0, working: 3, unread: 0 })).toBe("working");
    expect(sidebarSectionRailBadgeKind({ waiting: 0, working: 0, unread: 0 })).toBeNull();
  });
});

describe("the section that the list shows", () => {
  const items = [{ id: RED_TEAM }, { id: NAIA }, { id: "unassigned" }];

  it("is the remembered section while the rail lists it", () => {
    expect(resolveSidebarSectionRailSelection(NAIA, items)).toBe(NAIA);
    expect(resolveSidebarSectionRailSelection("unassigned", items)).toBe("unassigned");
  });

  it("falls back to All when the section is gone or there is no choice", () => {
    expect(resolveSidebarSectionRailSelection(GONE, items)).toBeNull();
    expect(resolveSidebarSectionRailSelection("unassigned", [{ id: NAIA }])).toBeNull();
    expect(resolveSidebarSectionRailSelection(null, items)).toBeNull();
    expect(resolveSidebarSectionRailSelection(undefined, items)).toBeNull();
    expect(resolveSidebarSectionRailSelection(NAIA, [])).toBeNull();
  });

  it("draws only the selected section, or every section for All", () => {
    expect(sidebarSectionRailOrder(layout, null)).toEqual(layout.order);
    expect(sidebarSectionRailOrder(layout, NAIA)).toEqual([NAIA]);
    expect(sidebarSectionRailOrder(layout, "unassigned")).toEqual(["unassigned"]);
  });

  it("files each chat in its section, or in the unassigned section when its section is gone", () => {
    expect(sidebarChatSectionId(layout, "launch-room")).toBe(NAIA);
    expect(sidebarChatSectionId(layout, "hacker")).toBe(RED_TEAM);
    expect(sidebarChatSectionId(layout, "orphan")).toBe("unassigned");
    expect(sidebarChatSectionId(layout, "loose")).toBe("unassigned");
    const outOfOrder = { ...layout, order: ["people", NAIA, "unassigned", CLAUDE_BOTS] };
    expect(sidebarChatSectionId(outOfOrder, "hacker")).toBe("unassigned");
  });
});

describe("the mark of a section", () => {
  it("defaults to the first letter or digit of the name, in upper case", () => {
    expect(sidebarSectionLetter("naia")).toBe("N");
    expect(sidebarSectionLetter("Red Team")).toBe("R");
    expect(sidebarSectionLetter("  claude bots")).toBe("C");
    expect(sidebarSectionLetter("#ops")).toBe("O");
    expect(sidebarSectionLetter("ñandu")).toBe("Ñ");
    expect(sidebarSectionLetter("2026 plans")).toBe("2");
    expect(sidebarSectionLetter("🔥")).toBe("🔥");
    expect(sidebarSectionLetter("")).toBe("?");
  });

  it("is the icon when the section has one", () => {
    expect(sidebarSectionMark({ name: "Red Team", icon: { kind: "glyph", glyph: "shield" } })).toEqual({
      kind: "glyph",
      glyph: "shield",
    });
    expect(sidebarSectionMark({ name: "videos" })).toEqual({ kind: "letter", text: "V" });
  });
});

describe("a picked icon image", () => {
  it("is refused before it is read when it is not a raster image or is too large", () => {
    expect(sidebarSectionIconSourceProblem({ type: "image/svg+xml", size: 900 })).toBe("type");
    expect(sidebarSectionIconSourceProblem({ type: "application/pdf", size: 900 })).toBe("type");
    expect(sidebarSectionIconSourceProblem({ type: "", size: 900 })).toBe("type");
    expect(sidebarSectionIconSourceProblem({ type: "image/png", size: 11 * 1024 * 1024 })).toBe("size");
    expect(sidebarSectionIconSourceProblem({ type: "image/png", size: 0 })).toBe("size");
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(sidebarSectionIconSourceProblem({ type, size: 2 * 1024 * 1024 })).toBeNull();
    }
  });

  it("becomes a square of at most 96 pixels, and a small picture is not enlarged", () => {
    expect(sidebarSectionIconSide(1000, 500)).toBe(96);
    expect(sidebarSectionIconSide(40, 80)).toBe(40);
    expect(sidebarSectionIconSide(96, 96)).toBe(96);
    expect(sidebarSectionIconSide(0.5, 10)).toBe(1);
  });
});
