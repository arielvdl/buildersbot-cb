import { isKeyOnlyProvider } from "@openbot/contracts/agent-providers";
import type { AgentProviderId } from "@openbot/contracts/ipc";
import type { ProviderPickerOption } from "@openbot/ui/components/ProviderPicker";

/** The plan providers that most users have. They fill the plan rows that owned providers leave. */
const POPULAR_PROVIDERS: readonly AgentProviderId[] = ["codex", "claude", "grok"];
/**
 * Builders: free models with no account. Where the step offers it, it is the recommended first row
 * and the choice while no other provider is connected.
 */
export const FREE_PROVIDER: AgentProviderId = "opencode";
/**
 * The official provider. Where the step has no free row, as on the plan step of first run, it is
 * the first row and the first choice. A user who has a Cultura Builder account connects it there.
 */
export const FEATURED_PROVIDER: AgentProviderId = "cultura-builder";
/**
 * The number of plan rows that popular providers fill, beside the featured row. Connected and owned
 * providers can make the list longer.
 */
const PLAN_ROWS = 3;

export interface OnboardingProviderRows {
  /** The rows of the list: the recommended provider first, then connected accounts, then the rest. */
  listed: ProviderPickerOption[];
  /** The providers behind "More providers": usable plan providers first, then the blocked ones. */
  hidden: ProviderPickerOption[];
}

export interface OnboardingRowRule {
  /**
   * The rows that must stay in the list in their order: the rows the user saw when they first used
   * the list, and each provider that they chose from "More providers".
   */
  kept?: readonly AgentProviderId[];
  /**
   * Whether the free provider is a row. Then it is the first row. Without it the free provider is
   * the last provider in "More providers", and the featured provider is the first row.
   */
  includeFree?: boolean;
  /**
   * The providers that this window cannot connect, such as Cultura Builder on a joined server whose
   * host has no Cultura Builder sign-in. They are in "More providers" until they are connected.
   */
  unreachable?: ReadonlySet<AgentProviderId>;
}

const NONE: ReadonlySet<AgentProviderId> = new Set();

/**
 * Whether the user can use the provider from this list now, or after one sign-in or one download.
 * A CLI that is too old, and a provider that this window cannot connect, wait in "More providers".
 */
function usable(option: ProviderPickerOption, unreachable: ReadonlySet<AgentProviderId>): boolean {
  return option.state !== "outdated" && !unreachable.has(option.id);
}

/**
 * Whether a provider that waits for a sign-in is one that the user has: its CLI is on the computer,
 * and only the sign-in is missing.
 *
 * That is not true for Pi and the key providers that run in it. The Pi CLI is shared, so when Pi is
 * up to date, Pi and each key provider wait for a sign-in although the user has no key. They become
 * rows when they are connected, or when the user chooses them in "More providers".
 */
function owned(option: ProviderPickerOption): boolean {
  return option.state === "sign-in-required" && option.id !== "pi" && !isKeyOnlyProvider(option.id);
}

/**
 * The provider rows of setup.
 *
 * What works comes first. With the free row, Builders is the first row, then the connected accounts,
 * then the featured provider, then the providers whose CLI is on the computer and only the sign-in
 * is missing (not Pi and the key providers, see `owned`). Popular providers fill the plan rows up to
 * `PLAN_ROWS`. Without the free row, the featured provider is the first row, because the user chose
 * to connect a plan.
 *
 * A provider whose CLI is too old, or that this window cannot connect, is not a row: it is in "More
 * providers", so no provider goes away. `kept` holds the rows that must stay in the list in their
 * order, so a row does not move or go away under the pointer when a download finishes or a sign-in
 * changes the state of a provider.
 */
export function onboardingProviderRows(
  options: readonly ProviderPickerOption[],
  rule: OnboardingRowRule = {},
): OnboardingProviderRows {
  const kept = rule.kept ?? [];
  const includeFree = rule.includeFree ?? true;
  const unreachable = rule.unreachable ?? NONE;
  const free = options.filter((option) => option.id === FREE_PROVIDER);
  const plans = options.filter((option) => option.id !== FREE_PROVIDER);
  const featured = plans.filter((option) => option.id === FEATURED_PROVIDER && usable(option, unreachable));
  const others = plans.filter((option) => option.id !== FEATURED_PROVIDER && usable(option, unreachable));
  const connected = others.filter((option) => option.state === "available");
  const signInOnly = others.filter(owned);
  const popular = POPULAR_PROVIDERS.flatMap((id) => {
    const option = others.find((candidate) => candidate.id === id);
    return option && option.state !== "available" && !owned(option) ? [option] : [];
  });
  const filled = popular.slice(0, Math.max(0, PLAN_ROWS - connected.length - signInOnly.length));
  const featuredConnected = featured.filter((option) => option.state === "available");
  const featuredOpen = featured.filter((option) => option.state !== "available");
  const ruled = includeFree
    ? [...featuredConnected, ...connected, ...featuredOpen, ...signInOnly, ...filled]
    : [...featured, ...connected, ...signInOnly, ...filled];
  const keptRows = kept.flatMap((id) => plans.filter((option) => option.id === id));
  const listedPlans = [...keptRows, ...ruled.filter((option) => !kept.includes(option.id))];
  const listedIds = new Set(listedPlans.map((option) => option.id));
  const hidden = plans.filter((option) => !listedIds.has(option.id));
  return {
    listed: includeFree ? [...free, ...listedPlans] : listedPlans,
    hidden: [
      ...hidden.filter((option) => usable(option, unreachable)),
      ...hidden.filter((option) => !usable(option, unreachable)),
      ...(includeFree ? [] : free),
    ],
  };
}

export interface AutomaticChoiceRule {
  /** The step has the free row, so Builders is the choice while no other provider is connected. */
  recommendFree?: boolean;
  /** The providers that this window cannot connect. The step never chooses one by itself. */
  unreachable?: ReadonlySet<AgentProviderId>;
}

/**
 * The provider that setup selects by itself, or null when there is no option.
 *
 * With the free row, a connected account comes first, the featured one before the others. While no
 * other provider is connected, Builders is the choice: it runs free models with no account. Without
 * the free row, the featured provider comes first, also before it is connected: the step then asks
 * the user to connect it, and the user can choose another row. Then a signed-in provider, then one
 * whose CLI is on the computer, then one that `ready` accepts.
 */
export function automaticProviderChoice(
  options: readonly ProviderPickerOption[],
  ready: (option: ProviderPickerOption) => boolean,
  rule: AutomaticChoiceRule = {},
): AgentProviderId | null {
  const unreachable = rule.unreachable ?? NONE;
  const choices = options.filter((option) => !unreachable.has(option.id));
  const featured = choices.find((option) => option.id === FEATURED_PROVIDER && option.state !== "outdated");
  const connected = choices.find((option) => option.state === "available" && option.id !== FREE_PROVIDER);
  const free = choices.find((option) => option.id === FREE_PROVIDER);
  const installed = choices.find((option) => owned(option) && !option.freeModels);
  const choice = rule.recommendFree
    ? ((featured?.state === "available" ? featured : undefined) ??
      connected ??
      free ??
      featured ??
      installed ??
      choices.find(ready))
    : (featured ?? choices.find((option) => option.state === "available") ?? installed ?? choices.find(ready));
  return choice?.id ?? null;
}
