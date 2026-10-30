import { SettingsMobileConnectTab } from "@openbot/ui/features/settings/SettingsMobileConnectTab";
import { createSettingsMobileConnectStore } from "@openbot/ui/features/settings/stores/mobile-connect-store";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

/** The address that main gives a packaged app: the web app of the Builders Bot account service. */
const WEB_APP_URL = "https://buildersbot.culturabuilder.com/app";

/**
 * Mobile Connect with no phone yet. Add phone opens the dialog: it asks, then shows the QR code of the
 * web app and the steps that add it to the Home Screen of an iPhone or an Android phone, then the
 * sign-in steps. No step offers a phone app from a store. The address is a closure, not a prop, so
 * the story reads no reactive value.
 */
function mobileConnectStory(address: () => Promise<string>) {
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
      />
    );
  };
}

const WithAddress = mobileConnectStory(() => Promise.resolve(WEB_APP_URL));
const WithoutAddress = mobileConnectStory(() =>
  Promise.reject(new Error("Could not load the address of the web app.")),
);

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
