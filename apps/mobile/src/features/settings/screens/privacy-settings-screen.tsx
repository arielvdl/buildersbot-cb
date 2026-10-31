import { Typography } from "heroui-native";
import { SettingsContent, SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { useText } from "@/shared/lib/text";

/**
 * The app sends no product analytics and no error reports (phase 0 of
 * `.openbot-build/bug-reports/DESIGN.md`), so the screen shows a note, not a switch. The saved
 * answer stays in the keychain and on the account, and no value starts a send.
 */
export function PrivacySettingsScreen() {
  const { t } = useText();
  return (
    <SettingsContent>
      <SettingsSection>
        <SettingsRow supportingText={t("mobile.settings.privacy.analyticsDescription")}>
          <Typography.Paragraph>{t("mobile.settings.privacy.analyticsTitle")}</Typography.Paragraph>
        </SettingsRow>
      </SettingsSection>
    </SettingsContent>
  );
}
