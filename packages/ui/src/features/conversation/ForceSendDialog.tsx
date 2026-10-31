import { Checkbox, ConfirmDialog, Zap } from "@openbot/ui";
import { createUniqueId } from "solid-js";
import { useText } from "../../text";

interface ForceSendDialogProps {
  open: boolean;
  /**
   * Gets focus when the dialog closes. The force changes the queue, so the button that opened the
   * dialog can be gone by then.
   */
  restoreFocusTarget?: HTMLElement | null | undefined;
  onCancel: () => void;
  /** `stopAsking` is the person's "Do not ask me again" choice. */
  onConfirm: (stopAsking: boolean) => void;
}

/**
 * Asks before a force of a queued message: the force stops the agent that works now, and other agents
 * that depend on that work can get out of step. Enter confirms, also from the checkbox; Escape cancels.
 */
export function ForceSendDialog(props: ForceSendDialogProps) {
  const { t } = useText();
  const stopAskingId = createUniqueId();
  // The dialog builds its body again each time it opens, so the box starts clear for each force. The
  // box is read when the person confirms: a signal written by the click on the box can still hold the
  // old value when the confirm reads it in the same flush.
  let stopAsking = false;
  const confirm = () => {
    const choice = stopAsking;
    stopAsking = false;
    props.onConfirm(choice);
  };
  return (
    <ConfirmDialog
      open={props.open}
      tone="default"
      icon={<Zap />}
      title={t("queue.force.title")}
      description={t("queue.force.body")}
      confirmLabel={t("queue.force.confirm")}
      cancelLabel={t("common.cancel")}
      initialFocus="confirm"
      restoreFocusTarget={props.restoreFocusTarget}
      onCancel={() => {
        stopAsking = false;
        props.onCancel();
      }}
      onConfirm={confirm}
    >
      <label class="agent-queue-force-skip" for={stopAskingId}>
        <Checkbox
          id={stopAskingId}
          onChange={(event) => {
            stopAsking = event.currentTarget.checked;
          }}
          onKeyDown={(event) => {
            // A checkbox takes Space; Enter confirms, as it does on the confirm button.
            if (event.key !== "Enter") return;
            event.preventDefault();
            confirm();
          }}
        />
        {t("queue.force.stopAsking")}
      </label>
    </ConfirmDialog>
  );
}
