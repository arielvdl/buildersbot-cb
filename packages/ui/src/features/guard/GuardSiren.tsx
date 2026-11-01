import { AgentMark } from "@openbot/brand/agent-mark";
import { GUARD_LEVELS, type GuardAvailableLevel, type GuardLevel, isGuardAvailableLevel } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { RadioGroup } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createUniqueId, For, Show } from "solid-js";
import { useText } from "../../text";
import { cx } from "../../utils";
import { createTaskListPlayState } from "../conversation/TaskList";

/**
 * How the siren on the Guard's box shows. `asleep`: the Guard is off, its eyes are shut and the siren
 * is down in the box. `calm`: the eyes are half open and the siren stays down in the box, as Light
 * shows in the approved P1 mockup. `watch`: the siren is up and amber, turns slowly and two beams
 * sweep. `alarm`: it is red, turns fast and its halo throbs; while the Guard asks, the shield shows
 * "!". `neutral`: up and dark, for a level that the person builds.
 */
export type GuardSirenMode = "asleep" | "calm" | "watch" | "alarm" | "neutral";

/** The siren of each level when the Guard asks nothing, as in the approved P1 mockup. */
const LEVEL_MODE = {
  off: "asleep",
  light: "calm",
  strict: "watch",
  "very-strict": "alarm",
  custom: "neutral",
} as const satisfies Record<GuardLevel, GuardSirenMode>;

/** How far the eyelids come down: 0 is wide open, 1 covers the eye. */
const EYELID = { asleep: 0.95, calm: 0.5, watch: 0.12, alarm: 0, neutral: 0.18 } as const satisfies Record<
  GuardSirenMode,
  number
>;

/**
 * The siren of a level, and the alarm while a question of the Guard waits for the person. Off never
 * asks. A null level, while the page reads the Guard, shows the siren down and the eyes shut.
 */
export function guardSirenMode(level: GuardLevel | null, asking: boolean): GuardSirenMode {
  if (level === null || level === "off") return "asleep";
  return asking ? "alarm" : LEVEL_MODE[level];
}

/** The shield of the Guard, in the 68 x 78 box of the role symbols. */
const SHIELD = "M34 11 L56 19 V38 C56 53 47 62 34 68 C21 62 12 53 12 38 V19 Z";
/** The shield is larger than a role symbol: this grows it round the middle of the box. */
const SHIELD_SCALE = "translate(34 39) scale(1.16) translate(-34 -39)";
/** The dome of the siren, drawn round the middle of the lid, with y up as negative. */
const DOME = "M-17 -12V-26A17 19 0 0 1 17 -26V-12Z";
/** The middle of the lid of the box, in the 240 x 240 units of `AgentMark`. */
const LID_CENTER = "translate(120 81)";

export interface GuardSirenProps {
  /** Null while the level is not known: the box is grey and asleep. */
  level: GuardLevel | null;
  /** True while a question of the Guard waits for the person: the siren sounds the alarm, red. */
  asking?: boolean | undefined;
  /** `hero` is the large picture at the top of the Guard page; `compact` fits the header of a card. */
  size?: "hero" | "compact" | undefined;
  /** False stops the motion, such as when the question is answered. The document being hidden also stops it. */
  playing?: boolean | undefined;
  class?: string | undefined;
}

/** The color of the box of a level, and grey while the level is not known. */
function boxColor(level: GuardLevel | null): string {
  return `var(--openbot-guard-${level ?? "off"})`;
}

/**
 * The Guard's siren (P1, "giroflex"): the Guard's box with a shield, a dome on its lid with a
 * reflector that turns inside, and two beams of light that sweep round the dome.
 *
 * It is a picture: screen readers skip it, and the page that shows it says the state in text. Only
 * `transform` and `opacity` move, three parts at most (the beams, the reflector and the halo). The
 * parts that turn are HTML, not SVG: a transform of an SVG part makes the browser lay out the page
 * again on each frame that the main thread draws, such as while the text of a conversation arrives.
 * With reduced motion nothing moves and the dome keeps its light. `scripts/guard-siren-e2e.ts` checks
 * these rules in a headless browser.
 */
export function GuardSiren(props: GuardSirenProps) {
  const clipId = createUniqueId();
  const documentPlay = createTaskListPlayState();
  const mode = () => guardSirenMode(props.level, props.asking === true);
  const playState = () => (props.playing === false ? "paused" : documentPlay());
  return (
    <div
      class={cx("guard-siren", props.class)}
      data-size={props.size ?? "hero"}
      data-mode={mode()}
      style={{ "--guard-siren-play": playState() }}
      aria-hidden="true"
    >
      <span class="guard-siren-floor" />
      <span class="guard-siren-beams">
        <span class="guard-siren-beam" />
        <span class="guard-siren-beam" />
      </span>
      <AgentMark
        class="guard-siren-box"
        mood={mode() === "asleep" ? "asleep" : "idle"}
        accent={boxColor(props.level)}
        animated={false}
        emblem={() => <GuardShield alert={mode() === "alarm" && props.asking === true} />}
        style={{ "--agent-mark-eyelid": String(EYELID[mode()]) }}
      />
      <svg class="guard-siren-lamp" viewBox="0 0 240 240" aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <path d={DOME} />
          </clipPath>
        </defs>
        <g transform={LID_CENTER}>
          <g class="guard-siren-rise">
            <g class="guard-siren-halo">
              <ellipse cx="0" cy="-27" rx="46" ry="40" opacity="0.22" />
              <ellipse cx="0" cy="-27" rx="33" ry="29" opacity="0.32" />
              <ellipse cx="0" cy="-27" rx="22" ry="20" opacity="0.42" />
            </g>
            <ellipse class="guard-siren-socket" cx="0" cy="-3" rx="25" ry="11" />
            <rect class="guard-siren-collar" x="-20" y="-13" width="40" height="8" rx="3" />
            <path class="guard-siren-dome" d={DOME} />
            {/* The reflector at rest. While the siren turns, the HTML reflector below takes its place. */}
            <g clip-path={`url(#${clipId})`}>
              <rect class="guard-siren-reflection" x="-8" y="-48" width="16" height="40" rx="6" />
            </g>
            <path class="guard-siren-glint" d="M-11 -15V-25A11 13 0 0 1 -4 -36" />
            <rect class="guard-siren-cap" x="-5" y="-49" width="10" height="5" rx="2.5" />
          </g>
        </g>
      </svg>
      <span class="guard-siren-glass">
        <span class="guard-siren-dome-light">
          <span class="guard-siren-reflector" />
        </span>
      </span>
    </div>
  );
}

/** The Guard's box of a level, small and still, as the level cards show it. */
function GuardBox(props: { level: GuardLevel; class?: string | undefined }) {
  return (
    <AgentMark
      class={props.class}
      mood={props.level === "off" ? "asleep" : "idle"}
      accent={boxColor(props.level)}
      animated={false}
      emblem={() => <GuardShield alert={false} />}
    />
  );
}

/** The shield on the right face of the box: a keyhole, or "!" while the Guard asks. */
function GuardShield(props: { alert: boolean }) {
  return (
    <g transform={SHIELD_SCALE}>
      <path d={SHIELD} />
      {props.alert ? (
        <>
          <path d="M34 26V41" />
          <circle cx="34" cy="50" r="2.4" fill="currentColor" stroke="none" />
        </>
      ) : (
        <>
          <circle cx="34" cy="34" r="5.6" />
          <path d="M34 39.6V49" />
        </>
      )}
    </g>
  );
}

/** What the Guard does now, as the Guard page says it under the siren. */
export type GuardSirenStatus = "loading" | "off" | "asking" | "local-only" | "signed-out" | "unavailable" | "ready";

const STATUS_TEXT = {
  loading: "guard.siren.status.loading",
  off: "guard.siren.status.off",
  asking: "guard.siren.status.asking",
  "local-only": "guard.siren.status.localOnly",
  "signed-out": "guard.siren.status.signedOut",
  unavailable: "guard.siren.status.unavailable",
  ready: "guard.siren.status.ready",
} as const satisfies Record<GuardSirenStatus, AppTextKey>;

/** The short name of each level, as the siren and the level cards show it. */
const LEVEL_NAME = {
  off: "guard.level.offShort",
  light: "guard.level.light",
  strict: "guard.level.strict",
  "very-strict": "guard.level.veryStrict",
  custom: "guard.level.custom",
} as const satisfies Record<GuardLevel, AppTextKey>;

/**
 * The top of the Guard page: the siren, large, the name of the level and what the Guard does now, in a
 * region that screen readers can find, and `children` under it, such as the level cards. While the
 * level is not known (null), the siren is asleep and the name does not show.
 */
export function GuardSirenHero(props: { level: GuardLevel | null; status: GuardSirenStatus; children?: JSX.Element }) {
  const { t } = useText();
  return (
    <div class="guard-siren-hero" data-level={props.level ?? undefined}>
      <section class="guard-siren-region" aria-label={t("guard.siren.label")}>
        <div class="guard-siren-stage">
          <GuardSiren level={props.level} asking={props.status === "asking"} size="hero" />
        </div>
        <div class="guard-siren-caption">
          <Show when={props.level}>
            {(level) => <strong class="guard-siren-level">{t(LEVEL_NAME[level()])}</strong>}
          </Show>
          <span class="guard-siren-status" role="status">
            {t(STATUS_TEXT[props.status])}
          </span>
        </div>
      </section>
      {props.children}
    </div>
  );
}

/**
 * The level cards under the siren, as in the approved P1 mockup: one card for each level, with the
 * Guard's box of that level. Off and Light can be chosen; the stricter levels show "Soon". The card of
 * the chosen level is lifted and marked, in neutral colors. It is a radio group, so the arrow keys
 * move between the levels that can be chosen.
 */
export function GuardLevelChoice(props: {
  /** Null while the level is not known: no card is chosen. */
  value: GuardLevel | null;
  disabled: boolean;
  onChange: (level: GuardAvailableLevel) => void;
}) {
  const { t } = useText();
  return (
    <RadioGroup.Root
      class="guard-level-choice"
      aria-label={t("guard.level.choose")}
      orientation="horizontal"
      value={props.value ?? ""}
      disabled={props.disabled}
      onChange={(value) => {
        if (isGuardAvailableLevel(value) && value !== props.value) props.onChange(value);
      }}
    >
      <For each={GUARD_LEVELS}>
        {(level) => (
          <RadioGroup.Item class="guard-level-option" value={level} disabled={!isGuardAvailableLevel(level)}>
            <RadioGroup.ItemInput />
            <RadioGroup.ItemControl class="guard-level-card">
              <span class="guard-level-chosen" aria-hidden="true">
                {t("guard.level.chosen")}
              </span>
              <GuardBox level={level} class="guard-level-box" />
              <RadioGroup.ItemLabel class="guard-level-name">{t(LEVEL_NAME[level])}</RadioGroup.ItemLabel>
              <Show when={!isGuardAvailableLevel(level)}>
                <RadioGroup.ItemDescription class="guard-level-soon">
                  {t("guard.level.soon")}
                </RadioGroup.ItemDescription>
              </Show>
            </RadioGroup.ItemControl>
          </RadioGroup.Item>
        )}
      </For>
    </RadioGroup.Root>
  );
}
