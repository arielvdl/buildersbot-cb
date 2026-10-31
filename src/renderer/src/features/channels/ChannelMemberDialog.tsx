import { agentProviderDescriptor, foreignProvider, isKnownAgentProvider } from "@openbot/contracts/agent-providers";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentModelId, AgentProviderId, AgentReasoningEffort } from "@openbot/contracts/ipc";
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  ErrorReference,
  Field,
  IconButton,
  Input,
  RefreshCw,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  X,
} from "@openbot/ui";
import { AVATAR_HUE_CHOICES, avatarCandidateSeeds, avatarHueSwatch } from "@openbot/ui/bloub-avatar";
import { ProviderModelPicker, reasoningLabel } from "@openbot/ui/components/ProviderModelPicker";
import type { AgentProfile } from "@openbot/ui/data";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { AVATAR_HUE_LABEL } from "@openbot/ui/features/agents/avatar-hue-label";
import { InstructionsLimit, instructionsTooLong } from "@openbot/ui/features/agents/InstructionsLimit";
import { useText } from "@openbot/ui/text";
import { prefersReducedMotion } from "@openbot/ui/utils";
import { errorReference } from "@openbot/user-errors";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useProviders } from "../../providers";
import { useAgentActions } from "../agents/agent-actions";
import { useAgents } from "../agents/agents-context";
import { useCustomAgents } from "../custom-agents/custom-agents-context";
import { useCustomProviders } from "../custom-providers/custom-providers-context";
import { useServers } from "../servers/servers-context";

interface ChannelMemberDialogProps {
  open: boolean;
  /** The member to edit. Absent creates a new agent for the channel. */
  agent?: AgentProfile | undefined;
  onClose: () => void;
  /** The agent that was created, so the channel can add it as a member. */
  onCreated: (agentId: string) => void;
}

interface MemberDraft {
  name: string;
  title: string;
  description: string;
  avatarSeed: string;
  avatarHue: AgentProfile["avatarHue"];
  batch: number;
  provider: AgentProviderId;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
}

const FACE_CHOICES = 4;

/**
 * The identity of one channel member, edited where the member is listed.
 *
 * The channel settings used to send the reader to the agent's own settings to change a name or a
 * model. The same form now opens here, over the member list, and it is also how a channel gets a
 * new agent: the picker creates it and adds it in one go.
 */
export function ChannelMemberDialog(props: ChannelMemberDialogProps) {
  const agents = useAgents();
  const actions = useAgentActions();
  const providers = useProviders();
  const { customProviders } = useCustomProviders();
  const { customAgents } = useCustomAgents();
  const { activeServer } = useServers();
  const { t, errorMessage } = useText();
  const creating = () => props.agent === undefined;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<{ message: string; reference: string | null } | null>(null);
  const [draft, setDraft] = createSignal<MemberDraft>(emptyDraft());

  function emptyDraft(): MemberDraft {
    const seed = crypto.randomUUID();
    return {
      name: "",
      title: "",
      description: "",
      avatarSeed: `member:${seed}`,
      avatarHue: null,
      batch: 0,
      ...defaultRuntime(),
    };
  }

  /** The first model the provider status offers, or the backend default when the catalogue is empty. */
  function defaultRuntime(): Pick<MemberDraft, "provider" | "model" | "reasoningEffort"> {
    const option = agents.modelOptions().find((item) => item.provider !== "acp" && !item.id.startsWith("acp:"));
    if (option)
      return {
        provider: isKnownAgentProvider(option.provider) ? option.provider : "codex",
        model: option.id,
        reasoningEffort: "medium",
      };
    return {
      provider: "codex",
      model: agentProviderDescriptor("codex").defaultModel,
      reasoningEffort: "medium",
    };
  }

  const foreign = () => {
    const agent = props.agent;
    return agent ? foreignProvider(agent.provider) : undefined;
  };
  const selectedModel = createMemo(() =>
    agents.modelOptions().find((option) => option.provider === draft().provider && option.id === draft().model),
  );
  const reasoningOptions = createMemo(() => selectedModel()?.supportedReasoningEfforts ?? ["medium" as const]);
  const reasoningSetByProvider = () => selectedModel()?.reasoningEffortConfigurable === false;
  const faces = createMemo(() => {
    const current = draft();
    return avatarCandidateSeeds(`member:${current.avatarSeed}`, current.avatarSeed, current.batch).slice(
      0,
      FACE_CHOICES,
    );
  });
  const tooLong = () => instructionsTooLong(draft().description);

  // The form is refilled from the member each time the dialog opens, and reset for a new one.
  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
      setError(null);
      setBusy(false);
      const agent = props.agent;
      setDraft(
        agent
          ? {
              name: agent.name,
              title: agent.title,
              description: agent.description,
              avatarSeed: agent.avatarSeed,
              avatarHue: agent.avatarHue,
              batch: 0,
              provider: isKnownAgentProvider(agent.provider) ? agent.provider : "codex",
              model: agent.model,
              reasoningEffort: agent.reasoningEffort,
            }
          : emptyDraft(),
      );
    },
  );

  function patch(change: Partial<MemberDraft>) {
    setDraft((current) => ({ ...current, ...change }));
  }

  function pickModel(model: AgentModelId, provider: AgentProviderId) {
    const option = agents.modelOptions().find((item) => item.provider === provider && item.id === model);
    patch({
      model,
      provider,
      reasoningEffort: option?.defaultReasoningEffort ?? "medium",
    });
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const current = draft();
    const name = current.name.trim();
    if (!name || tooLong() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      if (props.agent) {
        await agents.updateAgent(props.agent.id, {
          name,
          title: current.title.trim(),
          description: current.description.trim(),
          avatarSeed: current.avatarSeed,
          avatarHue: current.avatarHue,
          provider: current.provider,
          model: current.model,
          reasoningEffort: current.reasoningEffort,
        });
      } else {
        const created = await actions.createAgentInPlace({
          name,
          purpose: current.description.trim(),
          avatarSeed: current.avatarSeed,
          avatarHue: current.avatarHue,
          provider: current.provider,
          model: current.model,
          reasoningEffort: current.reasoningEffort,
        });
        props.onCreated(created.id);
      }
      props.onClose();
    } catch (failure) {
      setError({
        message: errorMessage(
          failure,
          creating() ? t("channel.members.dialog.createFailed") : t("channel.members.dialog.saveFailed"),
        ),
        reference: errorReference(failure),
      });
    } finally {
      setBusy(false);
    }
  }

  let runtime: HTMLDivElement | undefined;
  /** Shows the whole model section, with its reasoning, when one of its menus opens. */
  const revealRuntime = () =>
    runtime?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="channel-dialog-backdrop">
          <Dialog.Content class="channel-create-dialog channel-member-dialog">
            <header class="channel-dialog-header">
              <Dialog.Title>
                {creating()
                  ? t("channel.members.dialog.createTitle")
                  : t("channel.members.dialog.editTitle", { name: props.agent?.name ?? "" })}
              </Dialog.Title>
              <IconButton label={t("common.close")} variant="ghost" onClick={props.onClose}>
                <X />
              </IconButton>
            </header>
            <form class="channel-create-form channel-member-form" onSubmit={(event) => void submit(event)}>
              <p class="channel-member-form-note">
                {creating() ? t("channel.members.dialog.createDescription") : t("channel.members.dialog.description")}
              </p>
              <Show when={error()}>
                {(failure) => (
                  <Alert tone="danger" role="alert">
                    <AlertDescription>
                      {failure().message}
                      <ErrorReference reference={failure().reference} />
                    </AlertDescription>
                  </Alert>
                )}
              </Show>
              <div class="channel-member-face">
                <AgentAvatar seed={draft().avatarSeed} hue={draft().avatarHue} class="channel-member-face-preview" />
                <fieldset class="channel-member-faces" aria-label={t("agentSettings.avatar.faces")}>
                  <For each={faces()}>
                    {(seed, index) => (
                      <Button
                        type="button"
                        variant="ghost"
                        class={[
                          "channel-member-face-choice",
                          { "channel-member-face-selected": draft().avatarSeed === seed },
                        ]}
                        aria-label={t("agentSettings.avatar.option", { number: index() + 1 })}
                        aria-pressed={draft().avatarSeed === seed ? "true" : "false"}
                        onClick={() => patch({ avatarSeed: seed })}
                      >
                        <AgentAvatar seed={seed} hue={draft().avatarHue} />
                      </Button>
                    )}
                  </For>
                </fieldset>
                <IconButton
                  label={t("agentSettings.avatar.newSet")}
                  variant="ghost"
                  onClick={() => patch({ batch: draft().batch + 1 })}
                >
                  <RefreshCw />
                </IconButton>
              </div>
              <fieldset class="channel-member-hues" aria-label={t("agentSettings.avatar.colorLabel")}>
                <Button
                  type="button"
                  variant="ghost"
                  class={["channel-member-hue", { "channel-member-face-selected": draft().avatarHue === null }]}
                  aria-label={t("agentSettings.avatar.autoColor")}
                  aria-pressed={draft().avatarHue === null ? "true" : "false"}
                  onClick={() => patch({ avatarHue: null })}
                >
                  {t("agentSettings.avatar.autoInitial")}
                </Button>
                <For each={AVATAR_HUE_CHOICES}>
                  {(option) => (
                    <Button
                      type="button"
                      variant="ghost"
                      class={[
                        "channel-member-hue",
                        { "channel-member-face-selected": draft().avatarHue === option.hue },
                      ]}
                      aria-label={t("agentSettings.avatar.hueColor", { hue: t(AVATAR_HUE_LABEL[option.hue]) })}
                      aria-pressed={draft().avatarHue === option.hue ? "true" : "false"}
                      onClick={() => patch({ avatarHue: option.hue })}
                    >
                      <span class="channel-member-hue-swatch" style={{ background: avatarHueSwatch(option.hue) }} />
                    </Button>
                  )}
                </For>
              </fieldset>
              {/* The model is near the top, so its menu has room to open under it. */}
              <div
                ref={(element) => {
                  runtime = element;
                }}
                class="agent-settings-runtime-rows channel-member-runtime"
              >
                <ProviderModelPicker
                  variant="field"
                  ariaLabel={t("agentSettings.runtime.model")}
                  provider={draft().provider}
                  foreignProvider={foreign()}
                  value={draft().model}
                  agentStatus={agents.agentStatus()}
                  modelOptions={agents.modelOptions()}
                  runtimeStatuses={
                    providers.providerRuntimeDownloadsAvailable() ? providers.providerRuntimeStatuses() : undefined
                  }
                  customProviders={customProviders()}
                  customAgents={activeServer()?.kind === "local" ? customAgents() : undefined}
                  onDownloadProvider={
                    providers.providerRuntimeDownloadsAvailable() ? providers.downloadProviderRuntime : undefined
                  }
                  onCancelProviderDownload={
                    providers.providerRuntimeDownloadsAvailable() ? providers.cancelProviderRuntimeDownload : undefined
                  }
                  onConnectProvider={providers.connectProvider}
                  disabledReason={t("agentSettings.runtime.modelUnavailable")}
                  onChange={(model, provider) => pickModel(model, provider)}
                  onOpenChange={(open) => {
                    if (open) revealRuntime();
                  }}
                />
                <Select<AgentReasoningEffort>
                  class="agent-settings-runtime-select"
                  options={reasoningOptions()}
                  onOpenChange={(open) => {
                    if (open) revealRuntime();
                  }}
                  value={draft().reasoningEffort}
                  disabled={reasoningSetByProvider() || foreign() !== undefined}
                  onChange={(effort) => {
                    if (effort) patch({ reasoningEffort: effort });
                  }}
                  itemComponent={(item) => (
                    <SelectItem item={item.item}>{reasoningLabel(item.item.rawValue)}</SelectItem>
                  )}
                >
                  <SelectTrigger
                    class="agent-settings-runtime-row"
                    aria-label={t("agentSettings.runtime.reasoningLabel")}
                  >
                    <span class="agent-settings-runtime-label">{t("agentSettings.runtime.reasoning")}</span>
                    <SelectValue<AgentReasoningEffort>>
                      {(state) => {
                        const effort = state.selectedOption();
                        return effort ? reasoningLabel(effort) : t("agentSettings.runtime.selectReasoning");
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              </div>
              <Field label={t("agentSettings.name")}>
                <Input
                  aria-label={t("agentSettings.nameLabel")}
                  maxlength={INPUT_LIMITS.agentName}
                  required
                  value={draft().name}
                  onValueChange={(name) => patch({ name })}
                />
              </Field>
              <Field label={t("agentSettings.agentTitle")}>
                <Input
                  aria-label={t("agentSettings.agentTitleLabel")}
                  placeholder={t("agentSettings.agentTitlePlaceholder")}
                  maxlength={INPUT_LIMITS.agentTitle}
                  value={draft().title}
                  onValueChange={(title) => patch({ title })}
                />
              </Field>
              <Field label={t("agentSettings.instructions")}>
                <Textarea
                  class="settings-instructions-input"
                  rows="5"
                  aria-label={t("agentSettings.instructionsLabel")}
                  placeholder={t("agentSettings.instructionsPlaceholder")}
                  invalid={tooLong()}
                  value={draft().description}
                  onValueChange={(description) => patch({ description })}
                />
                <InstructionsLimit text={draft().description} />
              </Field>
              <footer class="channel-editor-footer">
                <Button type="button" variant="ghost" onClick={props.onClose}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={!draft().name.trim() || tooLong()} loading={busy()}>
                  {creating() ? t("common.create") : t("common.save")}
                </Button>
              </footer>
            </form>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
