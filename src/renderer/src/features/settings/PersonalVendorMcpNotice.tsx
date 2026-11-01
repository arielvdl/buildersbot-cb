import { agentProviderName, type PersonalVendorMcpNotice as Notice } from "@openbot/contracts/ipc";
import { Alert, AlertContent, AlertDescription, AlertIcon, AlertTitle, TriangleAlert } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, For, onSettled, Show } from "solid-js";
import { settingsPort } from "./settings-port";

const NONE: Notice = { files: [], uncovered: [] };

/**
 * Settings › General: a treg setup of the person's own in the MCP files of other agent apps (the treg
 * design, §3.13). treg's installer writes the token in plain text there, and every agent with
 * terminal access can read it. Builders Bot turns those entries off in the agents that it can cover;
 * the notice names the files and the providers whose agents can still use the entry. Main sends only
 * file paths and provider ids, never a value. The notice is read when the tab opens, so an entry that
 * the person removed is gone the next time.
 */
export function PersonalVendorMcpNotice() {
  const { t, format } = useText();
  const [notice, setNotice] = createSignal<Notice>(NONE);
  onSettled(() => {
    // A build or a host that does not answer has nothing to show; the notice stays hidden.
    Promise.resolve()
      .then(() => settingsPort().getPersonalVendorMcp())
      .then(setNotice)
      .catch(() => setNotice(NONE));
  });
  const providerNames = () =>
    notice().uncovered.map((provider) =>
      provider === "acp" ? t("settings.vendorMcp.customAgents") : agentProviderName(provider),
    );
  return (
    <Show when={notice().files.length > 0}>
      <Alert tone="warning" report={{ operation: "settings", source: "system", cause_code: "unknown" }}>
        <AlertIcon>
          <TriangleAlert aria-hidden="true" />
        </AlertIcon>
        <AlertContent>
          <AlertTitle>{t("settings.vendorMcp.title")}</AlertTitle>
          <AlertDescription>{t("settings.vendorMcp.description")}</AlertDescription>
          <For each={notice().files}>{(file) => <AlertDescription>{file.path}</AlertDescription>}</For>
          <AlertDescription>{t("settings.vendorMcp.action")}</AlertDescription>
          <Show when={providerNames().length > 0}>
            <AlertDescription>
              {t("settings.vendorMcp.uncovered", { providers: format.list(providerNames()) })}
            </AlertDescription>
          </Show>
        </AlertContent>
      </Alert>
    </Show>
  );
}
