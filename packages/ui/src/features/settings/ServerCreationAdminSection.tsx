import { SERVER_CREATION_NOTE_MAX_LENGTH } from "@openbot/contracts/server-creation";
import {
  Button,
  Field,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
  Text,
  Trash2,
} from "@openbot/ui";
import { createUniqueId, For, Show } from "solid-js";
import { useText } from "../../text";
import type { ServerCreationAdminStore } from "./stores/server-creation-admin-store";

interface ServerCreationAdminSectionProps {
  store: ServerCreationAdminStore;
}

/**
 * Only administrators see this section. They approve or deny the requests to create a remote server,
 * remove a permission, and give the permission by email. Joining a server needs no permission.
 */
export function ServerCreationAdminSection(props: ServerCreationAdminSectionProps) {
  const { t, format } = useText();
  const state = () => props.store.state;
  const emailId = createUniqueId();
  const noteId = createUniqueId();
  const date = (value: number) => format.date(new Date(value), { dateStyle: "medium" });
  const busy = () => state().busy !== null;

  return (
    <Show when={state().administrator}>
      <SettingsSection
        class="server-creation-admin"
        title={t("settings.serverCreation.title")}
        description={t("settings.serverCreation.description")}
      >
        <Show when={state().error}>
          {(message) => (
            <div class="server-creation-admin-error">
              <p class="settings-modal-error" role="alert">
                {message()}
              </p>
              <Button variant="outline" size="sm" onClick={props.store.reload}>
                {t("common.retry")}
              </Button>
            </div>
          )}
        </Show>
        <Show when={state().actionError}>
          {(message) => (
            <p class="settings-modal-error" role="alert">
              {message()}
            </p>
          )}
        </Show>

        <Text as="p" variant="label">
          {t("settings.serverCreation.requests")}
        </Text>
        <Show
          when={state().requests.length > 0}
          fallback={
            <Show when={state().loaded}>
              <Text tone="muted">{t("settings.serverCreation.noRequests")}</Text>
            </Show>
          }
        >
          <ItemGroup class="settings-modal-card" surface="subtle">
            <For each={state().requests}>
              {(request) => (
                <Item>
                  <ItemContent>
                    <ItemTitle>{request.name ?? request.email}</ItemTitle>
                    <ItemDescription>
                      <Show when={request.name}>
                        <span class="server-creation-admin-email">{request.email}</span>
                      </Show>
                      <span class="server-creation-admin-reason">{request.reason}</span>
                      <span>{t("settings.serverCreation.requestedAt", { date: date(request.createdAt) })}</span>
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      size="sm"
                      aria-label={t("settings.serverCreation.approveLabel", { name: request.name ?? request.email })}
                      loading={state().busy === request.id}
                      disabled={busy()}
                      onClick={() => props.store.approve(request.id)}
                    >
                      {t("settings.serverCreation.approve")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("settings.serverCreation.denyLabel", { name: request.name ?? request.email })}
                      disabled={busy()}
                      onClick={() => props.store.deny(request.id)}
                    >
                      {t("settings.serverCreation.deny")}
                    </Button>
                  </ItemActions>
                </Item>
              )}
            </For>
          </ItemGroup>
        </Show>

        <Text as="p" variant="label">
          {t("settings.serverCreation.allowed")}
        </Text>
        <Show
          when={state().grants.length > 0}
          fallback={
            <Show when={state().loaded}>
              <Text tone="muted">{t("settings.serverCreation.noGrants")}</Text>
            </Show>
          }
        >
          <ItemGroup class="settings-modal-card" surface="subtle">
            <For each={state().grants}>
              {(grant) => (
                <Item>
                  <ItemContent>
                    <ItemTitle>{grant.name ?? grant.email}</ItemTitle>
                    <ItemDescription>
                      <Show when={grant.name}>
                        <span class="server-creation-admin-email">{grant.email}</span>
                      </Show>
                      <span>
                        {grant.note
                          ? t("settings.serverCreation.grantedAtNote", {
                              date: date(grant.grantedAt),
                              note: grant.note,
                            })
                          : t("settings.serverCreation.grantedAt", { date: date(grant.grantedAt) })}
                      </span>
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      variant="destructive-ghost"
                      size="sm"
                      aria-label={t("settings.serverCreation.revokeLabel", { name: grant.name ?? grant.email })}
                      loading={state().busy === grant.userId}
                      disabled={busy()}
                      onClick={() => props.store.revoke(grant.userId)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      {t("settings.serverCreation.revoke")}
                    </Button>
                  </ItemActions>
                </Item>
              )}
            </For>
          </ItemGroup>
        </Show>

        <form
          class="server-creation-admin-grant"
          onSubmit={(event) => {
            event.preventDefault();
            void props.store.grant();
          }}
        >
          <Field label={t("settings.serverCreation.grantEmail")} htmlFor={emailId}>
            <Input
              id={emailId}
              type="email"
              autocomplete="off"
              spellcheck={false}
              value={state().email}
              onValueChange={props.store.setEmail}
              disabled={busy()}
              required
            />
          </Field>
          <Field label={t("settings.serverCreation.grantNote")} htmlFor={noteId}>
            <Input
              id={noteId}
              maxlength={SERVER_CREATION_NOTE_MAX_LENGTH}
              value={state().note}
              onValueChange={props.store.setNote}
              disabled={busy()}
            />
          </Field>
          <Button type="submit" loading={state().busy === "grant"} disabled={!state().email.trim() || busy()}>
            {t("settings.serverCreation.grant")}
          </Button>
        </form>
      </SettingsSection>
    </Show>
  );
}
