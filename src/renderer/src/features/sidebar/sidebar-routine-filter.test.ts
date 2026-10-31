import { describe, expect, it } from "vitest";
import {
  SIDEBAR_ROUTINE_FILTERS,
  SIDEBAR_ROUTINE_RECENT_WINDOW_MS,
  sidebarActivityMenu,
  sidebarAgentPassesRoutineFilter,
  sidebarRoutineHiddenCount,
  sidebarRoutineIsRecent,
  sidebarRoutineMatchesFilter,
} from "../../../../../packages/ui/src/features/sidebar/sidebar-routine-filter";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function routine(input: { active?: boolean; createdDaysAgo?: number; updatedDaysAgo?: number } = {}) {
  const { active = true, createdDaysAgo = 30, updatedDaysAgo = createdDaysAgo } = input;
  return { active, createdAt: at(createdDaysAgo), updatedAt: at(updatedDaysAgo) };
}

describe("the menu of the filter button", () => {
  it("shows the routine filters only in the Routines view of a caller that can set one", () => {
    expect(sidebarActivityMenu("routines", true)).toBe("routines");
    expect(sidebarActivityMenu("routines", false)).toBe("chats");
    expect(sidebarActivityMenu("agents", true)).toBe("chats");
    expect(sidebarActivityMenu(undefined, true)).toBe("chats");
  });

  it("lists the routine filters in menu order, with no finished choice", () => {
    expect(SIDEBAR_ROUTINE_FILTERS).toEqual(["active", "inactive", "created", "edited"]);
  });
});

describe("a recent routine time", () => {
  it("is in the last 7 days", () => {
    expect(SIDEBAR_ROUTINE_RECENT_WINDOW_MS).toBe(7 * DAY);
    expect(sidebarRoutineIsRecent(at(0), NOW)).toBe(true);
    expect(sidebarRoutineIsRecent(at(6.9), NOW)).toBe(true);
    expect(sidebarRoutineIsRecent(at(7), NOW)).toBe(true);
    expect(sidebarRoutineIsRecent(at(7.1), NOW)).toBe(false);
  });

  it("allows a small clock skew, and rejects a missing or bad time", () => {
    expect(sidebarRoutineIsRecent(at(-0.01), NOW)).toBe(true);
    expect(sidebarRoutineIsRecent(at(-8), NOW)).toBe(false);
    expect(sidebarRoutineIsRecent(null, NOW)).toBe(false);
    expect(sidebarRoutineIsRecent(undefined, NOW)).toBe(false);
    expect(sidebarRoutineIsRecent("not a date", NOW)).toBe(false);
  });
});

describe("a routine that matches a filter", () => {
  it("is active or paused", () => {
    expect(sidebarRoutineMatchesFilter("active", routine({ active: true }), NOW)).toBe(true);
    expect(sidebarRoutineMatchesFilter("active", routine({ active: false }), NOW)).toBe(false);
    expect(sidebarRoutineMatchesFilter("inactive", routine({ active: false }), NOW)).toBe(true);
    expect(sidebarRoutineMatchesFilter("inactive", routine({ active: true }), NOW)).toBe(false);
  });

  it("was created in the last 7 days", () => {
    expect(sidebarRoutineMatchesFilter("created", routine({ createdDaysAgo: 2 }), NOW)).toBe(true);
    expect(sidebarRoutineMatchesFilter("created", routine({ createdDaysAgo: 20, updatedDaysAgo: 1 }), NOW)).toBe(false);
  });

  it("was changed after its creation, in the last 7 days", () => {
    expect(sidebarRoutineMatchesFilter("edited", routine({ createdDaysAgo: 20, updatedDaysAgo: 1 }), NOW)).toBe(true);
    expect(sidebarRoutineMatchesFilter("edited", routine({ createdDaysAgo: 20, updatedDaysAgo: 10 }), NOW)).toBe(false);
    // A new routine that nobody changed is created recently, not edited recently.
    expect(sidebarRoutineMatchesFilter("edited", routine({ createdDaysAgo: 1 }), NOW)).toBe(false);
  });
});

describe("an agent that the routine filter keeps", () => {
  const paused = [routine({ active: false })];

  it("is every agent with no filter", () => {
    expect(sidebarAgentPassesRoutineFilter(null, undefined, false, NOW)).toBe(true);
  });

  it("has at least one routine that matches", () => {
    const mixed = [routine({ active: true }), routine({ active: false })];
    expect(sidebarAgentPassesRoutineFilter("active", mixed, false, NOW)).toBe(true);
    expect(sidebarAgentPassesRoutineFilter("inactive", mixed, false, NOW)).toBe(true);
    expect(sidebarAgentPassesRoutineFilter("active", paused, false, NOW)).toBe(false);
    expect(sidebarAgentPassesRoutineFilter("active", [], false, NOW)).toBe(false);
    expect(sidebarAgentPassesRoutineFilter("active", undefined, false, NOW)).toBe(false);
  });

  it("is always the open agent", () => {
    expect(sidebarAgentPassesRoutineFilter("active", paused, true, NOW)).toBe(true);
    expect(sidebarAgentPassesRoutineFilter("created", undefined, true, NOW)).toBe(true);
  });
});

describe("the chats that a routine filter hides", () => {
  const input = {
    agents: [{ id: "scout" }, { id: "writer" }, { id: "hacker" }, { id: "new" }],
    channelCount: 0,
    agentRoutines: {
      scout: [routine({ active: true })],
      writer: [routine({ active: false, createdDaysAgo: 30, updatedDaysAgo: 2 })],
      hacker: [routine({ active: true, createdDaysAgo: 3 })],
    },
    activeAgentId: "new",
    now: NOW,
  };

  it("are none with no filter", () => {
    expect(sidebarRoutineHiddenCount({ ...input, filter: null })).toBe(0);
  });

  it("are counted for each filter, without the open agent", () => {
    // Active: writer has only a paused routine; "new" has none but is open.
    expect(sidebarRoutineHiddenCount({ ...input, filter: "active" })).toBe(1);
    expect(sidebarRoutineHiddenCount({ ...input, filter: "inactive" })).toBe(2);
    expect(sidebarRoutineHiddenCount({ ...input, filter: "created" })).toBe(2);
    expect(sidebarRoutineHiddenCount({ ...input, filter: "edited" })).toBe(2);
  });

  it("include every channel, as a routine filter lists agents only", () => {
    expect(sidebarRoutineHiddenCount({ ...input, channelCount: 2, filter: "active" })).toBe(3);
  });
});
