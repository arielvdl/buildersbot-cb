// @vitest-environment node
// The list of encrypted files that this computer cannot decrypt now, for Settings › General. It holds
// the store and the file name, never a value, and it reads the state at each call.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuildersBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CUSTOM_AGENTS_FILE, CustomAgentStore } from "./custom-agent-store";
import { logUnreadableSecrets, registerSecretHealthSource, unreadableSecrets } from "./secret-health";

const VALUE = "sk_test_agent_value_5e1a";

/** A keychain item with a name. It decrypts only what it sealed itself, as `safeStorage` does. */
function keychain(name: string) {
  return {
    canPersist: () => true,
    encrypt: (value: string) => Buffer.from(`${name}\n${value}`, "utf8"),
    decrypt: (value: Buffer) => {
      const [sealedBy, ...rest] = value.toString("utf8").split("\n");
      if (sealedBy !== name) throw new Error("Cannot decrypt.");
      return rest.join("\n");
    },
  };
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the secret health list", () => {
  it("counts a custom agent whose values were sealed by another keychain item", async () => {
    const root = await mkdtemp(join(tmpdir(), "secret-health-"));
    roots.push(root);
    const path = join(root, CUSTOM_AGENTS_FILE);
    const resolve = () => Effect.succeed("/usr/bin/true");
    const before = new CustomAgentStore({ path, cipher: keychain("old"), resolve });
    await Effect.runPromise(before.load());
    await Effect.runPromise(
      before.save({
        id: "test-agent",
        name: "Test agent",
        command: "/usr/bin/true",
        args: [],
        env: [{ name: "TEST_TOKEN", value: VALUE }],
        usagePrompt: null,
      }),
    );
    const after = new CustomAgentStore({ path, cipher: keychain("new"), resolve });
    await Effect.runPromise(after.load());

    expect(before.unreadableSecretCount()).toBe(0);
    expect(after.unreadableSecretCount()).toBe(1);
  });

  it("lists only the stores that cannot read their file now, with the file name and no value", () => {
    let voiceKeyUnreadable = true;
    registerSecretHealthSource("voice-api-key", "voice-api-key.json", () => voiceKeyUnreadable);
    registerSecretHealthSource("voice-server-key", "voice-server-key.json", () => false);
    registerSecretHealthSource("custom-agents", CUSTOM_AGENTS_FILE, () => true);
    // A store that throws says nothing about its file, so it is not listed.
    registerSecretHealthSource("provider-credentials", "provider-credentials.json", () => {
      throw new Error(VALUE);
    });

    expect(unreadableSecrets()).toEqual([
      { store: "voice-api-key", file: "voice-api-key.json" },
      { store: "custom-agents", file: CUSTOM_AGENTS_FILE },
    ]);

    // A key that is saved again leaves the list at once.
    voiceKeyUnreadable = false;
    expect(unreadableSecrets()).toEqual([{ store: "custom-agents", file: CUSTOM_AGENTS_FILE }]);
  });

  it("logs the file names in one line, and nothing when every file is readable", () => {
    const lines: string[] = [];
    const logger = createBuildersBotLogger("secret-health-test", (line) => lines.push(line));
    registerSecretHealthSource("custom-agents", CUSTOM_AGENTS_FILE, () => true);

    logUnreadableSecrets(logger);
    registerSecretHealthSource("custom-agents", CUSTOM_AGENTS_FILE, () => false);
    for (const store of ["voice-api-key", "voice-server-key", "provider-credentials"] as const)
      registerSecretHealthSource(store, `${store}.json`, () => false);
    logUnreadableSecrets(logger);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CUSTOM_AGENTS_FILE);
    expect(lines[0]).not.toContain(VALUE);
  });
});
