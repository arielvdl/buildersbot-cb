import { AppLogo, type MobilePlatformLogoVariant, PlatformLogo } from "@openbot/brand";
import { mobileWebAppAddress } from "@openbot/contracts/mobile-connect";
import {
  ArrowLeft,
  ArrowRight,
  Button,
  CopyButton,
  Dialog,
  Globe2,
  IconButton,
  LogIn,
  QrCode,
  SlidingTabs,
  Text,
  X,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { useText } from "../../text";
import { MOBILE_WEB_APP_PLATFORMS } from "../mobile-app/mobile-web-app";
import { type MobileConnectReach, MobileConnectReachNotice } from "./MobileConnectReach";
import type { SettingsMobileConnectStore } from "./stores/mobile-connect-store";

type Store = SettingsMobileConnectStore;

const QR_SIZE = 176;

/** The tag under the code: what the code opens, in words and with an icon. */
function QrTag(props: { children: JSX.Element }) {
  return (
    <span class="settings-mobile-qr-tag" data-kind="web">
      <Globe2 aria-hidden="true" />
      {props.children}
    </span>
  );
}

/** Where a code appears when there is none. The same size as the code, so nothing moves. */
function CodeSlot(props: { children: JSX.Element }) {
  return (
    <div class="settings-mobile-qr">
      <div class="settings-mobile-qr-slot" style={{ width: `${QR_SIZE}px`, height: `${QR_SIZE}px` }}>
        {props.children}
      </div>
    </div>
  );
}

function DialogFrame(props: { open: boolean; title: string; onClose: () => void; children: JSX.Element }) {
  const { t } = useText();
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="ui-confirm-dialog-overlay">
          <Dialog.Content as="section" class="ui-dialog-content settings-mobile-dialog">
            <header class="settings-mobile-dialog-header">
              <Dialog.Title as="h2" class="settings-mobile-dialog-title">
                {props.title}
              </Dialog.Title>
              <IconButton label={t("common.close")} variant="ghost" onClick={() => props.onClose()}>
                <X />
              </IconButton>
            </header>
            {props.children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type AddScreen = "ask" | "install" | "signin";

/**
 * Adds a phone in steps. A phone uses the web app: the QR code opens its address in the browser of
 * the phone, the steps add it to the Home Screen, and the person signs in there with Cultura Builder.
 * The code carries only the address, never a sign-in secret. No step offers a phone app from a store.
 * The sign-in step also tells whether the phone can reach this computer, because the web app lists
 * only published servers.
 */
export function MobileConnectAddPhoneDialog(props: {
  open: boolean;
  store: Store;
  /** The email of this account. The phone signs in with the Cultura Builder account of this email. */
  accountEmail: string;
  /** Whether a phone can reach the server of this computer. Null when this computer has no server. */
  reach?: MobileConnectReach | null | undefined;
  onPublishComputer?: (() => Promise<void>) | undefined;
  onClose: () => void;
}) {
  const { t } = useText();
  const [screen, setScreen] = createSignal<AddScreen>("ask");
  const [platform, setPlatform] = createSignal<MobilePlatformLogoVariant>("ios");
  const close = () => {
    setScreen("ask");
    props.onClose();
  };
  const toSignIn = () => setScreen("signin");
  const back = () => setScreen("ask");
  const phone = () =>
    MOBILE_WEB_APP_PLATFORMS.find((candidate) => candidate.platform === platform()) ?? MOBILE_WEB_APP_PLATFORMS[0];
  const title = () => {
    if (screen() === "install") return t("settings.mobileConnect.add.webApp.heading");
    if (screen() === "signin") return t("settings.mobileConnect.signIn.title");
    return t("settings.mobileConnect.add.title");
  };

  return (
    <DialogFrame open={props.open} title={title()} onClose={close}>
      <Show when={screen()} keyed>
        {(current) => (
          <div class="settings-mobile-dialog-body settings-mobile-enter">
            <Switch>
              <Match when={current === "ask"}>
                <Text variant="body-sm" tone="secondary">
                  {t("settings.mobileConnect.add.webApp.question")}
                </Text>
                <div class="settings-mobile-choices">
                  <Button type="button" variant="outline" class="settings-mobile-choice" onClick={toSignIn}>
                    <LogIn aria-hidden="true" />
                    <span class="settings-mobile-choice-text">
                      <span class="settings-mobile-choice-title">{t("settings.mobileConnect.add.signIn.title")}</span>
                      <span class="settings-mobile-choice-hint">
                        {t("settings.mobileConnect.add.signIn.culturaHint")}
                      </span>
                    </span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    class="settings-mobile-choice"
                    onClick={() => setScreen("install")}
                  >
                    <Globe2 aria-hidden="true" />
                    <span class="settings-mobile-choice-text">
                      <span class="settings-mobile-choice-title">{t("settings.mobileConnect.add.webApp.title")}</span>
                      <span class="settings-mobile-choice-hint">{t("settings.mobileConnect.add.install.hint")}</span>
                    </span>
                  </Button>
                </div>
              </Match>
              <Match when={current === "install"}>
                <SlidingTabs.Root
                  value={platform()}
                  onChange={(value) => {
                    if (value === "ios" || value === "android") setPlatform(value);
                  }}
                >
                  <SlidingTabs.List aria-label={t("settings.mobileConnect.install.platformLabel")}>
                    <For each={MOBILE_WEB_APP_PLATFORMS}>
                      {(candidate) => (
                        <SlidingTabs.Trigger class="settings-mobile-app-tab" value={candidate.platform}>
                          <PlatformLogo platform={candidate.platform} />
                          {candidate.label}
                        </SlidingTabs.Trigger>
                      )}
                    </For>
                  </SlidingTabs.List>
                </SlidingTabs.Root>
                <WebAppCode store={props.store} />
                <Show when={phone()} keyed>
                  {(current) => (
                    <ol class="settings-mobile-steps">
                      <For each={current.steps}>{(step) => <li>{t(step)}</li>}</For>
                    </ol>
                  )}
                </Show>
                <Text variant="caption" tone="muted" class="settings-mobile-dialog-note">
                  {t("settings.mobileConnect.webApp.note")}
                </Text>
              </Match>
              <Match when={current === "signin"}>
                <ol class="settings-mobile-steps">
                  <li>{t("settings.mobileConnect.webApp.signIn.open")}</li>
                  <li>{t("settings.mobileConnect.webApp.signIn.cultura", { email: props.accountEmail })}</li>
                  <li>{t("settings.mobileConnect.webApp.signIn.hub")}</li>
                </ol>
                <Show when={props.reach}>
                  {(reach) => <MobileConnectReachNotice reach={reach()} onPublish={props.onPublishComputer} />}
                </Show>
              </Match>
            </Switch>
          </div>
        )}
      </Show>
      <Show when={screen() !== "ask"}>
        <footer class="settings-mobile-dialog-footer">
          <Button type="button" variant="ghost" onClick={back}>
            <ArrowLeft aria-hidden="true" />
            {t("common.back")}
          </Button>
          <Switch>
            <Match when={screen() === "install"}>
              <Button type="button" onClick={toSignIn}>
                {t("settings.mobileConnect.add.continue")}
                <ArrowRight aria-hidden="true" />
              </Button>
            </Match>
            <Match when={screen() === "signin"}>
              <Button type="button" onClick={close}>
                {t("common.done")}
              </Button>
            </Match>
          </Switch>
        </footer>
      </Show>
    </DialogFrame>
  );
}

/**
 * The QR code of the web app address, made on this computer. The address comes from main, which
 * checked it; the same check runs again in the preload. A missing address shows why, not a code.
 */
function WebAppCode(props: { store: Store }) {
  const { t } = useText();
  const webApp = () => props.store.state.webApp;
  return (
    <Show
      when={webApp().url}
      fallback={
        <CodeSlot>
          <Text variant="caption" tone="muted" role={webApp().error ? "alert" : "status"}>
            {webApp().error ?? t("common.loading")}
          </Text>
        </CodeSlot>
      }
    >
      {(url) => (
        <div class="settings-mobile-qr">
          <QrCode
            class="settings-mobile-qr-code"
            value={url()}
            size={QR_SIZE}
            label={t("settings.mobileConnect.webApp.qrLabel")}
          >
            <AppLogo variant="production" class="settings-mobile-app-qr-logo" />
          </QrCode>
          <QrTag>{t("settings.mobileConnect.qr.webApp", { address: mobileWebAppAddress(url()) })}</QrTag>
          <CopyButton
            variant="ghost"
            size="xs"
            value={url()}
            label={t("settings.mobileConnect.app.copyLink")}
            copiedLabel={t("settings.mobileConnect.app.linkCopied")}
          />
        </div>
      )}
    </Show>
  );
}
