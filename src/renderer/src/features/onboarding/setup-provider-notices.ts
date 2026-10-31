import { isKeyOnlyProvider } from "@openbot/contracts/agent-providers";
import type { ProviderPickerOption } from "@openbot/ui/components/ProviderPicker";

/**
 * What the install suggestion of Builders shows, or null while Builders needs nothing.
 *
 * - `install`: Builders is not on the computer that runs the providers, and the step can download it.
 * - `installing` and `finishing`: the download runs; the suggestion shows its progress.
 * - `retry`: the download or its first start failed; the suggestion says why and offers it again.
 */
export type FreeInstallStep = "install" | "installing" | "finishing" | "retry";

/**
 * The install suggestion for `free`, the Builders row of the step. Without a download handler there
 * is no button that could install it, so the step suggests nothing.
 */
export function freeInstallStep(free: ProviderPickerOption | undefined, canDownload: boolean): FreeInstallStep | null {
  switch (free?.runtimeStatus?.phase) {
    case "not-downloaded":
      return canDownload ? "install" : null;
    case "downloading":
      return "installing";
    case "finishing":
      return "finishing";
    case "download-error":
      return canDownload ? "retry" : null;
    default:
      return null;
  }
}

/**
 * The key providers among the rows that wait for a newer Pi. They run in the Pi CLI, so a Pi that is
 * too old makes each of them report the same long message. The step shows one notice for all of them.
 */
export function piWaiters(listed: readonly ProviderPickerOption[]): ProviderPickerOption[] {
  return listed.filter((option) => isKeyOnlyProvider(option.id) && option.state === "outdated");
}

/**
 * The one action of the Pi notice: the download that the Pi row offers, the update of a Pi that is
 * on the computer, or the progress of a download that runs. Null when no handler can do it, so the
 * notice has no button that does nothing.
 */
export type PiNoticeAction = "download" | "update" | "progress";

export function piNoticeAction(
  pi: ProviderPickerOption | undefined,
  handlers: { download: boolean; update: boolean },
): PiNoticeAction | null {
  const phase = pi?.runtimeStatus?.phase;
  if (phase === "downloading" || phase === "finishing") return "progress";
  if ((phase === "not-downloaded" || phase === "download-error") && handlers.download) return "download";
  if (phase === "ready" && handlers.update) return "update";
  return null;
}
