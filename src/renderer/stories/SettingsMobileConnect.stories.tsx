import {
  type MobileConnectReach,
  SettingsMobileConnectTab,
} from "@openbot/ui/features/settings/SettingsMobileConnectTab";
import { createSettingsMobileConnectStore } from "@openbot/ui/features/settings/stores/mobile-connect-store";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

/** The address that main gives a packaged app: the web app of the Builders Bot account service. */
const WEB_APP_URL = "https://buildersbot.culturabuilder.com/app";

/**
 * Mobile Connect with no phone yet. Add phone opens the dialog: it asks, then shows the QR code of the
 * web app and the steps that add it to the Home Screen of an iPhone or an Android phone, then the
 * sign-in steps. No step offers a phone app from a store. The address is a closure, not a prop, so
 * the story reads no reactive value. `reach` is whether the phone can reach the server of this computer.
 */
function mobileConnectStory(address: () => Promise<string>, reach: MobileConnectReach | null = null) {
  return function MobileConnectStory() {
    const store = createSettingsMobileConnectStore(
      { open: true, onListMobileConnectedDevices: async () => [], onGetMobileWebAppUrl: address },
      () => true,
    );
    return (
      <SettingsMobileConnectTab
        store={store}
        accountEmail="person@example.com"
        canCreateTicket
        canManageLink={false}
        canRevokeDevice={false}
        canSetRoute={false}
        reach={reach}
        onPublishComputer={() => Promise.reject(new Error("publish_failed"))}
      />
    );
  };
}

const WithAddress = mobileConnectStory(() => Promise.resolve(WEB_APP_URL));
const WithoutAddress = mobileConnectStory(() =>
  Promise.reject(new Error("Could not load the address of the web app.")),
);
const NotPublished = mobileConnectStory(() => Promise.resolve(WEB_APP_URL), { state: "offline", message: null });
const Published = mobileConnectStory(() => Promise.resolve(WEB_APP_URL), { state: "online", message: null });
const Starting = mobileConnectStory(() => Promise.resolve(WEB_APP_URL), { state: "starting", message: null });
const Disconnected = mobileConnectStory(() => Promise.resolve(WEB_APP_URL), {
  state: "disconnected",
  message: "Signal did not answer.",
});

const meta = {
  title: "Settings/Mobile Connect",
  component: WithAddress,
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof WithAddress>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Select Add phone, then "No, install the web app". The iPhone and Android tabs change the steps. */
export const AddPhone: Story = { render: () => <WithAddress /> };

/** Main could not give the address: the code slot says so, and the steps of the phone stay. */
export const AddressUnavailable: Story = { render: () => <WithoutAddress /> };

/** The server of this computer is not published, so a phone cannot list it. Publish server fails here. */
export const ComputerNotPublished: Story = { render: () => <NotPublished /> };

/** The server of this computer is published: a phone lists it while the computer is on and awake. */
export const ComputerPublished: Story = { render: () => <Published /> };

/** The server of this computer is being published or connected. */
export const ComputerStarting: Story = { render: () => <Starting /> };

/** The server is published, but not connected now, with the cause from the host. Try again fails here. */
export const ComputerDisconnected: Story = { render: () => <Disconnected /> };
