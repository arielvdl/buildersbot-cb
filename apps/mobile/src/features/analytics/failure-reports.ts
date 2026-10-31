import type { FailureProperties } from "@openbot/telemetry";
import { errorReference } from "@openbot/user-errors";
import { Alert, type AlertButton } from "react-native";
import { currentText } from "@/shared/lib/text";

/**
 * A failure that the app shows. It sends nothing: the upstream OpenBot app sent failure reports to an
 * analytics service of the upstream project, which Builders Bot does not control (phase 0 of
 * `.openbot-build/bug-reports/DESIGN.md`). The signature stays, so the callers do not change.
 */
export function reportMobileNotification(
  _error: unknown,
  _operation: FailureProperties["operation"],
  _presentation: "alert" | "banner" = "banner",
  _context: Partial<Pick<FailureProperties, "source" | "severity" | "provider" | "model">> = {},
): void {
  // No sink: see the comment above.
}

/**
 * Classify the original failure before the native alert receives its display text. When the failure
 * has a code, the alert shows the code under the message and adds a button that copies it.
 */
export function showFailureAlert(
  error: unknown,
  operation: FailureProperties["operation"],
  ...args: Parameters<typeof Alert.alert>
): void {
  reportMobileNotification(error, operation, "alert");
  const reference = errorReference(error);
  if (!reference) {
    Alert.alert(...args);
    return;
  }
  const [title, message, buttons, options] = args;
  const { t } = currentText();
  const code = t("error.reference.label", { code: reference });
  // An alert with a button list shows only those buttons, so a plain alert keeps a close button.
  const kept: AlertButton[] = buttons?.length ? buttons : [{ text: t("common.close"), style: "cancel" }];
  // Android shows at most three buttons. The code stays in the message when no button is free.
  const copy: AlertButton[] =
    kept.length < 3
      ? [
          {
            text: t("error.reference.copy"),
            // The code is also in the message, so a failed copy needs no second alert.
            onPress: () =>
              void import("expo-clipboard").then((clipboard) => clipboard.setStringAsync(reference)).catch(() => false),
          },
        ]
      : [];
  Alert.alert(title, message ? `${message}\n\n${code}` : code, [...kept, ...copy], options);
}

export function showWarningAlert(
  operation: FailureProperties["operation"],
  ...args: Parameters<typeof Alert.alert>
): void {
  reportMobileNotification(undefined, operation, "alert", { severity: "warning", source: "system" });
  Alert.alert(...args);
}
