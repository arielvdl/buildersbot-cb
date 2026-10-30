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

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function layoutFile(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "sidebar-section-icon-"));
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

function storedLayout(sections: unknown[]): string {
  return JSON.stringify({
    version: 2,
    revision: 4,
    sections,
    order: ["people", SECTION_ID, OTHER_SECTION_ID, "unassigned"],
    agentAssignments: { "agent-one": SECTION_ID },
    agentOrder: ["agent-one"],
  });
}

describe("the icon of a sidebar section", () => {
  it("is set, changed and cleared, and stays across a restart", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    const created = await mutate(store, { type: "create", name: "Red Team" });
    const sectionId = created.sections[0]?.id ?? "";

    const lettered = await mutate(store, {
      type: "set-section-icon",
      sectionId,
      icon: { kind: "letter", text: " RT " },
    });
    expect(lettered.sections[0]?.icon).toEqual({ kind: "letter", text: "RT" });
    expect(lettered.revision).toBe(created.revision + 1);

    const glyph = await mutate(store, {
      type: "set-section-icon",
      sectionId,
      icon: { kind: "glyph", glyph: "shield" },
    });
    const reopened = await openStore(file);
    expect(reopened.getSnapshot().sections[0]).toEqual({
      id: sectionId,
      name: "Red Team",
      icon: glyph.sections[0]?.icon,
    });

    const cleared = await mutate(store, { type: "set-section-icon", sectionId, icon: null });
    expect(cleared.sections[0]).toEqual({ id: sectionId, name: "Red Team" });
    expect(JSON.parse(await readFile(file, "utf8")).sections[0]).not.toHaveProperty("icon");
  });

  it("keeps the icon on a rename and drops it with the section", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    const created = await mutate(store, { type: "create", name: "naia" });
    const sectionId = created.sections[0]?.id ?? "";
    await mutate(store, { type: "set-section-icon", sectionId, icon: { kind: "glyph", glyph: "bot" } });
    const renamed = await mutate(store, { type: "rename", sectionId, name: "Naia" });
    expect(renamed.sections[0]?.icon).toEqual({ kind: "glyph", glyph: "bot" });
    const deleted = await mutate(store, { type: "delete", sectionId });
    expect(deleted.sections).toEqual([]);
  });

  it("does not write when the icon is the same", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    const created = await mutate(store, { type: "create", name: "videos" });
    const sectionId = created.sections[0]?.id ?? "";
    const set = await mutate(store, { type: "set-section-icon", sectionId, icon: { kind: "glyph", glyph: "film" } });
    const again = await mutate(store, { type: "set-section-icon", sectionId, icon: { kind: "glyph", glyph: "film" } });
    expect(again.revision).toBe(set.revision);
    const none = await mutate(store, { type: "set-section-icon", sectionId, icon: null });
    const noneAgain = await mutate(store, { type: "set-section-icon", sectionId, icon: null });
    expect(noneAgain.revision).toBe(none.revision);
  });

  it("refuses an invalid icon and an unknown section, and keeps the layout", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    const created = await mutate(store, { type: "create", name: "sec" });
    const sectionId = created.sections[0]?.id ?? "";
    // The renderer boundary refuses these too. The store holds the same rule for any other caller.
    const invalid: SidebarSectionIcon[] = [
      { kind: "letter", text: "ABC" },
      { kind: "letter", text: " " },
      { kind: "image", dataUrl: "https://example.com/icon.png" },
      { kind: "image", dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" },
    ];
    for (const icon of invalid) {
      await expect(mutate(store, { type: "set-section-icon", sectionId, icon })).rejects.toThrow();
    }
    await expect(
      mutate(store, { type: "set-section-icon", sectionId: OTHER_SECTION_ID, icon: { kind: "glyph", glyph: "bot" } }),
    ).rejects.toThrow();
    expect(store.getSnapshot()).toEqual(created);
  });

  it("drops an invalid stored icon and keeps the sections and their chats", async () => {
    const { root, file } = await layoutFile();
    await writeFile(
      file,
      storedLayout([
        { id: SECTION_ID, name: "Naia", icon: { kind: "image", dataUrl: "https://example.com/icon.png" } },
        { id: OTHER_SECTION_ID, name: "Claude Bots", icon: { kind: "letter", text: "CB" } },
      ]),
    );
    const store = await openStore(file);
    expect(store.getSnapshot().sections).toEqual([
      { id: SECTION_ID, name: "Naia" },
      { id: OTHER_SECTION_ID, name: "Claude Bots", icon: { kind: "letter", text: "CB" } },
    ]);
    expect(store.getSnapshot().agentAssignments).toEqual({ "agent-one": SECTION_ID });
    expect((await readdir(root)).some((name) => name.includes(".corrupt-"))).toBe(false);
  });
});
