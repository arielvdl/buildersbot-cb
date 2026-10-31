import { PlatformLogo } from "@openbot/brand";
import type { MobileConnectedDevice } from "@openbot/contracts/ipc";
import {
  Button,
  buttonVariants,
  ChevronDown,
  Globe2,
  Link2,
  Lock,
  Plus,
  Popover,
  Scan,
  SettingsSection,
  Smartphone,
  Text,
} from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { MobileConnectAddPhoneDialog } from "./MobileConnectDialogs";
import { type MobileConnectReach, MobileConnectReachNotice } from "./MobileConnectReach";
import { RemoteNetworkRouteChoice } from "./RemoteNetworkRouteChoice";
import type { SettingsMobileConnectStore } from "./stores/mobile-connect-store";

export type { MobileConnectReach } from "./MobileConnectReach";

interface SettingsMobileConnectTabProps {
  store: SettingsMobileConnectStore;
  /** The email of this account. A phone signs in to the web app with the Cultura Builder account of this email. */
  accountEmail: string;
  /** Add phone shows the address of the web app, so it needs that address. */
  canAddPhone: boolean;
  canRevokeDevice: boolean;
  canSetRoute: boolean;
  /** Whether a phone can reach the server of this computer. Null when this computer has no server. */
  reach?: MobileConnectReach | null | undefined;
  /** Publishes the server of this computer, so that the web app on a phone lists it. */
  onPublishComputer?: (() => Promise<void>) | undefined;
}

const IOS_PLATFORM_LABEL = "iOS";
const ANDROID_PLATFORM_LABEL = "Android";

/**
 * The phones that use this account, as cards. "Add phone" opens a dialog that installs the web app on
 * the phone from its browser, then tells how to sign in there with Cultura Builder. How devices
 * connect is a chip in the header. No code or link here signs a phone in: the QR code is only the
 * address of the web app.
 */
export function SettingsMobileConnectTab(props: SettingsMobileConnectTabProps) {
  const { t } = useText();
  const [adding, setAdding] = createSignal(false);
  const devices = () => props.store.state.devices.devices;
  const addButton = () => (
    <Button
      type="button"
      size="sm"
      data-settings-row="settings.mobileConnect.phones.add"
      disabled={!props.canAddPhone}
      onClick={() => setAdding(true)}
    >
      <Plus aria-hidden="true" />
      {t("settings.mobileConnect.phones.add")}
    </Button>
  );
  return (
    <SettingsSection
      title={t("settings.mobileConnect.phones.title")}
      description={t("settings.mobileConnect.phones.description")}
      actions={
        <>
          <Show when={props.store.state.devices.loading}>
            <Text as="span" variant="caption" tone="muted" role="status">
              {t("settings.mobileConnect.devices.refreshing")}
            </Text>
          </Show>
          <RouteChip store={props.store} disabled={!props.canSetRoute} />
          <Show when={devices().length > 0}>{addButton()}</Show>
        </>
      }
    >
      <Show when={props.reach}>
        {(reach) => <MobileConnectReachNotice reach={reach()} onPublish={props.onPublishComputer} />}
      </Show>
      <Show when={props.store.state.route.error}>
        {(error) => (
          <Text class="settings-modal-error" variant="caption" role="alert">
            {error()}
          </Text>
        )}
      </Show>
      <div class="settings-mobile-phones" data-settings-row="settings.mobileConnect.phones.title">
        <Show when={devices().length === 0}>
          <div class="settings-mobile-phones-empty">
            <span class="settings-mobile-phones-empty-icon" aria-hidden="true">
              <Smartphone />
            </span>
            <Text variant="body" class="settings-mobile-phones-empty-title">
              {t("settings.mobileConnect.phones.empty.title")}
            </Text>
            <Text variant="caption" tone="muted">
              {t("settings.mobileConnect.phones.empty.description")}
            </Text>
            {addButton()}
          </div>
        </Show>
        <For each={devices()}>
          {(device) => <PhoneCard store={props.store} device={device} canRevoke={props.canRevokeDevice} />}
        </For>
      </div>
      <Show when={props.store.state.devices.error}>
        {(error) => (
          <Text class="settings-modal-error" variant="caption" role="alert">
            {error()}
          </Text>
        )}
      </Show>
      <Show when={devices().length > 0}>
        <Text variant="caption" tone="muted">
          {t("settings.mobileConnect.disconnectInfo.description")}
        </Text>
      </Show>

      <MobileConnectAddPhoneDialog
        open={adding()}
        store={props.store}
        accountEmail={props.accountEmail}
        reach={props.reach}
        onPublishComputer={props.onPublishComputer}
        onClose={() => setAdding(false)}
      />
    </SettingsSection>
  );
}

function PhoneCard(props: { store: SettingsMobileConnectStore; device: MobileConnectedDevice; canRevoke: boolean }) {
  const { t } = useText();
  const platformLabel = () => {
    if (props.device.platform === "ios") return IOS_PLATFORM_LABEL;
    if (props.device.platform === "android") return ANDROID_PLATFORM_LABEL;
    return t("settings.mobileConnect.platform.mobile");
  };
  return (
    <div class="settings-mobile-phone-card">
      <span class="settings-mobile-phone-icon">
        <Show
          when={props.device.platform !== "unknown" && props.device.platform}
          fallback={<Smartphone aria-hidden="true" />}
        >
          {(platform) => <PlatformLogo platform={platform()} />}
        </Show>
      </span>
      <div class="settings-mobile-phone-copy">
        <Text variant="body-sm" class="settings-mobile-phone-name">
          {props.device.name}
        </Text>
        <Text variant="caption" tone="muted">
          {platformLabel()} ·{" "}
          {t("settings.mobileConnect.devices.lastActive", {
            time: props.store.deviceTimeLabel(props.device.lastActiveAt),
          })}
        </Text>
        <span class="settings-mobile-phone-via">
          <Show when={props.device.via === "link"} fallback={<Scan aria-hidden="true" />}>
            <Link2 aria-hidden="true" />
          </Show>
          {props.device.via === "link"
            ? t("settings.mobileConnect.devices.via.link")
            : t("settings.mobileConnect.devices.via.code")}
        </span>
      </div>
      <Button
        type="button"
        variant="destructive-ghost"
        size="xs"
        loading={props.store.state.devices.revokingSessionId === props.device.sessionId}
        loadingLabel={t("settings.disconnect.pending")}
        disabled={!props.canRevoke}
        data-cuelume-tap="close"
        data-cuelume-emphasis="strong"
        aria-label={t("settings.mobileConnect.devices.disconnectLabel", { name: props.device.name })}
        onClick={() => void props.store.revokeDevice(props.device)}
      >
        {t("settings.disconnect.action")}
      </Button>
    </div>
  );
}

/** How devices connect: the current route as a chip, and both routes in a popover. */
function RouteChip(props: { store: SettingsMobileConnectStore; disabled: boolean }) {
  const { t } = useText();
  return (
    <Show when={props.store.state.route.current}>
      {(current) => {
        const title = () =>
          current().route === "private"
            ? t("settings.mobileConnect.route.private.title")
            : t("settings.mobileConnect.route.openbot.title");
        return (
          <Popover.Root placement="bottom-end" gutter={6}>
            <Popover.Trigger
              class={`${buttonVariants({ variant: "ghost", size: "sm" })} settings-mobile-route-chip`}
              aria-label={t("settings.mobileConnect.route.chipLabel", { route: title() })}
              data-settings-row="settings.mobileConnect.route.title"
            >
              <Show when={current().route === "private"} fallback={<Globe2 aria-hidden="true" />}>
                <Lock aria-hidden="true" />
              </Show>
              {title()}
              <ChevronDown aria-hidden="true" />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content class="ui-popover-menu-surface settings-mobile-route-popover">
                <Popover.Title class="settings-mobile-route-popover-title">
                  {t("settings.mobileConnect.route.title")}
                </Popover.Title>
                <Popover.Description class="settings-mobile-route-popover-description">
                  {t("settings.mobileConnect.route.description")}
                </Popover.Description>
                <RemoteNetworkRouteChoice
                  value={current().route}
                  tailscaleConnected={current().tailscaleConnected}
                  disabled={props.disabled || props.store.state.route.busy}
                  onChange={(route) => void props.store.setRoute(route)}
                />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        );
      }}
    </Show>
  );
}
