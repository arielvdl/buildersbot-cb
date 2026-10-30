import { describe, expect, it } from "vitest";
import {
  readSidebarSectionRail,
  withSidebarSectionRailSelection,
  writeSidebarSectionRail,
} from "./sidebar-section-rail-storage";

const KEY = "openbot:sidebar-section-rail:v1";
const NAIA = "11111111-1111-4111-8111-111111111111";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

const blocked = {
  getItem: (): string | null => {
    throw new Error("blocked");
  },
  setItem: (): void => {
    throw new Error("blocked");
  },
};

describe("the remembered section of the section rail", () => {
  it("comes back after a restart, for each server on its own", () => {
    const storage = memoryStorage();
    let selection = withSidebarSectionRailSelection({}, "local", NAIA);
    selection = withSidebarSectionRailSelection(selection, "remote-1", "unassigned");
    writeSidebarSectionRail(selection, storage);
    expect(readSidebarSectionRail(storage)).toEqual({ local: NAIA, "remote-1": "unassigned" });
  });

  it("stores All as no entry", () => {
    const selection = withSidebarSectionRailSelection({ local: NAIA, other: NAIA }, "local", null);
    expect(selection).toEqual({ other: NAIA });
  });

  it("reads a damaged or foreign value as All", () => {
    expect(readSidebarSectionRail(memoryStorage({ [KEY]: "{not json" }))).toEqual({});
    expect(readSidebarSectionRail(memoryStorage({ [KEY]: "[1,2]" }))).toEqual({});
    expect(
      readSidebarSectionRail(
        memoryStorage({ [KEY]: JSON.stringify({ local: 7, other: "", long: "x".repeat(500), ok: NAIA }) }),
      ),
    ).toEqual({ ok: NAIA });
    expect(readSidebarSectionRail(memoryStorage())).toEqual({});
  });

  it("works without storage", () => {
    expect(readSidebarSectionRail(blocked)).toEqual({});
    expect(() => writeSidebarSectionRail({ local: NAIA }, blocked)).not.toThrow();
  });
});
