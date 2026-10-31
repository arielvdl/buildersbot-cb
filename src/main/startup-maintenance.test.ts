// @vitest-environment node
// Launch maintenance: the rebuildable caches go, the rotated logs older than a week go, and nothing
// that holds work does. Failure modes: a cache left behind; a live log deleted; a missing directory
// stopping the rest.
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";
import { afterEach, describe, expect, it } from "vitest";
import { runStartupMaintenance } from "./startup-maintenance";

const roots: string[] = [];

function logger() {
  return createBuildersBotLogger("startup-maintenance-test", () => undefined, "warn");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function profile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "startup-maintenance-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("runStartupMaintenance", () => {
  it("removes the rebuildable caches and keeps the rest of the profile", async () => {
    const root = await profile();
    await mkdir(join(root, "GPUCache", "nested"), { recursive: true });
    await writeFile(join(root, "GPUCache", "nested", "blob"), "x".repeat(2048));
    await writeFile(join(root, "openbot.db"), "database");
    await writeFile(join(root, "Local State"), "{}");

    await runStartupMaintenance(root, logger());

    expect(await exists(join(root, "GPUCache"))).toBe(false);
    expect(await exists(join(root, "openbot.db"))).toBe(true);
    expect(await exists(join(root, "Local State"))).toBe(true);
  });

  it("removes a stale rotated log and keeps the live one", async () => {
    const root = await profile();
    await mkdir(join(root, "logs", "main"), { recursive: true });
    await writeFile(join(root, "logs", "main", "main.log"), "live");
    await writeFile(join(root, "logs", "main", "main.log.1"), "rotated");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await (await import("node:fs/promises")).utimes(join(root, "logs", "main", "main.log.1"), old, old);

    await runStartupMaintenance(root, logger());

    expect(await exists(join(root, "logs", "main", "main.log"))).toBe(true);
    expect(await exists(join(root, "logs", "main", "main.log.1"))).toBe(false);
  });

  it("keeps a rotated log that is still recent", async () => {
    const root = await profile();
    await mkdir(join(root, "logs", "providers"), { recursive: true });
    await writeFile(join(root, "logs", "providers", "providers.log.1"), "rotated");

    await runStartupMaintenance(root, logger());

    expect(await exists(join(root, "logs", "providers", "providers.log.1"))).toBe(true);
  });

  it("keeps the code cache below its limit and removes it above", async () => {
    const root = await profile();
    await mkdir(join(root, "Code Cache", "js"), { recursive: true });
    await writeFile(join(root, "Code Cache", "js", "entry"), "x".repeat(4096));

    await runStartupMaintenance(root, logger());
    expect(await exists(join(root, "Code Cache", "js", "entry"))).toBe(true);
    await runStartupMaintenance(root, logger(), 8192);
    expect(await exists(join(root, "Code Cache", "js", "entry"))).toBe(true);

    await writeFile(join(root, "Code Cache", "js", "other"), "x".repeat(8192));
    await runStartupMaintenance(root, logger(), 8192);
    expect(await exists(join(root, "Code Cache"))).toBe(false);
  });

  it("survives a profile with no cache and no log directory", async () => {
    const root = await profile();
    await expect(runStartupMaintenance(root, logger())).resolves.toBeUndefined();
  });
});
