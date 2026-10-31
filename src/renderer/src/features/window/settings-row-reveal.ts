import { flush } from "solid-js";
import type { ServerSettingsSection } from "../servers/server-settings-sections";

/**
 * How long a search result waits for its row. A tab that reads its state when it opens, such as
 * Voice or the General section of a server, shows the row a moment after the tab.
 */
const ROW_WAIT_MS = 2000;

/** What a reveal did: it showed the row, the row did not show in time, or a newer result replaced it. */
export type SettingsRowRevealResult = "shown" | "hidden" | "replaced";

/** Stops the reveal that waits for its row now. A newer result replaces it. */
let stopWaiting: (() => void) | undefined;

/** Stops a reveal that still waits, and removes the mark of the last search result. */
export function clearSettingsRowMark(): void {
  stopWaiting?.();
  for (const marked of document.querySelectorAll("[data-search-match]")) marked.removeAttribute("data-search-match");
}

function showRow(anchor: Element): "shown" | "hidden" {
  // A switch row puts the anchor on its switch, so the search marks the whole row of the card.
  const target = anchor.closest(".settings-modal-card > *") ?? anchor;
  if (!(target instanceof HTMLElement)) return "hidden";
  target.setAttribute("data-search-match", "");
  target.scrollIntoView({ block: "center" });
  target.querySelector<HTMLElement>("button, input, select, [tabindex]")?.focus({ preventScroll: true });
  return "shown";
}

/**
 * Waits for the row of the `panel` tab whose `data-settings-row` is `anchor`, then marks it, scrolls
 * it to the middle and puts the focus on its control. The settings page can open again for the
 * result, so this reads the document and not one page. It gives "hidden" when the row does not
 * show in time, because the current state hides it, and "replaced" when a newer result starts first:
 * only the newest result marks a row or tells the user that its row does not show.
 */
export function revealSettingsRow(panel: string, anchor: string): Promise<SettingsRowRevealResult> {
  clearSettingsRowMark();
  const selector = `.settings-modal-tab-panel[data-tab="${panel}"] [data-settings-row="${anchor}"]`;
  const present = document.querySelector(selector);
  if (present) return Promise.resolve(showRow(present));
  return new Promise((resolve) => {
    let timer = 0;
    const observer = new MutationObserver(() => {
      const row = document.querySelector(selector);
      if (row) finish(showRow(row));
    });
    function finish(result: SettingsRowRevealResult): void {
      observer.disconnect();
      window.clearTimeout(timer);
      if (stopWaiting === stop) stopWaiting = undefined;
      resolve(result);
    }
    function stop(): void {
      finish("replaced");
    }
    observer.observe(document.body, { childList: true, subtree: true });
    timer = window.setTimeout(() => finish("hidden"), ROW_WAIT_MS);
    stopWaiting = stop;
  });
}

/** The calls of the server settings that `openServerSettingsSection` makes, on desktop and on the web. */
export interface ServerSettingsSectionOpener {
  serverSettingsSection: () => ServerSettingsSection | null;
  clearServerSettingsSection: () => void;
  openServerSettings: (serverId: string, trigger: HTMLElement | null, section: ServerSettingsSection | null) => void;
}

/**
 * Opens a section of the settings of a server. The dialog applies a section when the requested
 * section changes, so a request for the section that is already requested is cleared first: the
 * section opens again after the user went to another one. The settings open once, so they read the
 * server once.
 */
export function openServerSettingsSection(
  serverSettings: ServerSettingsSectionOpener,
  serverId: string,
  trigger: HTMLElement | null,
  section: ServerSettingsSection,
): void {
  if (serverSettings.serverSettingsSection() === section) {
    serverSettings.clearServerSettingsSection();
    flush();
  }
  serverSettings.openServerSettings(serverId, trigger, section);
}
