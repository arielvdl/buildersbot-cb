import type { AvatarMood } from "@openbot/brand/bloub-avatar-motion";
import { ArrowRight, Button, Check, Popover } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import { AgentAvatar } from "../agents/AgentAvatar";
import { OrbitFamilyGlyph } from "./OrbitFamilyGlyph";
import type { OrbitEngine } from "./orbits-engine";
import { type OrbitGeometry, type OrbitSlot, orbitGeometry, orbitPoint } from "./orbits-geometry";
import { type OrbitAgent, type OrbitState, type OrbitSystem, orbitMatches, orbitWaitsForPerson } from "./orbits-view";

interface OrbitSystemViewProps {
  system: OrbitSystem;
  /** The colour of the system, as CSS. */
  accent: string;
  agents: Readonly<Record<string, OrbitAgent>>;
  width: number;
  bubbleIds: readonly string[];
  motionIds: ReadonlySet<string>;
  family: string | null;
  selectedId: string | null;
  running: boolean;
  engine: OrbitEngine;
  now: number | undefined;
  channelName: (channelId: string) => string | null;
  onSelect: (agentId: string | null) => void;
  onHot: (agentId: string | null) => void;
  onOpenSystem: (system: OrbitSystem) => void;
  onOpenAgent: (agent: OrbitAgent) => void;
}

/** The face of the mark for each state. The panel draws the motion, so the mark holds still. */
const MOODS: Readonly<Record<OrbitState, AvatarMood>> = {
  working: "working",
  speaking: "working",
  thinking: "working",
  waiting: "waiting",
  stalled: "failed",
  done: "responded",
  idle: "idle",
};

/** The space between the system box and the name, as `.orbit-name` draws it. */
const NAME_GAP = 10;

/** One channel or section as a small solar system. */
export function OrbitSystemView(props: OrbitSystemViewProps) {
  const { t } = useText();
  let box: HTMLElement | undefined;
  let nameEl: HTMLElement | undefined;
  let bubbleEl: HTMLElement | undefined;
  const [geometry, setGeometry] = createSignal<OrbitGeometry | null>(null);

  const members = createMemo(() =>
    props.system.agentIds.flatMap((agentId) => {
      const agent = props.agents[agentId];
      return agent ? [agent] : [];
    }),
  );
  /** Who sits where: the sun, the working agents inside, the other active ones outside, the rest at the edge. */
  const groups = createMemo(() => {
    const sunId = props.system.sunId;
    const others = members().filter((agent) => agent.id !== sunId);
    return {
      sunId,
      movers: others.filter((agent) => agent.state === "working").map((agent) => agent.id),
      still: others
        .filter((agent) => agent.state !== "working" && agent.state !== "done" && agent.state !== "idle")
        .map((agent) => ({ id: agent.id, drift: agent.state === "waiting" && !orbitWaitsForPerson(agent.wait) })),
      parked: others.filter((agent) => agent.state === "done" || agent.state === "idle").map((agent) => agent.id),
    };
  });
  /** The one agent of this system with a bubble, if any. */
  const talkerId = createMemo(() => props.bubbleIds.find((agentId) => props.system.agentIds.includes(agentId)) ?? null);
  const kindOf = (agent: OrbitAgent) =>
    agent.id === props.system.sunId ? "sun" : agent.state === "done" || agent.state === "idle" ? "tiny" : "planet";

  let dropSystem: (() => void) | undefined;
  const mountBox = (element: HTMLElement) => {
    box = element;
    dropSystem?.();
    dropSystem = untrack(() => props.engine.system(props.system.key, element));
  };

  /**
   * The bubble grows while its agent writes. Its text does not start a layout: only a new height does,
   * which the observer reports. A new width only moves the bubble.
   */
  const [bubbleResized, setBubbleResized] = createSignal(0);
  let bubbleHeight = 0;
  let nameRight = 0;
  let lastShape: OrbitGeometry | null = null;
  const bubbleObserver = new ResizeObserver((entries) => {
    const size = entries.find((entry) => entry.target === bubbleEl)?.borderBoxSize[0];
    if (!size || !lastShape) return;
    if (Math.round(size.blockSize) !== bubbleHeight) setBubbleResized((count) => count + 1);
    else placeBubble(lastShape, size.inlineSize, size.blockSize);
  });
  const mountBubble = (element: HTMLElement) => {
    if (bubbleEl) bubbleObserver.unobserve(bubbleEl);
    bubbleEl = element;
    bubbleObserver.observe(element);
  };
  onSettled(() => () => {
    dropSystem?.();
    bubbleObserver.disconnect();
  });

  /**
   * What the layout depends on. Each update of the view makes new objects, so the memo compares a key
   * and the layout runs only when a place, the bubble's agent or height, or the width changes.
   */
  const layoutInput = createMemo(
    () => {
      const input = {
        key: props.system.key,
        width: props.width,
        groups: groups(),
        talker: talkerId(),
        resized: bubbleResized(),
        moving: props.system.agentIds.filter((agentId) => props.motionIds.has(agentId)),
      };
      return { ...input, engine: props.engine, signature: JSON.stringify(input) };
    },
    { equals: (left, right) => left.signature === right.signature },
  );

  /** Measures the name and the bubble, then gives every agent its place. */
  createEffect(layoutInput, (input) => {
    if (!box || input.width <= 0) return;
    const width = box.clientWidth;
    nameRight = nameEl ? nameEl.offsetLeft + nameEl.offsetWidth + NAME_GAP : 0;
    if (!input.talker && bubbleEl) {
      bubbleObserver.unobserve(bubbleEl);
      bubbleEl = undefined;
    }
    const bubble = bubbleEl;
    if (bubble) bubble.style.maxWidth = `${Math.max(120, Math.min(236, width - nameRight))}px`;
    bubbleHeight = bubble ? bubble.offsetHeight : 0;
    const talker = input.talker ? { id: input.talker, height: bubble ? bubbleHeight : 46 } : null;
    const next = orbitGeometry({ width, nameRight, ...input.groups, talker });
    const moving = new Set(input.moving);
    const slots: Record<string, { slot: OrbitSlot; moving: boolean }> = {};
    for (const [agentId, slot] of Object.entries(next.slots)) {
      slots[agentId] = { slot, moving: moving.has(agentId) && slot.kind !== "park" && slot.kind !== "sun" };
    }
    lastShape = next;
    setGeometry(next);
    input.engine.layout(input.key, next, slots);
    if (bubble) placeBubble(next, bubble.offsetWidth, bubbleHeight);
  });

  function placeBubble(next: OrbitGeometry, width: number, height: number) {
    const talker = untrack(talkerId);
    const slot = talker ? next.slots[talker] : undefined;
    if (!bubbleEl || !slot) return;
    const point = orbitPoint(next, slot, 0);
    const left = Math.max(nameRight, Math.min(next.width - width, point.x - 6));
    const top = Math.max(4, next.cy - next.bubbleClear - height);
    bubbleEl.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
    bubbleEl.dataset.tail = point.x > left + width * 0.6 ? "end" : "start";
  }

  return (
    <section
      ref={mountBox}
      class="orbit-system"
      style={{ "--orbit-color": props.accent, height: `${geometry()?.height ?? 160}px` }}
      aria-label={props.system.name}
    >
      <Show when={geometry()}>
        {(shape) => (
          <>
            <div
              class="orbit-halo"
              aria-hidden="true"
              style={{
                left: `${shape().cx - shape().outer.rx - 30}px`,
                top: `${shape().cy - shape().outer.ry - 22}px`,
                width: `${(shape().outer.rx + 30) * 2}px`,
                height: `${(shape().outer.ry + 22) * 2}px`,
              }}
            />
            <svg class="orbit-rings" width={shape().width} height={shape().height} aria-hidden="true">
              <Show when={shape().two}>
                <ellipse cx={shape().cx} cy={shape().cy} rx={shape().outer.rx} ry={shape().outer.ry} />
              </Show>
              <ellipse
                data-fast={shape().fast ? "" : undefined}
                cx={shape().cx}
                cy={shape().cy}
                rx={shape().inner.rx}
                ry={shape().inner.ry}
              />
            </svg>
          </>
        )}
      </Show>
      <Button
        ref={nameEl}
        variant="unstyled"
        class="orbit-name"
        data-cuelume-navigate=""
        aria-label={t(props.system.kind === "channel" ? "app.orbits.openChannel" : "app.orbits.openSection", {
          name: props.system.name,
        })}
        onClick={() => props.onOpenSystem(props.system)}
      >
        <span class="orbit-name-dot" aria-hidden="true" />
        <span class="orbit-name-text">{props.system.name}</span>
        <ArrowRight aria-hidden="true" />
      </Button>
      <For each={members()} keyed={(agent) => agent.id}>
        {(agent) => (
          <OrbitAgentNode
            agent={agent()}
            kind={kindOf(agent())}
            systemKey={props.system.key}
            accent={props.accent}
            moving={props.motionIds.has(agent().id) && props.running}
            filtered={!orbitMatches(agent(), props.family)}
            selected={props.selectedId === agent().id}
            engine={props.engine}
            now={props.now}
            channelName={props.channelName}
            onSelect={props.onSelect}
            onHot={props.onHot}
            onOpen={props.onOpenAgent}
          />
        )}
      </For>
      <Show when={talkerId()} keyed>
        {(agentId) => (
          <div
            ref={mountBubble}
            class="orbit-bubble"
            data-hidden={props.selectedId !== null ? "" : undefined}
            aria-hidden="true"
          >
            <span>{props.agents[agentId]?.says}</span>
          </div>
        )}
      </Show>
    </section>
  );
}

interface OrbitAgentNodeProps {
  agent: OrbitAgent;
  kind: "sun" | "planet" | "tiny";
  systemKey: string;
  accent: string;
  /** The node runs its loops: it is in the motion budget, and motion is on. */
  moving: boolean;
  filtered: boolean;
  selected: boolean;
  engine: OrbitEngine;
  now: number | undefined;
  channelName: (channelId: string) => string | null;
  onSelect: (agentId: string | null) => void;
  onHot: (agentId: string | null) => void;
  onOpen: (agent: OrbitAgent) => void;
}

const STATE_LABEL = {
  working: "app.orbits.state.working",
  speaking: "app.orbits.state.speaking",
  thinking: "app.orbits.state.thinking",
  waiting: "app.orbits.state.waiting",
  stalled: "app.orbits.state.stalled",
  done: "app.orbits.state.done",
  idle: "app.orbits.state.idle",
} as const;

/** One agent: its mark, its model mark, and the loops of its state. A click opens its card. */
function OrbitAgentNode(props: OrbitAgentNodeProps) {
  const { t } = useText();
  let nearTrail: HTMLElement | undefined;
  let farTrail: HTMLElement | undefined;
  const needsYou = () => props.agent.state === "waiting" && orbitWaitsForPerson(props.agent.wait);
  const familyName = () => props.agent.family.name ?? t("app.orbits.otherModel");
  const stateText = () => (needsYou() ? t("app.orbits.state.waitingYou") : t(STATE_LABEL[props.agent.state]));
  const trailsOn = () => props.moving && props.agent.state === "working" && props.kind !== "sun";

  let dropNode: (() => void) | undefined;
  const mountNode = (element: HTMLElement) => {
    dropNode?.();
    dropNode = untrack(() => props.engine.node(props.agent.id, props.systemKey, element));
  };
  onSettled(() => () => dropNode?.());
  createEffect(
    () => ({ on: trailsOn(), id: props.agent.id, engine: props.engine }),
    (input) => {
      input.engine.trails(input.id, input.on ? [nearTrail, farTrail].flatMap((trail) => (trail ? [trail] : [])) : []);
    },
  );
  createEffect(
    () => ({ held: props.selected, id: props.agent.id, engine: props.engine }),
    (input) => {
      input.engine.hold(input.id, input.held);
    },
  );

  return (
    <>
      <Show when={trailsOn()}>
        <span ref={nearTrail} class="orbit-trail" aria-hidden="true" />
        <span ref={farTrail} class="orbit-trail" data-far="" aria-hidden="true" />
      </Show>
      <Popover.Root
        open={props.selected}
        onOpenChange={(open) => props.onSelect(open ? props.agent.id : null)}
        placement="bottom"
        gutter={8}
      >
        <Popover.Trigger
          as={Button}
          ref={mountNode}
          variant="unstyled"
          class="orbit-agent"
          data-orbit-agent={props.agent.id}
          data-kind={props.kind}
          data-state={props.agent.state}
          data-attention={needsYou() ? "" : undefined}
          data-moving={props.moving ? "" : undefined}
          data-filtered={props.filtered ? "" : undefined}
          aria-label={t("app.orbits.agentLabel", { name: props.agent.name, model: familyName(), state: stateText() })}
          onPointerEnter={() => props.onHot(props.agent.id)}
          onPointerLeave={() => props.onHot(null)}
          onFocus={() => props.onHot(props.agent.id)}
          onBlur={() => props.onHot(null)}
        >
          <Show
            when={props.kind !== "tiny"}
            fallback={
              <>
                <OrbitFamilyGlyph family={props.agent.family} class="orbit-dot-glyph" />
                <Show when={props.agent.state === "done"}>
                  <Check class="orbit-done-mark" aria-hidden="true" />
                </Show>
              </>
            }
          >
            <Show when={props.agent.state === "working"}>
              <svg class="orbit-progress" viewBox="0 0 44 44" aria-hidden="true">
                <circle class="orbit-progress-track" cx="22" cy="22" r="19" />
                <Show when={props.moving}>
                  <g class="orbit-progress-race">
                    <circle cx="22" cy="22" r="19" />
                  </g>
                </Show>
              </svg>
              <Show when={props.moving}>
                <span class="orbit-sparks" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </Show>
            </Show>
            <Show when={props.agent.state === "speaking" || needsYou()}>
              <span class="orbit-pulse" aria-hidden="true" />
            </Show>
            <Show when={props.agent.state === "stalled"}>
              <span class="orbit-alarm" aria-hidden="true" />
            </Show>
            <AgentAvatar
              agent={props.agent}
              mood={MOODS[props.agent.state]}
              motion="still"
              animated={false}
              class="orbit-avatar"
            />
            <OrbitFamilyGlyph family={props.agent.family} class="orbit-model" />
          </Show>
        </Popover.Trigger>
        {/* No portal: the card stays in the panel, which is a modal dialog. A portal outside it would be
            hidden from assistive technology with the rest of the window. */}
        <Popover.Content class="ui-popover-menu-surface orbit-card" style={{ "--orbit-color": props.accent }}>
          <OrbitCard {...props} familyName={familyName()} />
        </Popover.Content>
      </Popover.Root>
    </>
  );
}

/** The card of an agent: its name, one line of work, its time or its wait, and where to go. */
function OrbitCard(props: OrbitAgentNodeProps & { familyName: string }) {
  const { t, format } = useText();
  const agent = () => props.agent;
  const channel = () => (agent().place ? props.channelName(agent().place?.channelId ?? "") : null);
  const minutes = () => {
    const started = agent().startedAt;
    if (started === null || !orbitStateRuns(agent().state)) return null;
    return Math.max(1, Math.round(((props.now ?? Date.now()) - started) / 60_000));
  };
  const status = (): { text: string; tone?: "danger" | "attention" } | null => {
    const current = agent();
    switch (current.state) {
      case "waiting":
        switch (current.wait) {
          case "question":
            return { text: t("app.orbits.card.question"), tone: "attention" };
          case "approval":
            return { text: t("app.orbits.card.approval"), tone: "attention" };
          case "takeover":
            return { text: t("app.orbits.card.takeover"), tone: "attention" };
          case "limit":
            return current.resetsAt === null
              ? { text: t("app.orbits.card.limit") }
              : {
                  text: t("app.orbits.card.limitAt", {
                    time: format.date(current.resetsAt * 1000, { hour: "2-digit", minute: "2-digit" }),
                  }),
                };
          default:
            return { text: t("app.orbits.card.turn") };
        }
      case "stalled":
        return current.stopReason
          ? { text: t("app.orbits.card.stopped", { reason: current.stopReason }), tone: "danger" }
          : { text: t("app.orbits.card.failed"), tone: "danger" };
      case "done":
        return { text: t("app.orbits.card.done") };
      case "idle":
        return { text: t("app.orbits.card.idle") };
      default: {
        const count = minutes();
        return count === null ? null : { text: t("app.orbits.card.running", { count }) };
      }
    }
  };
  return (
    <>
      <div class="orbit-card-head">
        <span class="orbit-card-dot" aria-hidden="true" />
        <Popover.Title class="orbit-card-name">{agent().name}</Popover.Title>
        <span class="orbit-card-model">
          <OrbitFamilyGlyph family={agent().family} />
          {props.familyName}
        </span>
      </div>
      <Show when={agent().task}>{(task) => <p class="orbit-card-task">{task()}</p>}</Show>
      <Show when={agent().state === "speaking" ? agent().says : null}>
        {(says) => <p class="orbit-card-quote">{says()}</p>}
      </Show>
      <Show when={status()}>
        {(line) => (
          <p class="orbit-card-status" data-tone={line().tone}>
            {line().text}
          </p>
        )}
      </Show>
      <Show when={channel()}>
        {(name) => <p class="orbit-card-place">{t("app.orbits.card.in", { channel: name() })}</p>}
      </Show>
      <Button
        variant="secondary"
        size="sm"
        fullWidth
        class="orbit-card-go"
        data-cuelume-navigate=""
        onClick={() => props.onOpen(agent())}
      >
        {agent().place ? t("app.orbits.card.goChannel") : t("app.orbits.card.goChat")}
        <ArrowRight aria-hidden="true" />
      </Button>
    </>
  );
}

function orbitStateRuns(state: OrbitState): boolean {
  return state === "working" || state === "speaking" || state === "thinking";
}
