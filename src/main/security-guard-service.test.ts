// The stored reviewer setting: on by default, a change keeps the other choices, and a file this
// build cannot read reads as the default instead of stopping the app.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SECURITY_GUARD_PREFERENCE, parseSecurityGuardPreferenceChange } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SecurityGuardService } from "./security-guard-service";

const directories: string[] = [];

async function serviceWith(contents?: string) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-security-guard-"));
  directories.push(directory);
  const path = join(directory, "guard.json");
  if (contents !== undefined) await writeFile(path, contents, "utf8");
  const service = new SecurityGuardService(path);
  await Effect.runPromise(service.load());
  return { service, path };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SecurityGuardService", () => {
  it("is on, on every message, with the model of the agent", async () => {
    const { service } = await serviceWith();
    expect(service.get()).toEqual(DEFAULT_SECURITY_GUARD_PREFERENCE);
    expect(service.get().enabled).toBe(true);
  });

  it("keeps the other choices when one changes", async () => {
    const { service } = await serviceWith();
    const saved = await Effect.runPromise(service.set({ scope: "signals", mode: "strict" }));
    expect(saved.scope).toBe("signals");
    expect(saved.mode).toBe("strict");
    expect(saved.enabled).toBe(true);
    const off = await Effect.runPromise(service.set({ enabled: false }));
    expect(off.enabled).toBe(false);
    expect(off.scope).toBe("signals");
  });

  it("writes the change to the file", async () => {
    const { service, path } = await serviceWith();
    await Effect.runPromise(service.set({ timeoutMs: 5_000 }));
    const stored: { version: number; timeoutMs: number } = JSON.parse(await readFile(path, "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.timeoutMs).toBe(5_000);
  });

  it("reads a stored file back", async () => {
    const stored = { ...DEFAULT_SECURITY_GUARD_PREFERENCE, version: 1, enabled: false, minLevel: "injection" };
    const { service } = await serviceWith(JSON.stringify(stored));
    expect(service.get().enabled).toBe(false);
    expect(service.get().minLevel).toBe("injection");
  });

  it("falls back to the default when the file is not this shape", async () => {
    const { service } = await serviceWith('{"version":1,"enabled":"yes"}');
    expect(service.get()).toEqual(DEFAULT_SECURITY_GUARD_PREFERENCE);
  });

  it("falls back to the default when the file is not JSON", async () => {
    const { service } = await serviceWith("not json");
    expect(service.get()).toEqual(DEFAULT_SECURITY_GUARD_PREFERENCE);
  });
});

describe("parseSecurityGuardPreferenceChange", () => {
  it("reads a switch", () => {
    expect(parseSecurityGuardPreferenceChange({ enabled: false })).toEqual({ enabled: false });
  });

  it("reads a null model, which means the model of the agent", () => {
    expect(parseSecurityGuardPreferenceChange({ model: null })).toEqual({ model: null });
  });

  it("refuses an empty change", () => {
    expect(() => parseSecurityGuardPreferenceChange({})).toThrow();
  });

  it("refuses an unknown scope", () => {
    expect(() => parseSecurityGuardPreferenceChange({ scope: "some" })).toThrow();
  });

  it("refuses a deadline outside the bounds", () => {
    expect(() => parseSecurityGuardPreferenceChange({ timeoutMs: 500 })).toThrow();
  });
});
