// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AppearanceService } from "./appearance-service";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function path(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "appearance-"));
  roots.push(root);
  return join(root, "appearance.json");
}

const load = async (file: string, supportsTransparentWindow = true) => {
  const service = new AppearanceService({ path: file, supportsTransparentWindow });
  return Effect.runPromise(service.load());
};

describe("the default appearance", () => {
  it("is dark with an opaque window when nothing was saved", async () => {
    expect(await load(await path())).toEqual({ appearance: "dark", transparentWindow: false });
  });

  it("is the default for a file saved before the transparent window existed", async () => {
    const file = await path();
    await writeFile(file, JSON.stringify({ version: 1, appearance: "light" }));
    expect(await load(file)).toEqual({ appearance: "light", transparentWindow: false });
  });

  it("keeps a transparent window that the person chose", async () => {
    const file = await path();
    await writeFile(file, JSON.stringify({ version: 1, appearance: "dark", transparentWindow: true }));
    expect(await load(file)).toEqual({ appearance: "dark", transparentWindow: true });
  });

  it("reads as opaque where the window cannot blur the desktop", async () => {
    const file = await path();
    await writeFile(file, JSON.stringify({ version: 1, appearance: "dark", transparentWindow: true }));
    expect((await load(file, false)).transparentWindow).toBe(false);
  });
});
