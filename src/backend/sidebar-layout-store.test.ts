// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SidebarLayoutAction, SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
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
  const root = await mkdtemp(join(tmpdir(), "sidebar-layout-"));
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

function storedLayout(version: 1 | 2, sections: unknown[]): string {
  const ids = sections.flatMap((section) =>
    typeof section === "object" && section !== null && "id" in section ? [String(section.id)] : [],
  );
  return JSON.stringify({
    version,
    revision: 4,
    sections,
    order: ["people", ...ids, "unassigned"],
    agentAssignments: { "agent-one": SECTION_ID },
    ...(version === 2 ? { agentOrder: ["agent-one"] } : {}),
  });
}

describe("the color of a sidebar section", () => {
  it("is set, changed and cleared, and stays across a restart", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    const created = await mutate(store, { type: "create", name: "Design" });
    const sectionId = created.sections[0]?.id ?? "";
    expect(created.sections[0]).toEqual({ id: sectionId, name: "Design" });

    const colored = await mutate(store, { type: "set-section-color", sectionId, color: "#3B82F6" });
    expect(colored.sections[0]?.color).toBe("#3b82f6");
    expect(colored.revision).toBe(created.revision + 1);

    const reopened = await openStore(file);
    expect(reopened.getSnapshot().sections[0]).toEqual({ id: sectionId, name: "Design", color: "#3b82f6" });

    const changed = await mutate(reopened, { type: "set-section-color", sectionId, color: "#ef4444" });
    expect(changed.sections[0]?.color).toBe("#ef4444");

    const cleared = await mutate(reopened, { type: "set-section-color", sectionId, color: null });
    expect(cleared.sections[0]).toEqual({ id: sectionId, name: "Design" });
    expect(await readFile(file, "utf8")).not.toContain("color");
  });

  it("does not count a color that does not change", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    const sectionId = (await mutate(store, { type: "create", name: "Ops" })).sections[0]?.id ?? "";
    const first = await mutate(store, { type: "set-section-color", sectionId, color: "#22c55e" });
    const again = await mutate(store, { type: "set-section-color", sectionId, color: "#22C55E" });
    expect(again.revision).toBe(first.revision);
    const none = await mutate(store, { type: "set-section-color", sectionId, color: null });
    const noneAgain = await mutate(store, { type: "set-section-color", sectionId, color: null });
    expect(noneAgain.revision).toBe(none.revision);
  });

  it("refuses a value that is not #rrggbb and leaves the layout as it was", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    const sectionId = (await mutate(store, { type: "create", name: "Sales" })).sections[0]?.id ?? "";
    const before = store.getSnapshot();
    for (const color of [
      "",
      "red",
      "#fff",
      "#12345g",
      "#1234567",
      "3b82f6",
      "rgb(59, 130, 246)",
      "#3b82f6;background:url(x)",
      " #3b82f6",
    ]) {
      await expect(mutate(store, { type: "set-section-color", sectionId, color })).rejects.toThrow();
    }
    expect(store.getSnapshot()).toEqual(before);
  });

  it("is only for a section the user made", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    for (const sectionId of ["unassigned", "people", OTHER_SECTION_ID]) {
      await expect(mutate(store, { type: "set-section-color", sectionId, color: "#3b82f6" })).rejects.toThrow();
    }
  });

  it("stays when the section is renamed and goes with the section when it is deleted", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    const sectionId = (await mutate(store, { type: "create", name: "Research" })).sections[0]?.id ?? "";
    await mutate(store, { type: "set-section-color", sectionId, color: "#8b5cf6" });
    const renamed = await mutate(store, { type: "rename", sectionId, name: "Lab" });
    expect(renamed.sections[0]).toEqual({ id: sectionId, name: "Lab", color: "#8b5cf6" });

    const deleted = await mutate(store, { type: "delete", sectionId });
    expect(deleted.sections).toEqual([]);
    expect(await readFile(file, "utf8")).not.toContain("#8b5cf6");

    const recreated = await mutate(store, { type: "create", name: "Lab" });
    expect(recreated.sections[0]?.color).toBeUndefined();
  });

  it("reads a saved layout without the field, of each file version", async () => {
    for (const version of [1, 2] as const) {
      const { file } = await layoutFile();
      await writeFile(file, storedLayout(version, [{ id: SECTION_ID, name: "Core team" }]));
      const store = await openStore(file);
      const layout = store.getSnapshot();
      expect(layout.revision).toBe(4);
      expect(layout.sections).toEqual([{ id: SECTION_ID, name: "Core team" }]);
      expect(layout.agentAssignments).toEqual({ "agent-one": SECTION_ID });
    }
  });

  it("drops a saved color that is not valid and keeps the sections and their chats", async () => {
    const { root, file } = await layoutFile();
    await writeFile(
      file,
      storedLayout(2, [
        { id: SECTION_ID, name: "Core team", color: "url(https://example.invalid/x)" },
        { id: OTHER_SECTION_ID, name: "Design", color: "#A855F7" },
      ]),
    );
    const store = await openStore(file);
    const layout = store.getSnapshot();
    expect(layout.revision).toBe(4);
    expect(layout.sections).toEqual([
      { id: SECTION_ID, name: "Core team" },
      { id: OTHER_SECTION_ID, name: "Design", color: "#a855f7" },
    ]);
    expect(layout.agentAssignments).toEqual({ "agent-one": SECTION_ID });
    expect((await readdir(root)).some((name) => name.includes(".corrupt-"))).toBe(false);
  });

  it("keeps the file version, so an older build still reads a colored layout", async () => {
    const { file } = await layoutFile();
    const store = await openStore(file);
    const sectionId = (await mutate(store, { type: "create", name: "Design" })).sections[0]?.id ?? "";
    await mutate(store, { type: "set-section-color", sectionId, color: "#06b6d4" });
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.version).toBe(2);
    expect(saved.sections).toEqual([{ id: sectionId, name: "Design", color: "#06b6d4" }]);
  });
});
