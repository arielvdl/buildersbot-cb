import type { ServerCreationAdminState } from "@openbot/contracts/server-creation";
import { ServerCreationAdminSection } from "@openbot/ui/features/settings/ServerCreationAdminSection";
import {
  createServerCreationAdminStore,
  type ServerCreationAdminCalls,
} from "@openbot/ui/features/settings/stores/server-creation-admin-store";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createMockHostedServers } from "../src/preview/mock-hosted-servers";

interface AdminStoryProps {
  /** No request waits and nobody has a grant. */
  empty?: boolean;
  /** The administrator state cannot load. */
  loadError?: boolean;
  /** Each change fails. */
  failChanges?: boolean;
}

const EMPTY: ServerCreationAdminState = { requests: [], grants: [] };

/** The administrator section of server creation, with the preview account as the administrator. */
function AdminStory(props: AdminStoryProps) {
  const mock = createMockHostedServers();
  const fail = () => Promise.reject(new Error("The account service could not complete the request."));
  const calls: ServerCreationAdminCalls = {
    creationAccess: mock.creationAccess,
    creationAdmin: props.loadError ? fail : props.empty ? async () => structuredClone(EMPTY) : mock.creationAdmin,
    grantCreation: props.failChanges ? fail : mock.grantCreation,
    revokeCreation: props.failChanges ? fail : mock.revokeCreation,
    decideCreationRequest: props.failChanges ? fail : mock.decideCreationRequest,
  };
  const store = createServerCreationAdminStore(
    () => calls,
    () => true,
  );
  return (
    <main style={{ "max-width": "720px", padding: "24px" }}>
      <ServerCreationAdminSection store={store} />
    </main>
  );
}

const meta = {
  title: "Account/Settings/Server creation",
  component: AdminStory,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof AdminStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RequestsAndGrants: Story = {};
export const Empty: Story = { args: { empty: true } };
export const LoadError: Story = { args: { loadError: true } };
export const FailedChange: Story = { args: { failChanges: true } };
