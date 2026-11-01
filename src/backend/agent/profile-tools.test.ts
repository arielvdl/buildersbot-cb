import { describe, expect, it } from "vitest";
import { widensBackupModels } from "./profile-tools";

const target = {
  id: "front",
  provider: "claude" as const,
  model: "claude-opus",
  providerAccountId: undefined,
  backupModels: { automatic: false, order: [{ provider: "claude" as const, model: "claude-sonnet" }] },
};

describe("widensBackupModels", () => {
  it("lets only the user give another agent a backup that switches without asking", () => {
    expect(widensBackupModels(target, "lead", { automatic: true, order: target.backupModels.order })).toBe(true);
    // The agent itself may.
    expect(widensBackupModels(target, "front", { automatic: true, order: target.backupModels.order })).toBe(false);
  });

  it("lets only the user add a provider account that the other agent does not use", () => {
    expect(
      widensBackupModels(target, "lead", { automatic: false, order: [{ provider: "opencode", model: "free" }] }),
    ).toBe(true);
    expect(
      widensBackupModels(target, "lead", {
        automatic: false,
        order: [{ provider: "claude", model: "claude-haiku", providerAccountId: "second" }],
      }),
    ).toBe(true);
  });

  it("lets an agent keep, reorder or remove another agent's backups", () => {
    expect(
      widensBackupModels(target, "lead", { automatic: false, order: [{ provider: "claude", model: "claude-haiku" }] }),
    ).toBe(false);
    expect(widensBackupModels(target, "lead", null)).toBe(false);
    expect(widensBackupModels(target, "lead", undefined)).toBe(false);
    expect(
      widensBackupModels({ ...target, backupModels: { automatic: true, order: [] } }, "lead", {
        automatic: true,
        order: [{ provider: "claude", model: "claude-haiku" }],
      }),
    ).toBe(false);
  });
});
