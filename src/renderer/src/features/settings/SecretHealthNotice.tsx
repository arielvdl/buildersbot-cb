import type { SecretHealthStore, UnreadableSecret } from "@openbot/contracts/ipc";
import { Alert, AlertContent, AlertDescription, AlertIcon, AlertTitle, TriangleAlert } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, For, onSettled, Show } from "solid-js";
import { settingsPort } from "./settings-port";

/** What the user does for each store, in the place where its data is entered. Each text names the file. */
const STORE_TEXT = {
  "voice-api-key": "settings.secretHealth.store.voiceApiKey",
  "voice-server-key": "settings.secretHealth.store.voiceServerKey",
  "custom-agents": "settings.secretHealth.store.customAgents",
  "custom-providers": "settings.secretHealth.store.customProviders",
  "provider-credentials": "settings.secretHealth.store.providerCredentials",
  "messaging-credentials": "settings.secretHealth.store.messagingCredentials",
  "egress-proxy": "settings.secretHealth.store.egressProxy",
  "egress-default": "settings.secretHealth.store.egressDefault",
} as const satisfies Record<SecretHealthStore, `settings.secretHealth.store.${string}`>;

/**
 * Settings › General: the encrypted files of this computer that cannot be decrypted now, which
 * happens to all of them at once when the keychain item changes or a profile is copied from another
 * app. Main sends only the store and the file name. The notice is read when the tab opens, so a key
 * that the user saved again in its own tab is gone from the list the next time.
 */
export function SecretHealthNotice() {
  const { t } = useText();
  const [entries, setEntries] = createSignal<UnreadableSecret[]>([]);
  onSettled(() => {
    // A build or a host that does not answer has nothing to show; the list stays empty.
    Promise.resolve()
      .then(() => settingsPort().getUnreadableSecrets())
      .then(setEntries)
      .catch(() => setEntries([]));
  });
  return (
    <Show when={entries().length > 0}>
      <Alert tone="warning" report={{ operation: "settings", source: "system", cause_code: "unknown" }}>
        <AlertIcon>
          <TriangleAlert aria-hidden="true" />
        </AlertIcon>
        <AlertContent>
          <AlertTitle>{t("settings.secretHealth.title")}</AlertTitle>
          <AlertDescription>{t("settings.secretHealth.description")}</AlertDescription>
          <For each={entries()}>
            {(entry) => <AlertDescription>{t(STORE_TEXT[entry.store], { file: entry.file })}</AlertDescription>}
          </For>
        </AlertContent>
      </Alert>
    </Show>
  );
}
