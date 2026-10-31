import { Button, Dialog, IconButton, Orbit, X } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { prefersReducedMotion } from "@openbot/ui/utils";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { createTaskListPlayState } from "../conversation/TaskList";
import { OrbitFamilyGlyph } from "./OrbitFamilyGlyph";
import { OrbitSystemView } from "./OrbitSystem";
import { createOrbitEngine } from "./orbits-engine";
import {
  type OrbitAgent,
  type OrbitSystem,
  type OrbitsView,
  orbitBubbleIds,
  orbitCounts,
  orbitFamilyChips,
  orbitMotionIds,
  toggledOrbitFamily,
} from "./orbits-view";

export interface OrbitsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: OrbitsView;
  /** Opens the channel or the section of a system. The panel closes after it. */
  onOpenSystem: (system: OrbitSystem) => void;
  /** Opens the place of an agent's work: its channel, or its chat. The panel closes after it. */
  onOpenAgent: (agent: OrbitAgent) => void;
  /** The name of a channel, for the card of an agent that works there. */
  channelName: (channelId: string) => string | null;
  /** The time for the elapsed minutes of a card, in epoch milliseconds. The clock by default. */
  now?: number | undefined;
  /** Opens the card of this agent at once. Only a story uses it. */
  initialSelectedId?: string | undefined;
  /** Starts with this model filter. Only a story uses it. */
  initialFamily?: string | undefined;
}

/**
 * The Team panel ("Equipe"): an overlay over the right side of the window, not a column of the
 * layout, because the window has no room for one. Each channel with work is a small solar system:
 * its lead is the sun, and its members orbit it. The look of each agent says what it does, and a
 * mark beside it names its model family; the marks at the top filter by family. A system name opens
 * its channel, and an agent opens a small card.
 */
export function OrbitsPanel(props: OrbitsPanelProps) {
  const { t } = useText();
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="orbits-scrim" />
        <Dialog.Content
          class="orbits-panel"
          as="aside"
          tabindex="-1"
          // The panel takes the focus itself: on the close button, its tooltip would cover the header.
          onOpenAutoFocus={(event: Event) => {
            event.preventDefault();
            if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true });
          }}
        >
          <header class="orbits-head">
            <Dialog.Title class="orbits-title">{t("app.orbits.title")}</Dialog.Title>
            <IconButton label={t("common.close")} variant="ghost" onClick={() => props.onOpenChange(false)}>
              <X />
            </IconButton>
          </header>
          <Show when={props.view.systems.length > 0} fallback={<OrbitsEmpty />}>
            <OrbitsBody {...props} />
          </Show>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OrbitsEmpty() {
  const { t } = useText();
  return (
    <div class="orbits-empty">
      <Orbit aria-hidden="true" />
      <p>{t("app.orbits.empty")}</p>
    </div>
  );
}

/** The colours a system takes when its data gives none, in the order of the systems. */
const ORBIT_TONES = ["teal", "red", "blue", "pink", "yellow", "green", "orange"] as const;

function OrbitsBody(props: OrbitsPanelProps) {
  const { t } = useText();
  const engine = createOrbitEngine();
  const [family, setFamily] = createSignal<string | null>(props.initialFamily ?? null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [hotId, setHotId] = createSignal<string | null>(null);
  const [width, setWidth] = createSignal(0);
  const [reduced, setReduced] = createSignal(prefersReducedMotion());
  const playState = createTaskListPlayState();
  /** The loops run only while the window shows and motion is allowed. The panel is open: this body exists. */
  const running = () => !reduced() && playState() === "running";
  const agents = createMemo(() => Object.values(props.view.agents));
  const bubbleIds = createMemo(() => orbitBubbleIds(agents(), props.view.systems, family()));
  const motionIds = createMemo(() => orbitMotionIds(agents()));
  const counts = createMemo(() => orbitCounts(agents(), family()));
  const chips = createMemo(() => orbitFamilyChips(props.view.families, family()));
  let scroller: HTMLDivElement | undefined;

  // A filter on a family that left the panel would dim every agent and leave no mark to clear it.
  createEffect(
    () => {
      const current = family();
      return current !== null && !props.view.families.some((entry) => entry.family.id === current);
    },
    (stale) => {
      if (stale) setFamily(null);
    },
  );
  // The card of an agent that left the panel closes, so that it does not open again when the agent comes back.
  createEffect(
    () => {
      const current = selectedId();
      return current !== null && props.view.agents[current] === undefined;
    },
    (gone) => {
      if (gone) setSelectedId(null);
    },
  );
  let systemsEl: HTMLDivElement | undefined;
  const linkPaths: SVGPathElement[] = [];

  onSettled(() => {
    // The panel takes the focus as it opens, and a card that was open then would close at once. So the
    // first card opens after the panel has the focus.
    const initial = props.initialSelectedId;
    const panel = scroller?.closest<HTMLElement>(".orbits-panel");
    let opening = 0;
    const openInitial = () => {
      opening = requestAnimationFrame(() => setSelectedId(initial ?? null));
    };
    if (initial && panel) {
      if (document.activeElement === panel) openInitial();
      else panel.addEventListener("focus", openInitial, { once: true });
    }
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const syncReduced = () => setReduced(media?.matches ?? false);
    media?.addEventListener?.("change", syncReduced);
    const observer = new ResizeObserver(() => setWidth(systemsEl?.clientWidth ?? 0));
    if (systemsEl) {
      setWidth(systemsEl.clientWidth);
      observer.observe(systemsEl);
    }
    return () => {
      cancelAnimationFrame(opening);
      panel?.removeEventListener("focus", openInitial);
      media?.removeEventListener?.("change", syncReduced);
      observer.disconnect();
      engine.dispose();
    };
  });

  // The engine runs its frame loop only while a node moves and motion is allowed.
  createEffect(running, (on) => {
    engine.setRunning(on);
  });

  createEffect(
    () => props.view.links,
    (links) => {
      engine.setLinks(
        links.flatMap((link, index) => {
          const path = linkPaths[index];
          return path ? [{ path, from: link.from, to: link.to }] : [];
        }),
      );
    },
  );

  /** Shows an agent that the top line names: it scrolls to the agent and opens its card. */
  const reveal = (agentId: string | null) => {
    if (!agentId) return;
    const node = scroller?.querySelector<HTMLElement>(`[data-orbit-agent="${CSS.escape(agentId)}"]`);
    node?.scrollIntoView({ block: "center", behavior: running() ? "smooth" : "auto" });
    setSelectedId(agentId);
  };
  const firstName = (agentId: string | null) => (agentId ? (props.view.agents[agentId]?.name ?? "") : "");
  const familyName = (entry: OrbitsView["families"][number]) => entry.family.name ?? t("app.orbits.otherModel");

  return (
    <>
      <div class="orbits-bar">
        <fieldset class="orbits-chips" aria-label={t("app.orbits.filter")}>
          <For each={chips()} keyed={(entry) => entry.family.id}>
            {(entry) => (
              <Button
                variant="unstyled"
                class="orbits-chip"
                aria-pressed={family() === entry().family.id ? "true" : "false"}
                aria-label={t("app.orbits.familyChip", { name: familyName(entry()), count: entry().generating })}
                title={familyName(entry())}
                data-cuelume-toggle=""
                onClick={() => setFamily((current) => toggledOrbitFamily(current, entry().family.id))}
              >
                <OrbitFamilyGlyph family={entry().family} />
                <span class="orbits-chip-count">{entry().generating}</span>
              </Button>
            )}
          </For>
        </fieldset>
        <p class="orbits-count" aria-live="polite">
          <span>{t("app.orbits.working", { count: counts().generating })}</span>
          <Show when={counts().needsYou > 0}>
            <Button
              variant="unstyled"
              class="orbits-count-alert"
              data-tone="attention"
              aria-label={`${t("app.orbits.needsYou", { count: counts().needsYou })}. ${t("app.orbits.showAgent", { name: firstName(counts().firstNeedsYou) })}`}
              onClick={() => reveal(counts().firstNeedsYou)}
            >
              {t("app.orbits.needsYou", { count: counts().needsYou })}
            </Button>
          </Show>
          <Show when={counts().stalled > 0}>
            <Button
              variant="unstyled"
              class="orbits-count-alert"
              data-tone="danger"
              aria-label={`${t("app.orbits.stalled", { count: counts().stalled })}. ${t("app.orbits.showAgent", { name: firstName(counts().firstStalled) })}`}
              onClick={() => reveal(counts().firstStalled)}
            >
              {t("app.orbits.stalled", { count: counts().stalled })}
            </Button>
          </Show>
        </p>
      </div>
      <div class="orbits-scroll" ref={scroller} data-motion={running() ? "on" : "off"}>
        <div class="orbits-systems" ref={systemsEl}>
          <svg class="orbits-links" aria-hidden="true">
            <For each={props.view.links} keyed={false}>
              {(link, index) => (
                <path
                  ref={(element: SVGPathElement) => {
                    linkPaths[index] = element;
                  }}
                  data-hot={
                    hotId() === link().from ||
                    hotId() === link().to ||
                    selectedId() === link().from ||
                    selectedId() === link().to
                      ? ""
                      : undefined
                  }
                />
              )}
            </For>
          </svg>
          <For each={props.view.systems} keyed={(system) => system.key}>
            {(system, index) => (
              <OrbitSystemView
                system={system()}
                accent={system().color ?? `var(--openbot-file-${ORBIT_TONES[index() % ORBIT_TONES.length]})`}
                agents={props.view.agents}
                width={width()}
                bubbleIds={bubbleIds()}
                motionIds={motionIds()}
                family={family()}
                selectedId={selectedId()}
                running={running()}
                engine={engine}
                now={props.now}
                channelName={props.channelName}
                onSelect={setSelectedId}
                onHot={setHotId}
                onOpenSystem={props.onOpenSystem}
                onOpenAgent={props.onOpenAgent}
              />
            )}
          </For>
        </div>
      </div>
    </>
  );
}
