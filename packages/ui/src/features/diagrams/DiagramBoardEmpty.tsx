/**
 * The routine canvas before its first routine. A few agents stand in a row, stacked as avatars, and
 * a small wave passes through them. Below them are a large title in two lines, the action that
 * makes a routine, a link that asks an agent to make one, and a line of sample routines.
 *
 * The agents are decoration, so a reader hears only the title, the text and the actions. They are
 * the first agents of the user, in their own colours and roles. With no agents, fixed sample
 * colours stand in. The motion is in `diagrams.css`, and it stops when the reader asks for less.
 * There, each mark has no laser (`agent-mark-laser`) and its eyelids are higher
 * (`agent-mark-eyelid`), so the row moves only by transform and its agents look awake.
 */

import { AgentMark, type AgentMarkRole, avatarMarkAccent, avatarMarkRole } from "@openbot/brand/agent-mark";
import type { AvatarHue } from "@openbot/contracts/ipc";
import { ArrowRight, Button } from "@openbot/ui";
import { createUniqueId, For, Show } from "solid-js";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";

/** The most agents that the row shows. */
const CREW_SIZE = 4;

/** The row when there is no agent to show: fixed colours and roles, only as decoration. */
const SAMPLE_CREW = [
  { seed: "routine-crew-support", hue: 150, role: "support" },
  { seed: "routine-crew-design", hue: 245, role: "design" },
  { seed: "routine-crew-calendar", hue: 55, role: "calendar" },
  { seed: "routine-crew-code", hue: 215, role: "code" },
] as const satisfies readonly { seed: string; hue: AvatarHue; role: AgentMarkRole }[];

/** One cube of the row: the seed that offsets its motion, its colour, and the emblem of its role. */
interface CrewMember {
  seed: string;
  hue: AvatarHue | null;
  role: AgentMarkRole | null;
}

export interface DiagramBoardEmptyProps {
  /** The agents of the row, in order. The row shows the first four, each in its colour and role. */
  agents?: readonly Pick<AgentProfile, "avatarSeed" | "avatarHue" | "title">[] | undefined;
  /** Opens the settings of a new routine. Without it, the main action is not shown. */
  onCreateRoutine?: (() => void) | undefined;
  /** Asks an agent to make the routine, in the chat over the canvas. Without it, the link is not shown. */
  onAskAgent?: (() => void) | undefined;
}

export function DiagramBoardEmpty(props: DiagramBoardEmptyProps) {
  const { t } = useText();
  const titleId = createUniqueId();
  const crew = (): readonly CrewMember[] => {
    const agents = props.agents?.slice(0, CREW_SIZE) ?? [];
    if (agents.length === 0) return SAMPLE_CREW;
    return agents.map((agent) => ({ seed: agent.avatarSeed, hue: agent.avatarHue, role: avatarMarkRole(agent.title) }));
  };

  return (
    <div class="diagram-empty">
      <section class="diagram-empty-stage" aria-labelledby={titleId}>
        <div class="diagram-empty-crew" aria-hidden="true">
          {/* By place, not by agent: an update of the agent list keeps each cube and its motion. */}
          <For each={crew()} keyed={false}>
            {(member) => (
              <span class="diagram-empty-cube">
                <AgentMark seed={member().seed} accent={avatarMarkAccent(member().hue)} role={member().role} />
              </span>
            )}
          </For>
          <span class="diagram-empty-ready">{t("diagram.board.empty.ready")}</span>
        </div>

        <h2 id={titleId} class="diagram-empty-title">
          <span class="diagram-empty-lead">{t("diagram.board.empty.lead")}</span>{" "}
          <span>{t("diagram.board.empty.title")}</span>
        </h2>
        <p class="diagram-empty-body">{t("diagram.board.empty.body")}</p>

        <Show when={props.onCreateRoutine || props.onAskAgent}>
          <div class="diagram-empty-actions">
            <Show when={props.onCreateRoutine}>
              {(create) => (
                <Button type="button" size="lg" class="diagram-empty-create" onClick={() => create()()}>
                  {t("routine.settings.create")}
                </Button>
              )}
            </Show>
            <Show when={props.onAskAgent}>
              {(ask) => (
                <Button type="button" variant="ghost" class="diagram-empty-ask" onClick={() => ask()()}>
                  {t("diagram.board.empty.ask")}
                  <ArrowRight class="diagram-empty-arrow" aria-hidden="true" />
                </Button>
              )}
            </Show>
          </div>
        </Show>

        <p class="diagram-empty-examples">
          <span class="diagram-empty-examples-label">{t("diagram.board.empty.examplesLabel")}</span>{" "}
          {t("diagram.board.empty.examples")}
        </p>
      </section>
    </div>
  );
}
