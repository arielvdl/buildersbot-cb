import { describe, expect, it } from "vitest";
import { LEFT_COLUMN_STORAGE_KEY } from "./layout-constants";
import { readLeftColumnView, sectionRailShowsOn, writeLeftColumnView } from "./left-column";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("the left column setting", () => {
  it("shows the sections by default", () => {
    expect(readLeftColumnView(memoryStorage())).toBe("sections");
  });

  it("keeps the choice of the servers", () => {
    const storage = memoryStorage();
    writeLeftColumnView("servers", storage);
    expect(readLeftColumnView(storage)).toBe("servers");
    writeLeftColumnView("sections", storage);
    expect(readLeftColumnView(storage)).toBe("sections");
  });

  it("reads another value, and the earlier server view choice, as the default", () => {
    expect(readLeftColumnView(memoryStorage({ [LEFT_COLUMN_STORAGE_KEY]: "rail" }))).toBe("sections");
    expect(readLeftColumnView(memoryStorage({ "openbot:server-view": "rail" }))).toBe("sections");
  });

  it("works without storage", () => {
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: (): void => {
        throw new Error("blocked");
      },
    };
    expect(readLeftColumnView(blocked)).toBe("sections");
    expect(() => writeLeftColumnView("servers", blocked)).not.toThrow();
  });
});

describe("the pages with the section rail", () => {
  it("are Agents and Routines (the agents page), Workflows and Schedule", () => {
    for (const page of ["agents", "workflows", "schedule"]) expect(sectionRailShowsOn(page)).toBe(true);
  });

  it("leave out every other page", () => {
    for (const page of ["usage", "marketplace", "settings", "server-settings", "routines"]) {
      expect(sectionRailShowsOn(page)).toBe(false);
    }
  });
});
