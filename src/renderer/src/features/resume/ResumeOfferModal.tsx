import type { InterruptedWorkOffer } from "@openbot/contracts/ipc";
import { Alert, AlertDescription, Button, Checkbox, Dialog } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Show } from "solid-js";
import { appPort } from "../../app-port";
import { createResumeOfferController } from "./resume-offer-controller";

export interface ResumeOfferModalProps {
  offer: InterruptedWorkOffer;
  selectedChannelIds: readonly string[];
  selectedAgentIds: readonly string[];
  pending: boolean;
  /** The text of the failure; empty for the generic text. Null when nothing failed. */
  error: string | null;
  canResumeSelected: boolean;
  onToggleChannel: (channelId: string, checked: boolean) => void;
  onToggleAgent: (agentId: string, checked: boolean) => void;
  onResumeAll: () => void;
  onResumeSelected: () => void;
  onDismiss: () => void;
}

/**
 * Asks which work that a restart stopped must continue: all of it, some channels or some agents.
 * Not now is a button of its own, and Escape is the same choice. A click outside does nothing, so the
 * choice is never made by accident.
 */
export function ResumeOfferModal(props: ResumeOfferModalProps) {
  const { t, errorMessage } = useText();
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onDismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay>
          <Dialog.Content class="resume-offer-dialog" onPointerDownOutside={(event) => event.preventDefault()}>
            <div class="resume-offer-main">
              <header class="resume-offer-header">
                <Dialog.Title as="h2">{t("app.resume.title")}</Dialog.Title>
                <Dialog.Description>{t("app.resume.description")}</Dialog.Description>
              </header>
              <Show when={props.offer.channels.length > 0}>
                <fieldset class="resume-offer-group">
                  <legend>{t("app.resume.channels")}</legend>
                  <For each={props.offer.channels}>
                    {(channel) => (
                      <label class="resume-offer-row" for={`resume-channel-${channel.id}`}>
                        <Checkbox
                          id={`resume-channel-${channel.id}`}
                          checked={props.selectedChannelIds.includes(channel.id)}
                          disabled={props.pending}
                          onChange={(event) => props.onToggleChannel(channel.id, event.currentTarget.checked)}
                        />
                        <span class="resume-offer-name">{channel.name}</span>
                        <span class="resume-offer-count">
                          {t("app.resume.stoppedTasks", { count: channel.stoppedTasks })}
                        </span>
                      </label>
                    )}
                  </For>
                </fieldset>
              </Show>
              <Show when={props.offer.agents.length > 0}>
                <fieldset class="resume-offer-group">
                  <legend>{t("app.resume.agents")}</legend>
                  <For each={props.offer.agents}>
                    {(agent) => (
                      <label class="resume-offer-row" for={`resume-agent-${agent.id}`}>
                        <Checkbox
                          id={`resume-agent-${agent.id}`}
                          checked={props.selectedAgentIds.includes(agent.id)}
                          disabled={props.pending}
                          onChange={(event) => props.onToggleAgent(agent.id, event.currentTarget.checked)}
                        />
                        <span class="resume-offer-name">{agent.name}</span>
                      </label>
                    )}
                  </For>
                </fieldset>
              </Show>
              <Show when={props.error !== null}>
                {/* Main logs the failed request already, by id. */}
                <Alert tone="danger" report={false} role="alert">
                  <AlertDescription>{errorMessage(props.error, t("app.resume.failed"))}</AlertDescription>
                </Alert>
              </Show>
            </div>
            <footer class="resume-offer-actions">
              <Button
                class="resume-offer-dismiss"
                variant="ghost"
                type="button"
                disabled={props.pending}
                onClick={() => props.onDismiss()}
              >
                {t("app.resume.notNow")}
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={!props.canResumeSelected}
                onClick={() => props.onResumeSelected()}
              >
                {t("app.resume.selected")}
              </Button>
              <Button type="button" loading={props.pending} onClick={() => props.onResumeAll()}>
                {t("app.resume.all")}
              </Button>
            </footer>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The modal in the main window, shown once when the window starts and the restart stopped work. */
export function ResumeOfferHost() {
  const controller = createResumeOfferController(appPort);
  return (
    <Show when={controller.state.offer}>
      {(offer) => (
        <ResumeOfferModal
          offer={offer()}
          selectedChannelIds={controller.state.channelIds}
          selectedAgentIds={controller.state.agentIds}
          pending={controller.state.pending}
          error={controller.state.error}
          canResumeSelected={controller.canResumeSelected()}
          onToggleChannel={controller.toggleChannel}
          onToggleAgent={controller.toggleAgent}
          onResumeAll={() => void controller.resumeAll()}
          onResumeSelected={() => void controller.resumeSelected()}
          onDismiss={() => void controller.dismiss()}
        />
      )}
    </Show>
  );
}
