// The desktop notification switch, the test notification Settings offers, and the sound center.

import {
  CUSTOM_SOUND_EXTENSIONS,
  decodeNativeSoundPreview,
  decodeSoundPlayReport,
  decodeSoundPreference,
  isCustomSoundId,
} from "@openbot/contracts/ipc";
import type { AppTranslate } from "@openbot/i18n";
import { sourceText } from "@openbot/i18n/source";
import { type BrowserWindow, dialog, Notification, type OpenDialogOptions } from "electron";
import { runCauseEffect } from "../../backend/effect-boundary";
import { notificationSettingsUrl, showRetainedNotification } from "../desktop-notifications";
import type { NotificationPreferenceStore } from "../notification-preference-store";
import { appNotification, playSystemAlertSound, previewNotification } from "../sound-port";
import type { SoundPreferenceStore } from "../sound-preference-store";
import { parseNotificationPreference } from "./app-inputs";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export interface NotificationIpcDependencies {
  notificationPreference: NotificationPreferenceStore;
  sounds: SoundPreferenceStore;
  /** The window that a file dialog belongs to. */
  getDialogParent: () => BrowserWindow | null;
  translate: AppTranslate;
  /** Asks the operating system for permission if Builders Bot has not asked yet. */
  requestPermission: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
}

function decodeCustomSoundId(value: unknown): string {
  if (!isCustomSoundId(value)) throw new Error("Invalid custom sound id.");
  return value;
}

export function notificationIpcHandlers({
  notificationPreference,
  sounds,
  getDialogParent,
  translate,
  requestPermission,
  openExternal,
}: NotificationIpcDependencies): Pick<IpcGroupHandlers, "notifications"> {
  return {
    notifications: {
      getPreference: handler(() => notificationPreference.get()),
      setPreference: payloadHandler(parseNotificationPreference, async (preference) => {
        const saved = await runCauseEffect(notificationPreference.set(preference));
        // A user who had the switch off at first start was never asked; turning it on asks now.
        await requestPermission();
        return saved;
      }),
      // Shown even when the window has focus and the switch is off: the user asked for this one, and
      // it is how they find out whether the operating system lets Builders Bot show notifications at all.
      test: handler(() => {
        if (!Notification.isSupported()) throw new Error(sourceText("error.app.notificationsUnsupported"));
        showRetainedNotification(
          appNotification("notification.system", { title: "Builders Bot", body: translate("notification.test") }),
        );
      }),
      openSettings: handler(async () => {
        const url = notificationSettingsUrl(process.platform);
        if (!url) throw new Error(sourceText("error.app.notificationSettingsMissing"));
        await openExternal(url);
      }),
      getSounds: handler(() => sounds.state()),
      setSounds: payloadHandler(decodeSoundPreference, (preference) => runCauseEffect(sounds.set(preference))),
      reportSound: payloadHandler(decodeSoundPlayReport, (report) => sounds.report(report)),
      addCustomSound: handler(async () => {
        const parent = getDialogParent();
        const options: OpenDialogOptions = {
          title: translate("dialog.chooseSound"),
          properties: ["openFile"],
          filters: [{ name: translate("dialog.filter.soundFiles"), extensions: [...CUSTOM_SOUND_EXTENSIONS, "aif"] }],
        };
        const result =
          parent && !parent.isDestroyed()
            ? await dialog.showOpenDialog(parent, options)
            : await dialog.showOpenDialog(options);
        const path = result.canceled ? undefined : result.filePaths[0];
        if (!path) return null;
        return runCauseEffect(sounds.addCustomSound(path));
      }),
      readCustomSound: payloadHandler(decodeCustomSoundId, (id) => runCauseEffect(sounds.readCustomSound(id))),
      playSystemSound: handler(() => playSystemAlertSound()),
      previewNativeSound: payloadHandler(decodeNativeSoundPreview, ({ sound }) => {
        if (!Notification.isSupported()) throw new Error(sourceText("error.app.notificationsUnsupported"));
        showRetainedNotification(
          previewNotification({ title: "Builders Bot", body: translate("notification.soundPreview") }, sound),
        );
      }),
    },
  };
}
