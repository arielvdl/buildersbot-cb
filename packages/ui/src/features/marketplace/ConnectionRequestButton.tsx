import type { HubAccessRequestKind, HubConnectionAccessRequestResult } from "@openbot/contracts/ipc";
import { Button, Text } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createStore, Show } from "solid-js";

/**
 * Asks the admins of an organization: "Ask the admin" for access, or "Ask the admin for more" at the
 * cap. The Hub keeps one request for 7 days, so after a request the button gives way to "Request sent
 * on {date}". A request that did not reach the Hub says so, and the button stays.
 */
export function ConnectionRequestButton(props: {
  kind: HubAccessRequestKind;
  /** The date of a request of these 7 days, from the Hub. */
  sentAt: string | null;
  request: () => Promise<HubConnectionAccessRequestResult>;
}) {
  const { t, format } = useText();
  const [state, setState] = createStore<{ busy: boolean; sentAt: string | null; failed: boolean }>({
    busy: false,
    sentAt: null,
    failed: false,
  });
  const sentAt = () => state.sentAt ?? props.sentAt;
  const ask = () => {
    setState((draft) => {
      draft.busy = true;
      draft.failed = false;
    });
    void props.request().then(
      (result) =>
        setState((draft) => {
          draft.busy = false;
          draft.sentAt = result.requestedAt;
          draft.failed = result.status === "failed";
        }),
      () =>
        setState((draft) => {
          draft.busy = false;
          draft.failed = true;
        }),
    );
  };
  return (
    <Show
      when={sentAt()}
      fallback={
        <span class="marketplace-connection-request">
          <Button type="button" size="sm" variant="outline" loading={state.busy} onClick={ask}>
            {props.kind === "more"
              ? t("marketplace.connection.request.more")
              : t("marketplace.connection.request.access")}
          </Button>
          <Show when={state.failed}>
            <Text as="span" variant="caption" tone="muted" role="alert">
              {t("marketplace.connection.request.failed")}
            </Text>
          </Show>
        </span>
      }
    >
      {(date) => (
        <Text as="span" variant="caption" tone="muted" role="status">
          {t("marketplace.connection.request.sent", {
            date: format.date(new Date(date()), { day: "2-digit", month: "2-digit" }),
          })}
        </Text>
      )}
    </Show>
  );
}
