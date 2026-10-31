import { ProviderLogo } from "@openbot/brand";
import { Circle, CircleDot, Diamond, Hexagon, Moon, Pentagon, Sparkle, Triangle } from "@openbot/ui";
import { Match, Switch } from "solid-js";
import type { OrbitFamily } from "./orbits-view";

/**
 * The small mark of a model family, readable at 10 to 12 px. A Claude tier has a shape of its own,
 * because one provider runs most agents and its logo alone does not tell Opus from Haiku: a diamond
 * for Opus, a ring with a dot for Sonnet, a triangle for Haiku, a spark for Fable. A maker of open
 * models with no logo in this build has a plain shape: a moon for Kimi, a hexagon for GLM, a pentagon
 * for Qwen. Another family shows its provider's logo, and a provider that this build does not know
 * shows a plain ring.
 */
export function OrbitFamilyGlyph(props: { family: OrbitFamily; class?: string }) {
  const tier = () => (props.family.kind === "tier" ? props.family.id : null);
  const maker = () => (props.family.kind === "maker" ? props.family.id : null);
  return (
    <span class={["orbit-glyph", props.class]} data-family={props.family.id} aria-hidden="true">
      <Switch fallback={<Circle />}>
        <Match when={tier() === "opus"}>
          <Diamond />
        </Match>
        <Match when={tier() === "sonnet"}>
          <CircleDot />
        </Match>
        <Match when={tier() === "haiku"}>
          <Triangle />
        </Match>
        <Match when={tier() === "fable"}>
          <Sparkle />
        </Match>
        <Match when={maker() === "kimi"}>
          <Moon />
        </Match>
        <Match when={maker() === "glm"}>
          <Hexagon />
        </Match>
        <Match when={maker() === "qwen"}>
          <Pentagon />
        </Match>
        <Match when={props.family.kind === "provider" ? props.family.id : null}>
          {(provider) => <ProviderLogo provider={provider()} />}
        </Match>
      </Switch>
    </span>
  );
}
