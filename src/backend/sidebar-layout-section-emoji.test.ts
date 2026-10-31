// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SidebarLayoutAction, SidebarLayoutSnapshot, SidebarSectionIcon } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarLayoutStore } from "./sidebar-layout-store";

const SECTION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SECTION_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_SECTION_ID = "33333333-3333-4333-8333-333333333333";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function layoutFile(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "sidebar-section-emoji-"));
  roots.push(root);
  return { root, file: join(root, "openbot-sidebar-layout-v1.json") };
}

async function openStore(file: string): Promise<SidebarLayoutStore> {
  const store = new SidebarLayoutStore(file);
  await Effect.runPromise(store.initialize());
  return store;
}

function mutate(store: SidebarLayoutStore, action: SidebarLayoutAction): Promise<SidebarLayoutSnapshot> {
  return Effect.runPromise(store.mutate(action, new Set(["agent-one"])));
}

describe("an emoji or library glyph as a section icon", () => {
  it("is set and stays across a restart", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    const created = await mutate(store, { type: "create", name: "Dev" });
    const sectionId = created.sections[0]?.id ?? "";
    await mutate(store, { type: "set-section-icon", sectionId, icon: { kind: "emoji", emoji: "👩🏽‍💻" } });
    expect((await openStore(file)).getSnapshot().sections[0]?.icon).toEqual({ kind: "emoji", emoji: "👩🏽‍💻" });
    await mutate(store, { type: "set-section-icon", sectionId, icon: { kind: "glyph", glyph: "rocket" } });
    expect((await openStore(file)).getSnapshot().sections[0]?.icon).toEqual({ kind: "glyph", glyph: "rocket" });
  });

  it("refuses an emoji value that is text, markup or more than one emoji", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    const created = await mutate(store, { type: "create", name: "sec" });
    const sectionId = created.sections[0]?.id ?? "";
    const invalid: SidebarSectionIcon[] = [
      { kind: "emoji", emoji: "ab" },
      { kind: "emoji", emoji: "<img src=x onerror=alert(1)>" },
      { kind: "emoji", emoji: "🚀🚀" },
      { kind: "emoji", emoji: "" },
    ];
    for (const icon of invalid) {
      await expect(mutate(store, { type: "set-section-icon", sectionId, icon })).rejects.toThrow();
    }
    expect(store.getSnapshot()).toEqual(created);
  });

  it("drops an invalid stored emoji and keeps the section and its chats", async () => {
    const { root, file } = await layoutFile();
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        revision: 4,
        sections: [
          { id: SECTION_ID, name: "Naia", icon: { kind: "emoji", emoji: "<svg onload=alert(1)>" } },
          { id: OTHER_SECTION_ID, name: "Flags", icon: { kind: "emoji", emoji: "🏳️‍🌈" } },
          { id: THIRD_SECTION_ID, name: "Text", icon: { kind: "emoji", emoji: "x".repeat(40) } },
        ],
        order: ["people", SECTION_ID, OTHER_SECTION_ID, THIRD_SECTION_ID, "unassigned"],
        agentAssignments: { "agent-one": SECTION_ID },
        agentOrder: ["agent-one"],
      }),
    );
    const store = await openStore(file);
    expect(store.getSnapshot().sections).toEqual([
      { id: SECTION_ID, name: "Naia" },
      { id: OTHER_SECTION_ID, name: "Flags", icon: { kind: "emoji", emoji: "🏳️‍🌈" } },
      { id: THIRD_SECTION_ID, name: "Text" },
    ]);
    expect(store.getSnapshot().agentAssignments).toEqual({ "agent-one": SECTION_ID });
    expect((await readdir(root)).some((name) => name.includes(".corrupt-"))).toBe(false);
    // The next write keeps only the valid icon.
    await mutate(store, { type: "rename", sectionId: SECTION_ID, name: "naia" });
    expect(await readFile(file, "utf8")).not.toContain("<svg");
  });
});
