import { SERVER_CREATION_REASON_MAX_LENGTH, type ServerCreationAccess } from "@openbot/contracts/server-creation";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  Button,
  ErrorReference,
  Field,
  Heading,
  OctagonX,
  Text,
  Textarea,
} from "@openbot/ui";
import type { UserErrorDetails } from "@openbot/user-errors";
import { createSignal, createUniqueId, Match, Show, Switch } from "solid-js";
import { useText } from "../../text";
import { serverCreateAccessState } from "./server-create-access";

export interface ServerCreateAccessProps {
  access: ServerCreationAccess | null;
  /** Opens the hosted server plans. Without it, a person who can create sees no section. */
  onCreate?: (() => void) | undefined;
  /** Sends the request to the administrator. The consumer then shows the new access. */
  onRequest: (reason: string) => Promise<void>;
  disabled?: boolean | undefined;
}

/**
 * Joining a server needs no permission; creating a new remote server does. A person with permission
 * opens the plans from here. A person without it asks the administrator, with a short reason.
 */
export function ServerCreateAccess(props: ServerCreateAccessProps) {
  const { t, errorDetails } = useText();
  const headingId = createUniqueId();
  const reasonId = createUniqueId();
  const [asking, setAsking] = createSignal(false);
  const [reason, setReason] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<UserErrorDetails | null>(null);
  const state = () => serverCreateAccessState(props.access, Boolean(props.onCreate));

  async function send(): Promise<void> {
    const text = reason().trim();
    if (!text || sending()) return;
    setSending(true);
    setError(null);
    try {
      await props.onRequest(text);
      setAsking(false);
      setReason("");
    } catch (cause) {
      setError(errorDetails(cause, t("server.createAccess.requestFailed")));
    } finally {
      setSending(false);
    }
  }

  function cancel(): void {
    setAsking(false);
    setError(null);
  }

  return (
    <Show when={state()}>
      {(current) => (
        <section class="server-create-access" aria-labelledby={headingId}>
          <Heading id={headingId} as="h3" size="sm">
            {t("server.createAccess.title")}
          </Heading>
          <Switch>
            <Match when={current() === "allowed"}>
              <Text tone="muted">{t("server.createAccess.allowedDescription")}</Text>
              <Button variant="outline" disabled={props.disabled} onClick={() => props.onCreate?.()}>
                {t("server.createAccess.create")}
              </Button>
            </Match>
            <Match when={current() === "pending"}>
              <Text tone="muted" role="status">
                {t("server.createAccess.pending")}
              </Text>
            </Match>
            <Match when={current() === "request" || current() === "denied"}>
              <Text tone="muted">
                {current() === "denied" ? t("server.createAccess.denied") : t("server.createAccess.requestDescription")}
              </Text>
              <Show
                when={asking()}
                fallback={
                  <Button variant="outline" disabled={props.disabled} onClick={() => setAsking(true)}>
                    {current() === "denied" ? t("server.createAccess.askAgain") : t("server.createAccess.ask")}
                  </Button>
                }
              >
                <form
                  class="server-create-access-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
                  <Field
                    label={t("server.createAccess.reason")}
                    htmlFor={reasonId}
                    description={t("server.createAccess.reasonHint", { max: SERVER_CREATION_REASON_MAX_LENGTH })}
                  >
                    <Textarea
                      id={reasonId}
                      rows={3}
                      maxlength={SERVER_CREATION_REASON_MAX_LENGTH}
                      value={reason()}
                      onValueChange={setReason}
                      disabled={sending()}
                      required
                    />
                  </Field>
                  <Show when={error()}>
                    {(failure) => (
                      <Alert tone="danger" role="alert">
                        <AlertIcon>
                          <OctagonX />
                        </AlertIcon>
                        <AlertContent>
                          <AlertDescription>{failure().message}</AlertDescription>
                          <ErrorReference reference={failure().reference} />
                        </AlertContent>
                      </Alert>
                    )}
                  </Show>
                  <div class="server-create-access-actions">
                    <Button
                      type="submit"
                      loading={sending()}
                      loadingLabel={t("server.createAccess.sending")}
                      disabled={!reason().trim() || props.disabled}
                    >
                      {t("server.createAccess.send")}
                    </Button>
                    <Button type="button" variant="ghost" disabled={sending()} onClick={cancel}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </form>
              </Show>
            </Match>
          </Switch>
        </section>
      )}
    </Show>
  );
}
