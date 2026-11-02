/**
 * The app's pairing card for the person's Chrome (DESIGN §3.1, step 5), as a native dialog: the words
 * that the person taps in Chrome, and three options for the words that Chrome shows, with the right
 * one at a random place. Nothing is typed, and "Not now" refuses. The service closes the dialog when
 * the pairing ends another way (`signal`).
 */

import type { AppTranslate } from "@openbot/i18n";
import { BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import type { PairingRequest } from "./host-connection";

export async function askChromePairing(
  translate: AppTranslate,
  request: PairingRequest,
  signal: AbortSignal,
): Promise<number | null> {
  const options = request.options.map((words) => words.join(" · "));
  const notNow = options.length;
  const box: MessageBoxOptions = {
    type: "question",
    message: translate(
      request.reason === "window" ? "dialog.chromePairing.message" : "dialog.chromePairing.messageUnexpected",
    ),
    detail: translate("dialog.chromePairing.detail", {
      appWords: request.appCode.join(" · "),
      // Reported by the extension, not proven: the words are the proof.
      browser: `${request.browser.brand} ${request.browser.version}`,
    }),
    buttons: [...options, translate("dialog.chromePairing.notNow")],
    cancelId: notNow,
    defaultId: notNow,
    noLink: true,
    signal,
  };
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const { response } = window ? await dialog.showMessageBox(window, box) : await dialog.showMessageBox(box);
  return response === notNow || signal.aborted ? null : response;
}
