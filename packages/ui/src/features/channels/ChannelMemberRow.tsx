import type { ProviderLogoVariant } from "@openbot/brand";
import { ProviderLogo } from "@openbot/brand";
import type { AgentReasoningEffort } from "@openbot/contracts/ipc";
import {
  Button,
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  LabelTooltip,
  LabelTooltipTrigger,
  UserRound,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { reasoningLabel } from "../../components/ProviderModelPicker";
import type { AgentProfile } from "../../data";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";

/** The model of a channel member, as its row shows it: the provider mark, the model and its reasoning. */
export interface ChannelMemberModel {
  provider: ProviderLogoVariant;
  /** The name of the model, or its id when the host lists no model with that id. */
  model: string;
  /** Null when the model has no reasoning setting, or does not take this effort. */
  reasoning: AgentReasoningEffort | null;
}

interface ChannelMemberRowProps {
  /** Missing when the channel holds a member the agent list no longer has. */
  agent?: AgentProfile | undefined;
  /** What to call a member the agent list cannot name. */
  fallbackName: string;
  description?: string;
  /** What stands before the avatar, such as the picker checkbox. */
  leading?: JSX.Element;
  /** What stands after the name, such as the lead crown and Remove. */
  actions?: JSX.Element;
  /** Opens the member, as the name does in Channel settings. */
  onActivate?: (() => void) | undefined;
  /** The member's model: its provider mark shows after the name, and its tooltip names the model. */
  model?: ChannelMemberModel | undefined;
  class?: string;
}

/**
 * One agent on one line: the avatar, the name, and whatever the surface adds on either side.
 *
 * Settings, the add-member menu and the New channel dialog all list the same agents, so they list
 * them the same way. Only the slots differ.
 */
export function ChannelMemberRow(props: ChannelMemberRowProps): JSX.Element {
  const name = () => (
    <Show
      when={props.onActivate}
      fallback={
        <>
          <ItemTitle>{props.agent?.name ?? props.fallbackName}</ItemTitle>
          <Show when={props.description}>
            <ItemDescription>{props.description}</ItemDescription>
          </Show>
        </>
      }
    >
      {(activate) => (
        <Button type="button" variant="ghost" class="channel-member-open" onClick={activate()}>
          <ItemTitle>{props.agent?.name ?? props.fallbackName}</ItemTitle>
          <Show when={props.description}>
            <ItemDescription>{props.description}</ItemDescription>
          </Show>
        </Button>
      )}
    </Show>
  );
  return (
    <Item size="compact" class={props.class ? `channel-member ${props.class}` : "channel-member"}>
      <Show when={props.leading}>{props.leading}</Show>
      <ItemMedia>
        <Show when={props.agent} fallback={<UserRound aria-hidden="true" />}>
          {(agent) => <AgentAvatar agent={agent()} />}
        </Show>
      </ItemMedia>
      <ItemContent>
        <Show when={props.model} fallback={name()}>
          {(model) => (
            <span class="channel-member-name-line">
              {name()}
              <MemberModelMark model={model()} />
            </span>
          )}
        </Show>
      </ItemContent>
      <Show when={props.actions}>{props.actions}</Show>
    </Item>
  );
}

/**
 * The provider mark of a member's model, so the reader sees which models a channel has. The tooltip
 * and the accessible name give the model and its reasoning.
 */
function MemberModelMark(props: { model: ChannelMemberModel }) {
  const { t, locale } = useText();
  const label = () => {
    const effort = props.model.reasoning;
    if (!effort) return props.model.model;
    return t("channel.members.model", {
      model: props.model.model,
      reasoning: reasoningLabel(effort, t).toLocaleLowerCase(locale()),
    });
  };
  return (
    <LabelTooltip content={label()}>
      <LabelTooltipTrigger as="span" class="channel-member-model" role="img" aria-label={label()}>
        <ProviderLogo provider={props.model.provider} class="channel-member-model-mark" />
      </LabelTooltipTrigger>
    </LabelTooltip>
  );
}
