import { isKeyOnlyProvider } from "@openbot/contracts/agent-providers";
import type { AgentProviderId } from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createMemo } from "solid-js";
import type { SetupProviders } from "./SetupProviderPicker";

/**
 * The main button of a provider step while the selected provider is not connected, as the first-run
 * flow and the server step both show it.
 */
export function createSetupNext(providers: SetupProviders) {
  const { t, sourceText } = useText();
  const selectedOption = () => providers.options().find((candidate) => candidate.id === providers.selectedProvider());

  /**
   * Why `Next` refuses, or an empty string when it does not.
   *
   * The sentence is the only account the screen gives. A first run whose providers are all still
   * being checked otherwise shows a list of rows and a dead button, which reads as a broken
   * application rather than as work left to do.
   */
  const blockedReason = createMemo(() => {
    if (providers.selectedProviderConnected()) return "";
    const option = selectedOption();
    if (!option) return t("onboarding.next.selectProvider");
    // A provider that this window cannot connect: its row line says why, and what to use instead.
    if (providers.unreachable().has(option.id) && option.message) return option.message;
    const provider = option.name;
    switch (option.runtimeStatus?.phase) {
      case "downloading":
        return t("onboarding.next.downloading", { provider });
      case "finishing":
        return t("onboarding.next.finishing", { provider });
      case "download-error": {
        // The reason is what a support report needs. A download that worked can still fail here,
        // when the new CLI does not start.
        const reason = option.runtimeStatus.message;
        return reason
          ? t("onboarding.next.downloadErrorReason", { provider, reason: sourceText(reason) })
          : t("onboarding.next.downloadError", { provider });
      }
      case "not-downloaded":
        return t("onboarding.next.notDownloaded", { provider });
      default:
        break;
    }
    if (option.connectionState === "connecting") return t("onboarding.next.connecting", { provider });
    return t("onboarding.next.connect", { provider });
  });

  /**
   * How the button connects `provider` now, or undefined when it cannot: the row's Connect, else the
   * OpenCode key. A browser sign-in reports in a toast; a dialog sign-in, such as a host's, is its
   * own feedback. A key-only provider, such as Inception, signs in only with a key, so it opens the
   * key dialog.
   */
  function connectAction(provider: AgentProviderId): (() => void) | undefined {
    const source = providers.props;
    if (isKeyOnlyProvider(provider) && source.providerKeys) return () => providers.signInProvider(provider);
    const kind = source.connection?.connectKind(provider);
    if (kind === "browser") {
      return () => {
        toast.info(t("onboarding.toast.connecting", { provider: selectedOption()?.name ?? provider }));
        void providers.connectProvider(provider);
      };
    }
    if (kind === "dialog") return () => void providers.connectProvider(provider);
    if (provider === "opencode" && source.providerKeys) return () => providers.signInProvider(provider);
    return undefined;
  }

  /**
   * It stays pressable: a disabled `Next` beside rows of "Ready" badges read as a broken screen
   * (issue #643). It connects the provider when a connection can start now, and else the toast says
   * what is missing.
   */
  function connectSelected(): void {
    const option = selectedOption();
    // This window cannot connect it, so the button gives the choice back to the step, which selects
    // Builders or a connected account. The row stays where the user saw it.
    if (option && providers.unreachable().has(option.id)) {
      providers.clearChoice();
      return;
    }
    const runtimePhase = option?.runtimeStatus?.phase ?? "ready";
    // The step the button asks for is the download, so the button starts it. The row shows progress.
    if (
      option &&
      (runtimePhase === "not-downloaded" || runtimePhase === "download-error") &&
      providers.props.onDownloadProvider
    ) {
      void providers.downloadProvider(option.id);
      return;
    }
    const connect =
      option &&
      !providers.props.refreshingProviders &&
      runtimePhase === "ready" &&
      option.connectionState !== "connecting"
        ? connectAction(option.id)
        : undefined;
    if (!connect) {
      toast.info(blockedReason());
      return;
    }
    connect();
  }

  /**
   * The label of the main button while the selected provider is not connected, the same on first
   * run and on a server: Download when the button starts the download, else Connect with the name of
   * the provider it connects. For a provider that this window cannot connect, the button promises no
   * connection: it chooses another provider.
   */
  function connectLabel(): string {
    const option = selectedOption();
    if (option && providers.unreachable().has(option.id)) return t("onboarding.action.useAnother");
    const phase = option?.runtimeStatus?.phase;
    if (phase === "not-downloaded" || phase === "download-error") return t("common.download");
    return option && !providers.customSelected()
      ? t("onboarding.action.connectProvider", { provider: option.name })
      : t("onboarding.action.connect");
  }

  return { blockedReason, connectSelected, connectLabel };
}
