// @vitest-environment node
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SidebarLayoutAction, SidebarLayoutSnapshot, SidebarMarkerStyle } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarLayoutStore } from "./sidebar-layout-store";

const SECTION_ID = "11111111-1111-4111-8111-111111111111";
const CHATS = new Set(["scout", "writer", "hacker", "launch"]);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function layoutFile(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "sidebar-markers-"));
  roots.push(root);
  return { root, file: join(root, "openbot-sidebar-layout-v1.json") };
}

async function openStore(file: string): Promise<SidebarLayoutStore> {
  const store = new SidebarLayoutStore(file);
  await Effect.runPromise(store.initialize());
  return store;
}

function mutate(store: SidebarLayoutStore, action: SidebarLayoutAction): Promise<SidebarLayoutSnapshot> {
  return Effect.runPromise(store.mutate(action, CHATS));
}

/** A store with one section "naia" that files scout, writer and the launch channel, in that order. */
async function naiaStore(): Promise<{ store: SidebarLayoutStore; file: string; sectionId: string }> {
  const { file } = await layoutFile();
  const store = await openStore(file);
  const created = await mutate(store, { type: "create", name: "naia" });
  const sectionId = created.sections[0]?.id ?? "";
  for (const chat of ["scout", "writer", "launch"]) {
    await mutate(store, { type: "move-agent", agentId: chat, sectionId, beforeAgentId: null });
  }
  return { store, file, sectionId };
}

function marker(
  sectionId: string | null,
  label = "",
  style: SidebarMarkerStyle = "normal",
  color: string | null = null,
) {
  return { type: "create-marker", sectionId, label, style, color } as const;
}

describe("a sidebar marker", () => {
  it("goes to the top of its section, and agentOrder never holds it", async () => {
    const { store, sectionId } = await naiaStore();
    const layout = await mutate(store, marker(sectionId, " Done "));
    const id = layout.markers?.[0]?.id ?? "";
    expect(layout.markers).toEqual([{ id, sectionId, label: "Done", style: "normal" }]);
    expect(id).toMatch(/^marker:/);
    expect(layout.itemOrder?.filter((item) => item !== "hacker")).toEqual([id, "scout", "writer", "launch"]);
    expect(layout.agentOrder).not.toContain(id);
  });

  it("moves before a chat, and a chat moves before it, in its section", async () => {
    const { store, sectionId } = await naiaStore();
    const id = (await mutate(store, marker(sectionId, "Done"))).markers?.[0]?.id ?? "";
    let layout = await mutate(store, { type: "move-marker", markerId: id, sectionId, beforeId: "launch" });
    expect(layout.itemOrder?.filter((item) => item !== "hacker")).toEqual(["scout", "writer", id, "launch"]);
    // A chat dropped right after the marker goes below it; one dropped before it goes above it.
    layout = await mutate(store, { type: "move-agent", agentId: "scout", sectionId, beforeAgentId: "launch" });
    expect(layout.itemOrder?.filter((item) => item !== "hacker")).toEqual(["writer", id, "scout", "launch"]);
    layout = await mutate(store, { type: "move-agent", agentId: "launch", sectionId, beforeAgentId: id });
    expect(layout.itemOrder?.filter((item) => item !== "hacker")).toEqual(["writer", "launch", id, "scout"]);
    expect(layout.agentOrder.filter((item) => item !== "hacker")).toEqual(["writer", "launch", "scout"]);
  });

  it("changes its text and style, and keeps a color only for the tint style", async () => {
    const { store, sectionId } = await naiaStore();
    const id = (await mutate(store, marker(sectionId))).markers?.[0]?.id ?? "";
    let layout = await mutate(store, {
      type: "update-marker",
      markerId: id,
      label: "Soon",
      style: "tint",
      color: "#3B82F6",
    });
    expect(layout.markers?.[0]).toEqual({ id, sectionId, label: "Soon", style: "tint", color: "#3b82f6" });
    layout = await mutate(store, { type: "update-marker", markerId: id, label: "Soon", style: "dim", color: null });
    expect(layout.markers?.[0]).toEqual({ id, sectionId, label: "Soon", style: "dim" });
  });

  it("refuses a bad text, style, color, section or target, and keeps the layout", async () => {
    const { store, sectionId } = await naiaStore();
    const id = (await mutate(store, marker(sectionId))).markers?.[0]?.id ?? "";
    const before = store.getSnapshot();
    const bad: SidebarLayoutAction[] = [
      { type: "update-marker", markerId: id, label: "x".repeat(41), style: "dim", color: null },
      { type: "update-marker", markerId: id, label: "a\nb", style: "dim", color: null },
      { type: "update-marker", markerId: id, label: "", style: "tint", color: "blue" },
      { type: "update-marker", markerId: id, label: "", style: "dim", color: "#3b82f6" },
      {
        type: "create-marker",
        sectionId: "22222222-2222-4222-8222-222222222222",
        label: "",
        style: "dim",
        color: null,
      },
      { type: "move-marker", markerId: id, sectionId, beforeId: "hacker" },
      { type: "delete-marker", markerId: "marker:00000000-0000-4000-8000-000000000000" },
    ];
    for (const action of bad) await expect(mutate(store, action)).rejects.toThrow();
    expect(store.getSnapshot()).toEqual(before);
  });

  it("allows 12 markers in a section", async () => {
    const { store, sectionId } = await naiaStore();
    for (let index = 0; index < 12; index++) await mutate(store, marker(sectionId));
    await expect(mutate(store, marker(sectionId))).rejects.toThrow();
    expect(store.getSnapshot().markers).toHaveLength(12);
    await expect(mutate(store, marker(null))).resolves.toBeDefined();
  });

  it("goes with its section, and the last one drops the marker fields", async () => {
    const { store, sectionId } = await naiaStore();
    await mutate(store, marker(sectionId, "Done"));
    const layout = await mutate(store, { type: "delete", sectionId });
    expect(layout.markers).toBeUndefined();
    expect(layout.itemOrder).toBeUndefined();
    expect(layout.agentAssignments).toEqual({});
  });

  it("keeps its place when a chat is deleted, and after a restart", async () => {
    const { store, file, sectionId } = await naiaStore();
    const id = (await mutate(store, marker(sectionId, "Done"))).markers?.[0]?.id ?? "";
    await mutate(store, { type: "move-marker", markerId: id, sectionId, beforeId: "writer" });
    await Effect.runPromise(store.removeAgent("scout"));
    const reopened = await openStore(file);
    const layout = reopened.getSnapshot();
    expect(layout.itemOrder?.filter((item) => item !== "hacker")).toEqual([id, "writer", "launch"]);
    expect(layout.markers?.[0]?.label).toBe("Done");
  });

  it("is dropped from the file when it is not valid, and the sections and chats stay", async () => {
    const { root, file } = await layoutFile();
    const good = "marker:11111111-2222-4333-8444-555555555555";
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        revision: 3,
        sections: [{ id: SECTION_ID, name: "naia" }],
        order: ["people", SECTION_ID, "unassigned"],
        agentAssignments: { scout: SECTION_ID },
        agentOrder: ["scout"],
        markers: [
          { id: good, sectionId: SECTION_ID, label: "Done", style: "dim" },
          { id: "marker:bad", sectionId: SECTION_ID, label: "x", style: "dim" },
          { id: "marker:22222222-2222-4222-8222-222222222222", sectionId: SECTION_ID, label: "x", style: "glow" },
          { id: "marker:33333333-3333-4333-8333-333333333333", sectionId: "gone", label: "x", style: "dim" },
          "junk",
        ],
        itemOrder: ["scout", good, "marker:bad", 7],
      }),
    );
    const layout = (await openStore(file)).getSnapshot();
    expect(layout.sections).toEqual([{ id: SECTION_ID, name: "naia" }]);
    expect(layout.agentAssignments).toEqual({ scout: SECTION_ID });
    expect(layout.markers).toEqual([{ id: good, sectionId: SECTION_ID, label: "Done", style: "dim" }]);
    expect(layout.itemOrder).toEqual(["scout", good]);
    expect((await readdir(root)).some((name) => name.includes(".corrupt-"))).toBe(false);
  });
});
