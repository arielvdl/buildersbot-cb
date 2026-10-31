import { type AgentProviderId, type AgentProviderState, defaultProviderModel } from "@openbot/contracts/ipc";
import type { ProviderPickerOption } from "@openbot/ui/components/ProviderPicker";
import { describe, expect, it } from "vitest";
import {
  automaticProviderChoice,
  FEATURED_PROVIDER,
  FREE_PROVIDER,
  onboardingProviderRows,
} from "./onboarding-provider-rows";

function option(
  id: AgentProviderId,
  state: AgentProviderState = "not-installed",
  extra: Partial<ProviderPickerOption> = {},
): ProviderPickerOption {
  return { id, name: id, state, ...extra };
}

/** The setup options in registry order, with the free provider as setup marks it. */
function setupOptions(states: Partial<Record<AgentProviderId, AgentProviderState>> = {}): ProviderPickerOption[] {
  const ids: AgentProviderId[] = ["cultura-builder", "codex", "claude", "grok", "opencode", "antigravity", "cursor"];
  return ids.map((id) => option(id, states[id] ?? "not-installed", id === FREE_PROVIDER ? { freeModels: true } : {}));
}

const ids = (options: readonly ProviderPickerOption[]) => options.map((candidate) => candidate.id);
const neverReady = () => false;

describe("the provider rows of setup", () => {
  it("lists Cultura Builder first in every state, and the free provider last", () => {
    const states: AgentProviderState[] = ["not-started", "checking", "not-installed", "sign-in-required", "error"];
    for (const state of states) {
      const rows = onboardingProviderRows(setupOptions({ "cultura-builder": state, claude: "available" }));
      expect(ids(rows.listed)).toEqual(["cultura-builder", "claude", "codex", "grok", "opencode"]);
    }
  });

  it("keeps Cultura Builder first when the user kept other rows, and does not repeat it", () => {
    const rows = onboardingProviderRows(setupOptions(), ["grok", "cultura-builder", "cursor"]);
    expect(ids(rows.listed)).toEqual(["cultura-builder", "grok", "cursor", "codex", "claude", "opencode"]);
  });

  it("hides no provider: each one is a row or is in More providers", () => {
    const options = setupOptions({ cursor: "available" });
    for (const includeFree of [true, false]) {
      const rows = onboardingProviderRows(options, [], includeFree);
      expect([...ids(rows.listed), ...ids(rows.hidden)].sort()).toEqual(ids(options).sort());
    }
    const plan = onboardingProviderRows(options, [], false);
    expect(ids(plan.listed)[0]).toBe(FEATURED_PROVIDER);
    expect(ids(plan.listed)).not.toContain(FREE_PROVIDER);
    expect(ids(plan.hidden).at(-1)).toBe(FREE_PROVIDER);
  });

  it("keeps the earlier rule when Cultura Builder is not an option, as on a joined server", () => {
    const options = setupOptions({ cursor: "sign-in-required" }).filter(
      (candidate) => candidate.id !== FEATURED_PROVIDER,
    );
    expect(ids(onboardingProviderRows(options).listed)).toEqual(["cursor", "codex", "claude", "opencode"]);
  });
});

describe("the provider that setup selects by itself", () => {
  it("is Cultura Builder before it is connected, also beside a connected provider", () => {
    expect(automaticProviderChoice(setupOptions({ claude: "available" }), neverReady)).toBe(FEATURED_PROVIDER);
    expect(automaticProviderChoice(setupOptions({ "cultura-builder": "error", codex: "available" }), neverReady)).toBe(
      FEATURED_PROVIDER,
    );
  });

  it("starts the first agent on the normal Cultura Builder model", () => {
    expect(defaultProviderModel(FEATURED_PROVIDER)).toBe("cultura-builder/builder-auto");
  });

  it("without Cultura Builder, is a connected provider, then an installed one, then a ready one", () => {
    const withoutFeatured = (states: Partial<Record<AgentProviderId, AgentProviderState>>) =>
      setupOptions(states).filter((candidate) => candidate.id !== FEATURED_PROVIDER);
    expect(automaticProviderChoice(withoutFeatured({ grok: "available", codex: "sign-in-required" }), neverReady)).toBe(
      "grok",
    );
    expect(
      automaticProviderChoice(
        withoutFeatured({ opencode: "sign-in-required", claude: "sign-in-required" }),
        neverReady,
      ),
    ).toBe("claude");
    expect(automaticProviderChoice(withoutFeatured({}), (candidate) => candidate.id === FREE_PROVIDER)).toBe(
      FREE_PROVIDER,
    );
    expect(automaticProviderChoice(withoutFeatured({}), neverReady)).toBeNull();
    expect(automaticProviderChoice([], neverReady)).toBeNull();
  });
});
