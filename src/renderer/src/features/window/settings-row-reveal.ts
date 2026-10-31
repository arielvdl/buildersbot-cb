import { flush } from "solid-js";
import type { useServerSettings } from "../servers/server-settings";
import type { ServerSettingsSection } from "../servers/server-settings-sections";

/**
 * How long a search result waits for its row. A tab that reads its state when it opens, such as
 * Voice or the General section of a server, shows the row a moment after the tab.
 */
const ROW_WAIT_MS = 2000;

/** Removes the mark of the last search result. */
export function clearSettingsRowMark(): void {
  for (const marked of document.querySelectorAll("[data-search-match]")) marked.removeAttribute("data-search-match");
}

function showRow(anchor: Element): boolean {
  // A switch row puts the anchor on its switch, so the search marks the whole row of the card.
  const target = anchor.closest(".settings-modal-card > *") ?? anchor;
  if (!(target instanceof HTMLElement)) return false;
  target.setAttribute("data-search-match", "");
  target.scrollIntoView({ block: "center" });
  target.querySelector<HTMLElement>("button, input, select, [tabindex]")?.focus({ preventScroll: true });
  return true;
}

/**
 * Waits for the row of the `panel` tab whose `data-settings-row` is `anchor`, then marks it, scrolls
 * it to the middle and puts the focus on its control. The settings page can open again for the
 * result, so this reads the document and not one page. It resolves false when the row does not
 * show in time, because the current state hides it.
 */
export function revealSettingsRow(panel: string, anchor: string): Promise<boolean> {
  clearSettingsRowMark();
  const selector = `.settings-modal-tab-panel[data-tab="${panel}"] [data-settings-row="${anchor}"]`;
  const present = document.querySelector(selector);
  if (present) return Promise.resolve(showRow(present));
  return new Promise((resolve) => {
    let timer = 0;
    const observer = new MutationObserver(() => {
      const row = document.querySelector(selector);
      if (!row) return;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(showRow(row));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    timer = window.setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, ROW_WAIT_MS);
  });
}

/** The calls of the server settings that `openServerSettingsSection` makes. */
type ServerSettingsOpener = Pick<
  ReturnType<typeof useServerSettings>,
  "serverSettingsOpen" | "serverSettingsTarget" | "serverSettingsSection" | "openServerSettings"
>;

/**
 * Opens a section of the settings of a server. The dialog applies a section when the requested
 * section changes, so a request for the section that is already requested is cleared first: the
 * section opens again after the user went to another one.
 */
export function openServerSettingsSection(
  serverSettings: ServerSettingsOpener,
  serverId: string,
  trigger: HTMLElement | null,
  section: ServerSettingsSection,
): void {
  if (
    serverSettings.serverSettingsOpen() &&
    serverSettings.serverSettingsTarget()?.id === serverId &&
    serverSettings.serverSettingsSection() === section
  ) {
    serverSettings.openServerSettings(serverId, trigger, null);
    flush();
  }
  serverSettings.openServerSettings(serverId, trigger, section);
}
