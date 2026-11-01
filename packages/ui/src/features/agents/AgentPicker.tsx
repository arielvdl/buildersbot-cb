/**
 * The "choose an agent" menu of every surface: a trigger that opens a search field, provider and
 * model chips, and the agents as one list that scrolls inside the window.
 *
 * A team can have more agents than the window has rows. A menu that grows with its rows goes past
 * the window and cannot scroll, so the last agents cannot be chosen. This menu stops at the room on
 * its side of the trigger, and only the list scrolls. The search field has the focus when the menu
 * opens: Enter chooses the first match, ArrowDown and ArrowUp go to the first and the last row, and
 * Escape closes the menu. In the list the keyboard moves as in every list, and the focused row
 * scrolls into view.
 */
import { ProviderLogo, type ProviderLogoVariant } from "@openbot/brand";
import { isKnownAgentProvider } from "@openbot/contracts/agent-providers";
import { Button, Check, Input, Listbox, Popover, Search } from "@openbot/ui";
import { ContentExitMotion } from "@openbot/ui/menu-motion";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createStore, For, Show, untrack } from "solid-js";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "./AgentAvatar";
import {
  type AgentPickerEntry,
  type AgentPickerFilter,
  agentPickerModels,
  agentPickerProviders,
  EMPTY_AGENT_PICKER_FILTER,
  filterAgentPicker,
} from "./agent-picker-filter";

/** An agent of the picker, with its face when the surface has it. */
export interface AgentPickerAgent
  extends AgentPickerEntry,
    Partial<Pick<AgentProfile, "avatarSeed" | "avatarHue" | "avatarUrl">> {}

export interface AgentPickerProps<Agent extends AgentPickerAgent> {
  agents: readonly Agent[];
  /** Runs after the menu closed and the focus went back to the trigger. */
  onChoose: (agent: Agent) => void;
  /** The agent that the surface has now. Its row has a check mark. */
  selectedId?: string | undefined;
  /** The name of the list, for assistive technology. */
  label: string;
  /** The content of the trigger. */
  children: JSX.Element;
  triggerClass?: string | undefined;
  /** The accessible name of the trigger, when its content does not say what it does. */
  triggerLabel?: string | undefined;
  /** Where the menu lines up with its trigger. The side is the side with more room. */
  align?: "start" | "center" | "end" | undefined;
  gutter?: number | undefined;
  /** Where the menu shows. Without it, the menu shows in the document body. */
  mount?: HTMLElement | undefined;
}

export function AgentPicker<Agent extends AgentPickerAgent>(props: AgentPickerProps<Agent>): JSX.Element {
  const { t } = useText();
  const [open, setOpen] = createSignal(false);
  const [side, setSide] = createSignal<"bottom" | "top">("bottom");
  const [filter, setFilter] = createStore<AgentPickerFilter>({ ...EMPTY_AGENT_PICKER_FILTER });
  let trigger: HTMLButtonElement | undefined;
  let search: HTMLInputElement | undefined;
  let panel: HTMLElement | undefined;
  let list: HTMLElement | undefined;

  const providers = createMemo(() => agentPickerProviders(props.agents));
  const models = createMemo(() => agentPickerModels(props.agents, filter.provider));
  const shown = createMemo(() =>
    filterAgentPicker(props.agents, { search: filter.search, provider: filter.provider, model: filter.model }),
  );
  const placement = () => {
    const align = props.align ?? "start";
    return align === "center" ? side() : (`${side()}-${align}` as const);
  };

  function changeOpen(next: boolean): void {
    if (next && trigger) {
      // The side is chosen once, where the window has more room. The menu stops at the room it has,
      // so it never overflows and is never flipped: a search that shrinks the list keeps it in place.
      const box = trigger.getBoundingClientRect();
      setSide(window.innerHeight - box.bottom >= box.top ? "bottom" : "top");
    }
    if (!next) setFilter(() => ({ ...EMPTY_AGENT_PICKER_FILTER }));
    setOpen(next);
    // A popover that is not modal does not move the focus, so the search field takes it once it shows.
    if (next) requestAnimationFrame(() => search?.focus({ preventScroll: true }));
  }

  function choose(agent: Agent): void {
    changeOpen(false);
    // Kobalte gives the focus back only when it closes the popover itself. The focus waits a frame:
    // the Enter that chose would otherwise press the trigger too and open the menu again. The surface
    // acts after that, so a focus that it moves stays where it put it.
    requestAnimationFrame(() => {
      trigger?.focus({ preventScroll: true });
      props.onChoose(agent);
    });
  }

  /**
   * ArrowDown and ArrowUp go to the first and the last row themselves. Focusing the list would let
   * Kobalte go back to the row it last focused, which a search may have taken off the list.
   */
  function focusRow(which: "first" | "last"): boolean {
    const rows = list?.querySelectorAll<HTMLElement>(".agent-picker-option");
    const row = which === "first" ? rows?.[0] : rows?.[rows.length - 1];
    row?.focus();
    return row !== undefined;
  }

  /**
   * Typing while a row has the focus goes on in the search field. Kobalte's own typeahead cannot
   * take a name with a space: the focused row takes Space as its select key before the typeahead
   * sees it.
   */
  function typeIntoSearch(event: KeyboardEvent): void {
    const erase = event.key === "Backspace";
    if ((event.key.length !== 1 && !erase) || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    setFilter((state) => {
      state.search = erase ? state.search.slice(0, -1) : state.search + event.key;
    });
    search?.focus();
  }

  return (
    <Popover.Root
      open={open()}
      onOpenChange={changeOpen}
      placement={placement()}
      gutter={props.gutter ?? 4}
      flip={false}
      modal={false}
    >
      <Popover.Trigger
        ref={(element: HTMLButtonElement) => {
          trigger = element;
        }}
        class={props.triggerClass}
        aria-label={props.triggerLabel}
      >
        {props.children}
      </Popover.Trigger>
      {/* A portal without a mount uses the document body. */}
      <Popover.Portal mount={props.mount ?? document.body}>
        <Popover.Content
          ref={(element: HTMLElement) => {
            panel = element;
          }}
          class="ui-action-menu agent-picker"
        >
          <ContentExitMotion panel={() => panel} />
          <Popover.Title class="sr-only">{props.label}</Popover.Title>
          <span class="agent-picker-search">
            <Search aria-hidden="true" />
            <Input
              ref={(element: HTMLInputElement) => {
                search = element;
              }}
              type="search"
              size="sm"
              autocomplete="off"
              spellcheck={false}
              aria-label={t("agent.picker.search")}
              placeholder={t("agent.picker.search")}
              value={filter.search}
              onValueChange={(value) =>
                setFilter((state) => {
                  state.search = value;
                })
              }
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  if (focusRow(event.key === "ArrowDown" ? "first" : "last")) event.preventDefault();
                } else if (event.key === "Enter") {
                  // Enter chooses the first match; in a form it never sends the form.
                  event.preventDefault();
                  const first = untrack(shown)[0];
                  if (first) choose(first);
                }
              }}
            />
          </span>
          <Show when={providers().length}>
            <fieldset class="agent-picker-chips" aria-label={t("agent.picker.providers")}>
              <Button
                type="button"
                size="xs"
                variant={filter.provider === null ? "secondary" : "ghost"}
                class="agent-picker-chip"
                aria-pressed={filter.provider === null ? "true" : "false"}
                onClick={() =>
                  setFilter((state) => {
                    state.provider = null;
                    state.model = null;
                  })
                }
              >
                {t("agent.picker.allProviders")}
              </Button>
              <For each={providers()} keyed={(choice) => choice.value}>
                {(choice) => (
                  <Button
                    type="button"
                    size="xs"
                    variant={filter.provider === choice().value ? "secondary" : "ghost"}
                    class="agent-picker-chip"
                    aria-pressed={filter.provider === choice().value ? "true" : "false"}
                    onClick={() =>
                      setFilter((state) => {
                        state.provider = state.provider === choice().value ? null : choice().value;
                        state.model = null;
                      })
                    }
                  >
                    <ProviderLogo provider={logoOf(choice().value)} class="agent-picker-chip-mark" />
                    <span>{choice().label}</span>
                    <span class="agent-picker-chip-count">{choice().count}</span>
                  </Button>
                )}
              </For>
            </fieldset>
          </Show>
          <Show when={models().length}>
            <fieldset class="agent-picker-chips" aria-label={t("agent.picker.models")}>
              <For each={models()} keyed={(choice) => choice.value}>
                {(choice) => (
                  <Button
                    type="button"
                    size="xs"
                    variant={filter.model === choice().value ? "secondary" : "ghost"}
                    class="agent-picker-chip"
                    aria-pressed={filter.model === choice().value ? "true" : "false"}
                    onClick={() =>
                      setFilter((state) => {
                        state.model = state.model === choice().value ? null : choice().value;
                      })
                    }
                  >
                    <span>{choice().label}</span>
                    <span class="agent-picker-chip-count">{choice().count}</span>
                  </Button>
                )}
              </For>
            </fieldset>
          </Show>
          <Show
            when={shown().length}
            fallback={
              <p class="agent-picker-empty" role="status">
                {t("agent.picker.empty")}
              </p>
            }
          >
            <Listbox.Root
              ref={(element: HTMLElement) => {
                list = element;
                element.addEventListener("keydown", typeIntoSearch, { capture: true });
              }}
              class="agent-picker-list"
              aria-label={props.label}
              options={shown()}
              optionValue="id"
              optionTextValue="name"
              selectionMode="single"
              shouldFocusWrap
              // A choice on pointerdown would close the menu under the pointer, and the click would
              // land on whatever was below it.
              shouldSelectOnPressUp
              onChange={(keys) => {
                const agentId = keys.values().next().value;
                const agent = untrack(shown).find((candidate) => candidate.id === agentId);
                if (agent) choose(agent);
              }}
              renderItem={(item) => (
                <Listbox.Item item={item} class="agent-picker-option">
                  <Show when={item.rawValue.avatarSeed}>
                    {(seed) => (
                      <AgentAvatar
                        seed={seed()}
                        hue={item.rawValue.avatarHue ?? null}
                        url={item.rawValue.avatarUrl ?? null}
                        title={item.rawValue.title}
                        class="agent-picker-avatar"
                      />
                    )}
                  </Show>
                  <span class="agent-picker-name">{item.rawValue.name}</span>
                  <Show when={item.rawValue.provider}>
                    {(provider) => (
                      <span class="agent-picker-model">
                        <ProviderLogo provider={logoOf(provider())} class="agent-picker-model-mark" />
                        <Show when={item.rawValue.model}>
                          <span class="agent-picker-model-name">{item.rawValue.model}</span>
                        </Show>
                      </span>
                    )}
                  </Show>
                  <Show when={props.selectedId === item.rawValue.id}>
                    <Check aria-hidden="true" class="agent-picker-check" />
                  </Show>
                </Listbox.Item>
              )}
            />
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A provider that this build does not know shows the generic mark. */
function logoOf(provider: NonNullable<AgentPickerEntry["provider"]>): ProviderLogoVariant {
  return isKnownAgentProvider(provider) ? provider : "unknown";
}
