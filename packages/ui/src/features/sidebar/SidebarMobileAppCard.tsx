import { Button, IconButton, Smartphone, X } from "@openbot/ui";
import { useText } from "../../text";

/**
 * The announcement of the web app for phones at the bottom of the sidebar. "How to install" opens
 * Mobile Connect, where Add phone shows the steps that add the web app to the Home Screen of an
 * iPhone or an Android phone, then how to sign in. It offers no phone app from a store.
 */
export function SidebarMobileAppCard(props: { onOpenInstall: () => void; onDismiss: () => void }) {
  const { t } = useText();
  return (
    <section class="sidebar-mobile-app" aria-labelledby="sidebar-mobile-app-title">
      <div class="sidebar-mobile-app-header">
        <Smartphone class="sidebar-mobile-app-icon" aria-hidden="true" />
        <strong id="sidebar-mobile-app-title">{t("sidebar.mobileApp.title")}</strong>
        <IconButton
          class="sidebar-mobile-app-dismiss"
          size="icon-xs"
          variant="ghost"
          label={t("sidebar.mobileApp.dismiss")}
          data-cuelume-tap="close"
          onClick={() => props.onDismiss()}
        >
          <X aria-hidden="true" />
        </IconButton>
      </div>
      <p class="sidebar-mobile-app-body">{t("sidebar.mobileApp.webAppBody")}</p>
      <Button type="button" variant="secondary" size="sm" fullWidth onClick={() => props.onOpenInstall()}>
        {t("sidebar.mobileApp.howToInstall")}
      </Button>
    </section>
  );
}
