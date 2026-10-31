import { agentMarkEyelid } from "@openbot/brand/agent-mark-eyes";
import { avatarMarkRole } from "@openbot/brand/agent-mark-role";
import { AGENT_MARK_DANGER, agentMarkShades } from "@openbot/brand/agent-mark-shades";
import { avatarMoodIsBusy } from "@openbot/brand/bloub-avatar-motion";
import {
  avatarMoodInChat,
  channelMemberMood,
  channelWorkingMembers,
} from "@openbot/ui/features/agents/agent-avatar-mood";
import { describe, expect, it } from "vitest";

describe("avatarMarkRole", () => {
  it("reads titles in English and Portuguese, with any accent and case", () => {
    expect(avatarMarkRole("Pesquisadora de mercado")).toBe("research");
    expect(avatarMarkRole("Research partner")).toBe("research");
    expect(avatarMarkRole("ATENDIMENTO ao cliente")).toBe("support");
    expect(avatarMarkRole("Customer support")).toBe("support");
    expect(avatarMarkRole("Gestão financeira")).toBe("finance");
    expect(avatarMarkRole("Secretária de agenda")).toBe("calendar");
    expect(avatarMarkRole("Engenheiro de software")).toBe("code");
    expect(avatarMarkRole("Redator de conteúdo")).toBe("content");
    expect(avatarMarkRole("Deploy e infraestrutura")).toBe("deploy");
    expect(avatarMarkRole("Product designer")).toBe("design");
    expect(avatarMarkRole("Mídias sociais")).toBe("social");
    expect(avatarMarkRole("Monitoramento de preços")).toBe("monitor");
    expect(avatarMarkRole("Assistente pessoal")).toBe("personal");
  });

  it("gives the more specific role when a title names two", () => {
    expect(avatarMarkRole("Revisor de código")).toBe("review");
    expect(avatarMarkRole("Code reviewer")).toBe("review");
    expect(avatarMarkRole("Assistente de pesquisa")).toBe("research");
    expect(avatarMarkRole("DevOps engineer")).toBe("deploy");
  });

  it("matches a short stem only as a full word", () => {
    expect(avatarMarkRole("QA")).toBe("review");
    expect(avatarMarkRole("Quarterly planner")).toBeNull();
    expect(avatarMarkRole("Dev")).toBe("code");
    expect(avatarMarkRole("Devolutions")).toBeNull();
  });

  it("gives no emblem when the title has no known role", () => {
    expect(avatarMarkRole("Chief of staff")).toBeNull();
    expect(avatarMarkRole("")).toBeNull();
    expect(avatarMarkRole("   ")).toBeNull();
    expect(avatarMarkRole(undefined)).toBeNull();
    expect(avatarMarkRole("<b onclick=x>")).toBeNull();
  });
});

describe("live mood", () => {
  it("counts as busy, as working does", () => {
    expect(avatarMoodIsBusy("live")).toBe(true);
    expect(avatarMoodIsBusy("working")).toBe(true);
    expect(avatarMoodIsBusy("idle")).toBe(false);
    expect(avatarMoodIsBusy("waiting")).toBe(false);
  });

  it("replaces working only in the open chat", () => {
    expect(avatarMoodInChat("working", true)).toBe("live");
    expect(avatarMoodInChat("working", false)).toBe("working");
    for (const mood of ["idle", "waiting", "failed", "responded", "asleep"] as const) {
      expect(avatarMoodInChat(mood, true)).toBe(mood);
      expect(avatarMoodInChat(mood, false)).toBe(mood);
    }
  });
});

describe("channel faces", () => {
  const members = [{ agentId: "ana" }, { agentId: "bia" }, { agentId: "caio" }];

  it("moves only the members that work while the channel runs a task", () => {
    const working = channelWorkingMembers({ activeTasks: 1, members }, { bia: "working", caio: "waiting" });
    expect(channelMemberMood("bia", working, false)).toBe("working");
    expect(channelMemberMood("ana", working, false)).toBe("idle");
    expect(channelMemberMood("caio", working, false)).toBe("idle");
  });

  it("moves every member when the channel works and no member says so", () => {
    const working = channelWorkingMembers({ activeTasks: 2, members }, {});
    expect(working).toBe(true);
    for (const { agentId } of members) expect(channelMemberMood(agentId, working, false)).toBe("working");
  });

  it("keeps every face still when the channel runs no task", () => {
    const working = channelWorkingMembers({ activeTasks: 0, members }, { ana: "working" });
    expect(working).toBe(false);
    expect(channelMemberMood("ana", working, false)).toBe("idle");
    expect(channelMemberMood("ana", undefined, true)).toBe("idle");
  });

  it("works live in the open channel", () => {
    expect(channelMemberMood("ana", new Set(["ana"]), true)).toBe("live");
    expect(channelMemberMood("bia", new Set(["ana"]), true)).toBe("idle");
  });
});

describe("agentMarkEyelid", () => {
  it("opens the eyes more as the agent gets busier", () => {
    expect(agentMarkEyelid("live")).toBe(0);
    expect(agentMarkEyelid("working")).toBeLessThan(agentMarkEyelid("waiting"));
    expect(agentMarkEyelid("waiting")).toBeLessThan(agentMarkEyelid("idle"));
    expect(agentMarkEyelid("idle")).toBe(0.4);
  });

  it("closes the eyes of a failed or sleeping agent", () => {
    expect(agentMarkEyelid("failed")).toBeGreaterThan(0.9);
    expect(agentMarkEyelid("asleep")).toBeGreaterThan(0.9);
  });
});

describe("agentMarkShades", () => {
  it("puts white symbols on a dark lid and dark ink on a light lid", () => {
    expect(agentMarkShades("#3b93f0").glyph).toBe("#ffffff");
    expect(agentMarkShades("#e8483f").glyph).toBe("#ffffff");
    expect(agentMarkShades(AGENT_MARK_DANGER).glyph).toBe("#ffffff");
    expect(agentMarkShades("#98f94f").glyph).not.toBe("#ffffff");
    expect(agentMarkShades("#f0b429").glyph).not.toBe("#ffffff");
  });

  it("makes the sides darker than the lid, and the outline darker than the sides", () => {
    const shades = agentMarkShades("#3b93f0");
    const light = (hex: string) => Number.parseInt(hex.slice(1, 3), 16) + Number.parseInt(hex.slice(3, 5), 16);
    expect(shades.top).toBe("#3b93f0");
    expect(light(shades.right)).toBeLessThan(light(shades.top));
    expect(light(shades.left)).toBeLessThan(light(shades.right));
    expect(light(shades.ink)).toBeLessThan(light(shades.left));
  });

  it("lets the browser mix the shades of a colour that is not hex", () => {
    const shades = agentMarkShades("var(--openbot-logo-production)");
    expect(shades.right).toContain("color-mix(");
    expect(shades.glyph).toContain("oklch(from var(--openbot-logo-production)");
  });
});
