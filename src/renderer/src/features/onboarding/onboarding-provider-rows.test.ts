import {
  type AgentProviderId,
  type AgentProviderState,
  defaultProviderModel,
  type ProviderRuntimeStatus,
} from "@openbot/contracts/ipc";
import type { ProviderPickerOption } from "@openbot/ui/components/ProviderPicker";
import { describe, expect, it } from "vitest";
import {
  automaticProviderChoice,
  FEATURED_PROVIDER,
  FREE_PROVIDER,
  onboardingProviderRows,
} from "./onboarding-provider-rows";
import { freeInstallStep, piNoticeAction, piWaiters } from "./setup-provider-notices";

function option(
  id: AgentProviderId,
  state: AgentProviderState = "not-installed",
  extra: Partial<ProviderPickerOption> = {},
): ProviderPickerOption {
  return { id, name: id, state, ...extra };
}

/** The setup options in registry order, with the free provider as setup marks it. */
function setupOptions(states: Partial<Record<AgentProviderId, AgentProviderState>> = {}): ProviderPickerOption[] {
  const ids: AgentProviderId[] = [
    "cultura-builder",
    "codex",
    "claude",
    "grok",
    "opencode",
    "antigravity",
    "cursor",
    "pi",
    "inception",
    "deepseek",
    "openrouter",
  ];
  return ids.map((id) => option(id, states[id] ?? "not-installed", id === FREE_PROVIDER ? { freeModels: true } : {}));
}

const ids = (options: readonly ProviderPickerOption[]) => options.map((candidate) => candidate.id);
const neverReady = () => false;
const ON_HOST = new Set<AgentProviderId>([FEATURED_PROVIDER]);

/** The joined server of the owner's report, as setup sees it. */
const OWNER_HOST = setupOptions({
  "cultura-builder": "error",
  codex: "available",
  claude: "available",
  grok: "outdated",
  pi: "outdated",
  inception: "outdated",
  deepseek: "outdated",
  openrouter: "outdated",
  opencode: "available",
}).filter((candidate) => candidate.id !== "antigravity" && candidate.id !== "cursor");

describe("the provider rows of setup", () => {
  it("puts Builders first, then the connected accounts, and moves what cannot be used yet to More providers", () => {
    const rows = onboardingProviderRows(OWNER_HOST, { unreachable: ON_HOST });
    expect(ids(rows.listed)).toEqual(["opencode", "codex", "claude"]);
    expect(ids(rows.hidden)).toEqual(["cultura-builder", "grok", "pi", "inception", "deepseek", "openrouter"]);
  });

  it("lists Cultura Builder after the connected accounts where this window can connect it", () => {
    for (const state of ["not-started", "checking", "not-installed", "sign-in-required", "error"] as const) {
      const rows = onboardingProviderRows(setupOptions({ "cultura-builder": state, claude: "available" }));
      expect(ids(rows.listed)).toEqual(["opencode", "claude", "cultura-builder", "codex", "grok"]);
    }
    const connected = onboardingProviderRows(setupOptions({ "cultura-builder": "available", claude: "available" }));
    expect(ids(connected.listed)).toEqual(["opencode", "cultura-builder", "claude", "codex", "grok"]);
  });

  it("lists a connected Cultura Builder on a joined server", () => {
    const rows = onboardingProviderRows(setupOptions({ "cultura-builder": "available" }), { unreachable: new Set() });
    expect(ids(rows.listed).slice(0, 2)).toEqual(["opencode", "cultura-builder"]);
  });

  it("keeps Cultura Builder first on the plan step, which has no free row", () => {
    for (const state of ["not-started", "sign-in-required", "error"] as const) {
      const rows = onboardingProviderRows(setupOptions({ "cultura-builder": state, claude: "available" }), {
        includeFree: false,
      });
      expect(ids(rows.listed)).toEqual(["cultura-builder", "claude", "codex", "grok"]);
      expect(ids(rows.hidden).at(-1)).toBe(FREE_PROVIDER);
    }
  });

  it("keeps the rows that the user saw in their order, and does not repeat one", () => {
    const rows = onboardingProviderRows(setupOptions(), { kept: ["grok", "cultura-builder", "cursor"] });
    expect(ids(rows.listed)).toEqual(["opencode", "grok", "cultura-builder", "cursor", "codex", "claude"]);
  });

  it("keeps a row that the user chose from More providers, also when its CLI is too old", () => {
    const rows = onboardingProviderRows(OWNER_HOST, { unreachable: ON_HOST, kept: ["codex", "claude", "deepseek"] });
    expect(ids(rows.listed)).toEqual(["opencode", "codex", "claude", "deepseek"]);
  });

  it("hides no provider: each one is a row or is in More providers", () => {
    const options = setupOptions({ cursor: "available", grok: "outdated" });
    for (const includeFree of [true, false]) {
      for (const unreachable of [new Set<AgentProviderId>(), ON_HOST]) {
        const rows = onboardingProviderRows(options, { includeFree, unreachable });
        expect([...ids(rows.listed), ...ids(rows.hidden)].sort()).toEqual(ids(options).sort());
      }
    }
  });

  it("does not list Pi and the key providers that only wait for a key, when Pi is up to date", () => {
    // The joined server of the report after a Pi update: the shared Pi CLI makes Pi and each key
    // provider wait for a sign-in, although the user has no key.
    const updated = OWNER_HOST.map((candidate) =>
      candidate.id === "pi" ||
      candidate.id === "inception" ||
      candidate.id === "deepseek" ||
      candidate.id === "openrouter"
        ? { ...candidate, state: "sign-in-required" as const }
        : candidate,
    );
    const rows = onboardingProviderRows(updated, { unreachable: ON_HOST });
    expect(ids(rows.listed)).toEqual(["opencode", "codex", "claude"]);
    expect(ids(rows.hidden)).toEqual(["pi", "inception", "deepseek", "openrouter", "cultura-builder", "grok"]);
    // A key provider that is connected is a row, as each connected account is.
    const keyed = updated.map((candidate) =>
      candidate.id === "deepseek" ? { ...candidate, state: "available" as const } : candidate,
    );
    expect(ids(onboardingProviderRows(keyed, { unreachable: ON_HOST }).listed)).toEqual([
      "opencode",
      "codex",
      "claude",
      "deepseek",
    ]);
    // The popular rows still fill the list where no account is connected.
    const waiting = setupOptions({
      pi: "sign-in-required",
      inception: "sign-in-required",
      openrouter: "sign-in-required",
    });
    expect(ids(onboardingProviderRows(waiting).listed)).toEqual([
      "opencode",
      "cultura-builder",
      "codex",
      "claude",
      "grok",
    ]);
    // And the step never chooses one of them by itself.
    const plan = waiting.filter((candidate) => candidate.id !== FEATURED_PROVIDER && candidate.id !== FREE_PROVIDER);
    expect(automaticProviderChoice(plan, neverReady)).toBeNull();
  });

  it("keeps the popular rule on a joined server without Cultura Builder", () => {
    const options = setupOptions({ cursor: "sign-in-required" }).filter(
      (candidate) => candidate.id !== FEATURED_PROVIDER,
    );
    expect(ids(onboardingProviderRows(options).listed)).toEqual(["opencode", "cursor", "codex", "claude"]);
  });
});

describe("the provider that setup selects by itself", () => {
  it("is Builders while no other provider is connected, where Builders is a row", () => {
    expect(automaticProviderChoice(setupOptions(), neverReady, { recommendFree: true })).toBe(FREE_PROVIDER);
    expect(
      automaticProviderChoice(setupOptions({ opencode: "available", grok: "sign-in-required" }), neverReady, {
        recommendFree: true,
      }),
    ).toBe(FREE_PROVIDER);
  });

  it("is a connected account where Builders is a row, Cultura Builder first", () => {
    expect(automaticProviderChoice(OWNER_HOST, neverReady, { recommendFree: true, unreachable: ON_HOST })).toBe(
      "codex",
    );
    expect(
      automaticProviderChoice(setupOptions({ "cultura-builder": "available", codex: "available" }), neverReady, {
        recommendFree: true,
      }),
    ).toBe(FEATURED_PROVIDER);
  });

  it("is never a provider that this window cannot connect", () => {
    const options = OWNER_HOST.filter((candidate) => candidate.id !== FREE_PROVIDER);
    expect(automaticProviderChoice(options, neverReady, { unreachable: ON_HOST })).toBe("codex");
  });

  it("is Cultura Builder on the plan step, also before it is connected", () => {
    const plan = (states: Partial<Record<AgentProviderId, AgentProviderState>>) =>
      setupOptions(states).filter((candidate) => candidate.id !== FREE_PROVIDER);
    expect(automaticProviderChoice(plan({ claude: "available" }), neverReady)).toBe(FEATURED_PROVIDER);
    expect(automaticProviderChoice(plan({ "cultura-builder": "error", codex: "available" }), neverReady)).toBe(
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

const runtime = (phase: ProviderRuntimeStatus["phase"], progress: number | null = null): ProviderRuntimeStatus => ({
  phase,
  progress,
  message: null,
  version: null,
});

describe("the notices below the provider rows", () => {
  it("suggest Builders while its runtime is missing, show its progress, and offer a retry", () => {
    const free = (phase: ProviderRuntimeStatus["phase"]) =>
      option(FREE_PROVIDER, "not-installed", { runtimeStatus: runtime(phase) });
    expect(freeInstallStep(free("not-downloaded"), true)).toBe("install");
    expect(freeInstallStep(free("downloading"), true)).toBe("installing");
    expect(freeInstallStep(free("finishing"), true)).toBe("finishing");
    expect(freeInstallStep(free("download-error"), true)).toBe("retry");
    expect(freeInstallStep(free("ready"), true)).toBeNull();
    // Without a download there is no button that could install it.
    expect(freeInstallStep(free("not-downloaded"), false)).toBeNull();
    expect(freeInstallStep(undefined, true)).toBeNull();
  });

  it("name each key provider that waits for Pi once", () => {
    const rows = onboardingProviderRows(OWNER_HOST, {
      unreachable: ON_HOST,
      kept: ["codex", "claude", "inception", "deepseek", "grok"],
    });
    expect(ids(piWaiters(rows.listed))).toEqual(["inception", "deepseek"]);
    expect(piWaiters(onboardingProviderRows(OWNER_HOST, { unreachable: ON_HOST }).listed)).toEqual([]);
  });

  it("give the Pi notice one action that a handler can run", () => {
    const pi = (phase: ProviderRuntimeStatus["phase"]) => option("pi", "outdated", { runtimeStatus: runtime(phase) });
    const all = { download: true, update: true };
    expect(piNoticeAction(pi("not-downloaded"), all)).toBe("download");
    expect(piNoticeAction(pi("download-error"), all)).toBe("download");
    expect(piNoticeAction(pi("ready"), all)).toBe("update");
    expect(piNoticeAction(pi("downloading"), all)).toBe("progress");
    expect(piNoticeAction(pi("not-downloaded"), { download: false, update: true })).toBeNull();
    expect(piNoticeAction(pi("ready"), { download: true, update: false })).toBeNull();
    expect(piNoticeAction(undefined, all)).toBeNull();
  });
});
