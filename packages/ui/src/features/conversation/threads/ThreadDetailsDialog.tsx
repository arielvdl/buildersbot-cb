/**
 * The details of a thread, or of the agent's own chat: what it is, when it started, the message that
 * started it and the last message that the person sent. The selected tab opens it with its info
 * button, so the person can see what the thread is for also after a rename. It only shows text: the
 * text is selectable, and each message has a copy button. Escape and the close buttons close it, and
 * the focus goes back to the control that opened it, or to `returnFocus` when that control is gone.
 */

import { Button, CopyButton, Dialog, IconButton, X } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, Show } from "solid-js";
import { chatPreviewBlock, sameMessageText } from "./thread-preview-text";
import type { ThreadItem } from "./thread-types";

export interface ThreadDetails {
  title: string;
  /** When the thread started, as an ISO time. Missing for the agent's own chat. */
  startedAt?: string | undefined;
  /** The message that started the thread, as plain text. Empty when unknown. */
  firstMessage: string;
  /** The last message that the person sent, as plain text. Empty when the person sent none. */
  lastMessage: string;
}

/** The details of a thread for its dialog, as plain text that keeps its lines. */
export function threadDetails(thread: ThreadItem): ThreadDetails {
  return {
    title: thread.title,
    startedAt: thread.createdAt,
    firstMessage: chatPreviewBlock(thread.firstMessage),
    lastMessage: chatPreviewBlock(thread.preview),
  };
}

export function ThreadDetailsDialog(props: {
  details: ThreadDetails | null;
  onClose: () => void;
  /**
   * The element that gets the focus when the dialog closes and the control that opened it is gone or
   * had no focus, such as a menu item. Read when the dialog closes.
   */
  returnFocus?: (() => HTMLElement | null | undefined) | undefined;
}) {
  // A controlled dialog has no Kobalte trigger, so it keeps the element that opened it itself.
  let opener: HTMLElement | undefined;
  return (
    <Dialog.Root
      open={props.details !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="ui-confirm-dialog-overlay">
          <Dialog.Content
            as="section"
            class="ui-dialog-content thread-details-dialog"
            onOpenAutoFocus={() => {
              const active = document.activeElement;
              opener = active instanceof HTMLElement && active !== document.body ? active : undefined;
            }}
            onCloseAutoFocus={(event) => {
              const target = opener?.isConnected ? opener : props.returnFocus?.();
              opener = undefined;
              if (!target?.isConnected) return;
              event.preventDefault();
              target.focus({ preventScroll: true });
            }}
          >
            <Show when={props.details}>
              {(details) => <ThreadDetailsBody details={details()} onClose={props.onClose} />}
            </Show>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ThreadDetailsBody(props: { details: ThreadDetails; onClose: () => void }) {
  const { t, format } = useText();
  const started = () => {
    const at = props.details.startedAt ? new Date(props.details.startedAt) : null;
    return at && !Number.isNaN(at.getTime()) ? format.date(at, { dateStyle: "medium", timeStyle: "short" }) : null;
  };
  // Until the person writes again, the last message is the first one: it shows once.
  const lastIsFirst = () => sameMessageText(props.details.firstMessage, props.details.lastMessage);
  return (
    <div class="thread-details">
      <header class="thread-details-header">
        <div class="thread-details-heading">
          <Dialog.Title as="h2" class="thread-details-title">
            {props.details.title}
          </Dialog.Title>
          <Show when={started()}>
            {(time) => (
              <p class="thread-details-started">{t("conversation.threads.details.started", { time: time() })}</p>
            )}
          </Show>
        </div>
        <IconButton label={t("common.close")} variant="ghost" onClick={props.onClose}>
          <X />
        </IconButton>
      </header>
      <ThreadDetailsMessage
        label={t("conversation.threads.details.first")}
        copyLabel={t("conversation.threads.details.copyFirst")}
        text={props.details.firstMessage}
      />
      <ThreadDetailsMessage
        label={t("conversation.threads.details.last")}
        copyLabel={t("conversation.threads.details.copyLast")}
        text={props.details.lastMessage}
        note={lastIsFirst() ? t("conversation.threads.details.sameAsFirst") : undefined}
      />
      <footer class="thread-details-footer">
        <Button type="button" variant="ghost" onClick={props.onClose}>
          {t("common.close")}
        </Button>
      </footer>
    </div>
  );
}

/**
 * One message, cut to a few lines. "Show more" shows all of it, and the dialog scrolls. The button
 * shows only when the text is longer than the cut, or while the text shows in full. A `note` shows in
 * place of the text, such as when the text is the same as the one above it.
 */
function ThreadDetailsMessage(props: { label: string; copyLabel: string; text: string; note?: string | undefined }) {
  const { t } = useText();
  const [expanded, setExpanded] = createSignal(false);
  const [cut, setCut] = createSignal(false);
  const [body, setBody] = createSignal<HTMLParagraphElement | undefined>(undefined, { ownedWrite: true });
  const shown = () => (props.note ? "" : props.text);
  // A collapsed text is cut when it is taller than its box. An expanded one is never measured. The text
  // can show after the dialog opens, or change while it is open, so each new text is measured again.
  createEffect(
    () => ({ element: body(), text: shown() }),
    ({ element }) => {
      if (!element) return;
      const measure = () => {
        if (element.dataset.expanded === undefined) setCut(element.scrollHeight > element.clientHeight + 1);
      };
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      measure();
      return () => observer.disconnect();
    },
  );
  return (
    <section class="thread-details-message">
      <div class="thread-details-message-header">
        <h3 class="thread-details-label">{props.label}</h3>
        <Show when={shown()}>
          <CopyButton value={props.text} label={props.copyLabel} iconOnly size="icon-xs" />
        </Show>
      </div>
      <Show
        when={shown()}
        fallback={<p class="thread-details-none">{props.note ?? t("conversation.threads.details.none")}</p>}
      >
        <p ref={setBody} class="thread-details-text" data-expanded={expanded() ? "" : undefined}>
          {props.text}
        </p>
        <Show when={cut() || expanded()}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            class="thread-details-toggle"
            aria-expanded={expanded() ? "true" : "false"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded() ? t("conversation.threads.details.less") : t("conversation.threads.details.more")}
          </Button>
        </Show>
      </Show>
    </section>
  );
}
