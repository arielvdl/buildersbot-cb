import { AppLogo, type MobilePlatformLogoVariant, PlatformLogo } from "@openbot/brand";
import { mobileWebAppAddress } from "@openbot/contracts/mobile-connect";
import {
  ArrowLeft,
  ArrowRight,
  Button,
  Check,
  CircleCheck,
  CopyButton,
  Dialog,
  Eye,
  EyeOff,
  Globe2,
  IconButton,
  Link2,
  Lock,
  LogIn,
  QrCode,
  ShieldCheck,
  SlidingTabs,
  Text,
  X,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { useText } from "../../text";
import { MOBILE_WEB_APP_PLATFORMS } from "../mobile-app/mobile-web-app";
import type { SettingsMobileConnectStore } from "./stores/mobile-connect-store";

type Store = SettingsMobileConnectStore;

const QR_SIZE = 176;
/** How long a dialog shows the phone that connected before it closes. */
const CONNECTED_CLOSE_MS = 1_400;
/** The permanent code hides itself after this, so it does not stay on the screen. */
const LINK_VISIBLE_SECONDS = 60;

function countdown(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The tag under each code: what the code does, in words and with an icon. */
function QrTag(props: { kind: "web" | "permanent" | "success" | "idle"; children: JSX.Element }) {
  return (
    <span class="settings-mobile-qr-tag" data-kind={props.kind}>
      <Switch>
        <Match when={props.kind === "web"}>
          <Globe2 aria-hidden="true" />
        </Match>
        <Match when={props.kind === "permanent"}>
          <Lock aria-hidden="true" />
        </Match>
        <Match when={props.kind === "success"}>
          <Check aria-hidden="true" />
        </Match>
      </Switch>
      {props.children}
    </span>
  );
}

/** A code, the success mark over it when a phone connected, and its tag. */
function CodeStage(props: { value: string; label: string; connected: boolean; tag: JSX.Element }) {
  return (
    <div class="settings-mobile-qr">
      <div class="settings-mobile-connect-qr-stage" data-success={props.connected ? "" : undefined}>
        <QrCode class="settings-mobile-qr-code" value={props.value} size={QR_SIZE} label={props.label}>
          <AppLogo variant="production" class="settings-mobile-app-qr-logo" />
        </QrCode>
        <Show when={props.connected}>
          <div class="settings-mobile-connect-success-mark" aria-hidden="true">
            <CircleCheck />
          </div>
        </Show>
      </div>
      {props.tag}
    </div>
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

/** Captures the phone that connected, and closes the dialog a moment later. */
function createConnectedClose(source: () => { name: string; value: string } | null, close: () => void) {
  const [connected, setConnected] = createSignal<{ name: string; value: string } | null>(null);
  createEffect(source, (found) => {
    if (found) setConnected(found);
  });
  createEffect(connected, (found) => {
    if (!found) return;
    const timer = window.setTimeout(close, CONNECTED_CLOSE_MS);
    return () => window.clearTimeout(timer);
  });
  return [connected, setConnected] as const;
}

type AddScreen = "ask" | "install" | "signin";

/**
 * Adds a phone in steps. A phone uses the web app: the QR code opens its address in the browser of
 * the phone, the steps add it to the Home Screen, and the person signs in there with the email of
 * this account. No step offers a phone app from a store.
 */
export function MobileConnectAddPhoneDialog(props: {
  open: boolean;
  store: Store;
  /** The email of this account, which the phone signs in with. */
  accountEmail: string;
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
                        {t("settings.mobileConnect.add.signIn.emailHint")}
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
                  <li>{t("settings.mobileConnect.webApp.signIn.email", { email: props.accountEmail })}</li>
                  <li>{t("settings.mobileConnect.webApp.signIn.code")}</li>
                </ol>
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
          <QrTag kind="web">{t("settings.mobileConnect.qr.webApp", { address: mobileWebAppAddress(url()) })}</QrTag>
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

/**
 * The permanent link: what it is and a way to make one, or its code with a warning. The code shows
 * when the dialog opens, and hides when the dialog closes or after a minute.
 */
export function MobileConnectLinkDialog(props: { open: boolean; store: Store; onClose: () => void }) {
  const { t } = useText();
  const link = () => props.store.state.link;
  const hide = () => {
    if (link().revealed) props.store.toggleLinkRevealed();
  };
  const close = () => {
    hide();
    setConnected(null);
    props.onClose();
  };
  const [connected, setConnected] = createConnectedClose(() => {
    const name = link().successDeviceName;
    const url = link().link?.url;
    return props.open && name && url ? { name, value: url } : null;
  }, close);
  createEffect(
    () => props.open && Boolean(link().link),
    (show) => {
      if (show && !link().revealed) props.store.toggleLinkRevealed();
    },
  );

  return (
    <DialogFrame open={props.open} title={t("settings.mobileConnect.link.title")} onClose={close}>
      <div class="settings-mobile-dialog-body">
        <Show
          when={link().link}
          fallback={
            <div class="settings-mobile-link-intro">
              <span class="settings-mobile-phones-empty-icon" aria-hidden="true">
                <Link2 />
              </span>
              <Text variant="body-sm" class="settings-mobile-phone-name">
                {t("settings.mobileConnect.link.intro.title")}
              </Text>
              <Text variant="caption" tone="muted">
                {t("settings.mobileConnect.link.intro.description")}
              </Text>
              <Button
                type="button"
                size="sm"
                loading={link().busy === "create"}
                loadingLabel={t("settings.mobileConnect.generating")}
                disabled={!link().loaded || link().busy !== null}
                onClick={() => void props.store.createLink()}
              >
                {t("settings.mobileConnect.link.create")}
              </Button>
            </div>
          }
        >
          {(current) => (
            <Show
              when={connected() || link().revealed}
              fallback={
                <CodeSlot>
                  <Text variant="caption" tone="muted">
                    {t("settings.mobileConnect.link.hidden")}
                  </Text>
                  <Button type="button" size="xs" variant="outline" onClick={() => props.store.toggleLinkRevealed()}>
                    <Eye aria-hidden="true" />
                    {t("settings.mobileConnect.link.showCode")}
                  </Button>
                </CodeSlot>
              }
            >
              <LinkCode url={current().url} connectedName={connected()?.name ?? null} onHide={hide} />
            </Show>
          )}
        </Show>
        <Show when={link().error}>
          {(error) => (
            <Text class="settings-modal-error" variant="caption" role="alert">
              {error()}
            </Text>
          )}
        </Show>
      </div>
    </DialogFrame>
  );
}

/** The permanent code with its warning. It counts down from its first render and hides at zero. */
function LinkCode(props: { url: string; connectedName: string | null; onHide: () => void }) {
  const { t } = useText();
  const shownAt = Date.now();
  const [left, setLeft] = createSignal(LINK_VISIBLE_SECONDS);
  const timer = window.setInterval(() => {
    const next = Math.max(0, LINK_VISIBLE_SECONDS - Math.floor((Date.now() - shownAt) / 1_000));
    setLeft(next);
    if (next === 0) props.onHide();
  }, 1_000);
  onCleanup(() => window.clearInterval(timer));
  return (
    <div class="settings-mobile-link-code settings-mobile-enter" aria-live="polite">
      <CodeStage
        value={props.url}
        label={t("settings.mobileConnect.link.qrLabel")}
        connected={Boolean(props.connectedName)}
        tag={
          <Show
            when={props.connectedName}
            fallback={
              <QrTag kind="permanent">
                {t("settings.mobileConnect.qr.permanent")}
                <span class="settings-mobile-qr-tag-time">{countdown(left())}</span>
              </QrTag>
            }
          >
            {(name) => (
              <span role="status">
                <QrTag kind="success">{t("settings.mobileConnect.qr.connected", { name: name() })}</QrTag>
              </span>
            )}
          </Show>
        }
      />
      <span class="settings-mobile-link-warning">
        <ShieldCheck aria-hidden="true" />
        <Text variant="body-sm" class="settings-mobile-link-warning-title">
          {t("settings.mobileConnect.link.private.title")}
        </Text>
      </span>
      <Text variant="caption" tone="muted">
        {t("settings.mobileConnect.link.private.description", { time: countdown(left()) })}
      </Text>
      <div class="settings-mobile-dialog-actions">
        <CopyButton
          variant="outline"
          size="sm"
          value={props.url}
          label={t("settings.mobileConnect.app.copyLink")}
          copiedLabel={t("settings.mobileConnect.app.linkCopied")}
        />
        <Button type="button" size="sm" variant="ghost" onClick={() => props.onHide()}>
          <EyeOff aria-hidden="true" />
          {t("settings.mobileConnect.link.hideCode")}
        </Button>
      </div>
    </div>
  );
}
