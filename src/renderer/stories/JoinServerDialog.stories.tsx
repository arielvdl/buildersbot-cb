import type { ServerCreationAccess } from "@openbot/contracts/server-creation";
import { JoinServerDialog } from "@openbot/ui/features/servers/JoinServerDialog";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const preview = {
  serverId: "00000000-0000-4000-8000-000000000000",
  serverName: "Studio host",
  apiHostname: "story-host.openbot.run",
  role: "member" as const,
  expiresAt: "2026-08-21T10:00:00.000Z",
  emailBound: false,
  permanent: false,
};

const args: Parameters<typeof JoinServerDialog>[0] = {
  inviteUrl:
    "https://openbot.run/join?api=https%3A%2F%2Fstory-host.openbot.run%2F&server=00000000-0000-4000-8000-000000000000&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&invite=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  accountEmail: "person@example.com",
  onClose: fn(),
  onPreview: fn(async () => preview),
  onJoin: fn(async () => undefined),
};

const meta = {
  title: "Team/JoinServerDialog",
  component: JoinServerDialog,
  args,
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    viewport: {
      options: {
        joinServerNarrow: {
          name: "Join server — 360 × 640",
          styles: { width: "360px", height: "640px" },
        },
      },
    },
  },
} satisfies Meta<typeof JoinServerDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const VerifiedInvite: Story = {};

export const EmailBoundInvite: Story = {
  args: {
    onPreview: fn(async () => ({ ...preview, emailBound: true })),
  },
};

export const EmptyInvite: Story = {
  args: { inviteUrl: "" },
};

export const ErrorState: Story = {
  args: {
    inviteUrl: "",
    onPreview: async () => {
      throw new Error("The Builders Bot invitation link is invalid.");
    },
  },
};

export const Joining: Story = {
  args: {
    onJoin: () => new Promise<void>(() => undefined),
  },
};

export const JoinError: Story = {
  args: {
    onJoin: async () => {
      throw new Error("Builders Bot could not connect to this host.");
    },
  },
};

export const LongIdentity: Story = {
  args: {
    accountEmail: "person.with.a.long.address@example-company-name.com",
    onPreview: fn(async () => ({
      ...preview,
      serverName: "Product design and research studio host",
      apiHostname: "product-design-research-studio.openbot.run",
    })),
  },
};

export const Narrow: Story = {
  args: { inviteUrl: "" },
  parameters: { viewport: { defaultViewport: "joinServerNarrow" } },
};

export const NarrowVerified: Story = {
  parameters: { viewport: { defaultViewport: "joinServerNarrow" } },
};

/** The section about a new remote server, below the invite. Joining needs no permission; creating does. */
function createAccess(
  canCreate: boolean,
  status: "pending" | "denied" | null = null,
): NonNullable<Parameters<typeof JoinServerDialog>[0]["createAccess"]> {
  const access: ServerCreationAccess = {
    canCreate,
    administrator: false,
    creationAvailable: true,
    request: status ? { id: "request-1", status, createdAt: Date.UTC(2026, 9, 30, 12), decidedAt: null } : null,
  };
  return { access, onCreate: fn(), onRequest: fn(async () => undefined) };
}

export const CreateAllowed: Story = {
  args: { createAccess: createAccess(true) },
};

export const CreateRequest: Story = {
  args: { createAccess: createAccess(false) },
};

export const CreatePending: Story = {
  args: { createAccess: createAccess(false, "pending") },
};

export const CreateDenied: Story = {
  args: { createAccess: createAccess(false, "denied") },
};

export const CreateRequestNarrow: Story = {
  args: { createAccess: createAccess(false) },
  parameters: { viewport: { defaultViewport: "joinServerNarrow" } },
};
