import type { BillingCurrency, BillingInterval, BillingPlanId } from "@openbot/contracts/billing";
import type { HostedServerEntryPoint } from "@openbot/contracts/hosted-servers";
import type {
  AgentModelId,
  AgentProviderId,
  AgentReasoningEffort,
  AppInfo,
  CentralAuthUser,
  SpeechVoice,
  WorkflowNodeKind,
} from "@openbot/contracts/ipc";

type ServerKind = "local" | "remote" | "unknown";
type AnalyticsResult = "succeeded" | "failed";
/** For a step that the user can stop before it ends. */
type AnalyticsOutcome = AnalyticsResult | "cancelled";
/** Where the words are heard: a model on this computer, or a cloud model. */
type TranscriptionKind = "local" | "cloud" | "server";

interface AgentAnalyticsProperties {
  provider: AgentProviderId;
  model: AgentModelId;
  reasoning_effort: AgentReasoningEffort;
  server_kind: ServerKind;
}

const WORKFLOW_ACTIONS = [
  "create",
  "rename",
  "delete",
  "run",
  "run_step",
  "stop_step",
  "stop_run",
  "retry_step",
  "approve",
  "reject",
  "restore_version",
  "rotate_webhook_secret",
] as const;
export type WorkflowAnalyticsAction = (typeof WORKFLOW_ACTIONS)[number];

interface DesktopAnalyticsEvents {
  desktop_app_opened: { setup_completed: boolean; signed_in: boolean };
  app_updated: { from_version: string; to_version: string };
  account_sign_in_started: { result: "code_sent" | "failed"; failure_code?: string };
  account_sign_in_completed: { result: AnalyticsResult; failure_code?: string };
  account_sign_out: { result: AnalyticsResult; failure_code?: string };
  onboarding_completed: { preferred_provider: AgentProviderId; path?: OnboardingPath; skipped?: boolean };
  onboarding_step: { step: OnboardingStep; action: "viewed" | "next" | "back" | "skipped"; path?: OnboardingPath };
  agent_action:
    | ({ action: "create" } & Partial<AgentAnalyticsProperties> & {
          result: AnalyticsResult;
          failure_code?: string;
        })
    | (Partial<AgentAnalyticsProperties> & {
        action: "update";
        changed_fields: string[];
        result: AnalyticsResult;
        failure_code?: string;
      })
    | (Partial<AgentAnalyticsProperties> & {
        action: "delete" | "duplicate" | "branch";
        result: AnalyticsResult;
        failure_code?: string;
      });
  message_send: Partial<AgentAnalyticsProperties> & {
    channel: "agent" | "direct";
    attachment_count: number;
    attachment_kinds?: AttachmentKind[];
    is_reply: boolean;
    result: AnalyticsResult;
    delivery_count?: number;
    failure_code?: string;
  };
  agent_input_action: {
    kind: "prompt" | "approval";
    decision: "answered" | "accept" | "decline";
    result: AnalyticsResult;
    failure_code?: string;
  };
  queue_action: {
    action: "cancel" | "steer" | "edit" | "reorder" | "interrupt";
    result: AnalyticsResult;
    failure_code?: string;
  };
  routine_action: {
    action: "create" | "update" | "delete" | "test";
    trigger_type: string;
    duration_ms: number;
    result: AnalyticsResult;
    failure_code?: string;
  };
  workflow_action: {
    action: WorkflowAnalyticsAction;
    /** Only on `run_step`: the kind of the node that runs alone. */
    node_kind?: WorkflowNodeKind;
    duration_ms: number;
    result: AnalyticsResult;
    failure_code?: string;
  };
  team_action: {
    action:
      | "server_selected"
      | "server_joined"
      | "server_left"
      | "server_removed"
      | "identity_saved"
      | "published"
      | "unpublished"
      | "invite_created"
      | "member_updated"
      | "member_removed"
      | "invite_revoked"
      | "mcp_server_saved"
      | "mcp_server_removed"
      | "mcp_server_toggled"
      | "mcp_server_tested"
      | "invite_link_copied"
      | "invite_qr_shown";
    result: AnalyticsResult;
    server_kind?: ServerKind;
    role?: "admin" | "member";
    email_bound?: boolean;
    entry_point?: "in_app" | "invite_deep_link";
    failure_code?: string;
  };
  browser_action: {
    action: "open" | "activate" | "reload" | "close";
    result: AnalyticsResult;
    failure_code?: string;
  };
  search_action: {
    scope: "global" | "agent";
    result: AnalyticsResult;
    result_count?: number;
    failure_code?: string;
  };
  remote_desktop_action: {
    action: "connect" | "disconnect" | "select_display";
    result: AnalyticsResult;
    transport?: "unknown" | "p2p" | "relay";
    failure_code?: string;
  };
  update_action: {
    action: "check" | "download" | "install";
    result: AnalyticsResult;
    phase?: string;
    failure_code?: string;
  };
  marketplace_action: {
    entity: "skill" | "agent" | "plugin";
    action: "view" | "install" | "update" | "uninstall" | "publish" | "enable" | "disable";
    result: AnalyticsResult;
    failure_code?: string;
    /** A listing id or plugin slug. Only Builders Bot's own curated listings and plugins are sent. */
    listing_slug?: string;
  };
  memory_action: {
    action: "create" | "update" | "delete" | "clear";
    result: AnalyticsResult;
    failure_code?: string;
  };
  provider_action: {
    provider?: AgentProviderId;
    action:
      | "connect_started"
      | "connect_completed"
      | "refresh"
      | "download_started"
      | "download_completed"
      | "download_cancelled"
      | "cli_update_started"
      | "cli_update_completed"
      | "sign_in_cancelled"
      | "api_key_saved"
      | "custom_provider_saved"
      | "custom_provider_removed";
    result: AnalyticsOutcome;
    method?: "browser" | "code" | "api_key";
    failure_code?: string;
  };
  voice_transcription: {
    result: AnalyticsResult;
    audio_duration_seconds: number;
    duration_ms: number;
    failure_code?: string;
  };
  voice_conversation_action: {
    action: "start" | "end" | "interrupt" | "mute" | "unmute";
    server_kind: ServerKind;
    result: AnalyticsResult;
    /** For `interrupt`: the Stop button, or the user's voice over the agent. */
    trigger?: "button" | "voice";
    transcription?: TranscriptionKind;
    /** For `start`: until the first listen, with the speech model download. For `end`: the whole conversation. */
    duration_ms?: number;
    turn_count?: number;
    failure_code?: string;
  };
  voice_turn: {
    server_kind: ServerKind;
    transcription: TranscriptionKind;
    result: AnalyticsResult;
    audio_duration_seconds: number;
    /** The time to transcribe the turn. */
    duration_ms?: number;
    recording_kept?: boolean;
    failure_code?: string;
  };
  speech_reply: {
    trigger: "voice_conversation" | "dictation" | "read_aloud";
    result: AnalyticsResult;
    /** False when the user or a new turn stopped the reading. */
    completed?: boolean;
    first_audio_ms?: number;
    audio_duration_seconds?: number;
    failure_code?: string;
  };
  speech_model_action: {
    action: "download";
    entry_point: "settings" | "voice_conversation";
    result: AnalyticsResult;
    duration_ms: number;
    failure_code?: string;
  };
  speech_settings_action: {
    action: "read_replies_on" | "read_replies_off" | "voice_changed";
    result: AnalyticsResult;
    voice?: SpeechVoice;
    failure_code?: string;
  };
  reaction_action: {
    action: "add" | "remove";
    result: AnalyticsResult;
    failure_code?: string;
  };
  hosted_site_action: {
    action: "publish" | "replace" | "delete";
    entry_point: "agent" | "settings";
    result: AnalyticsResult;
    failure_code?: string;
  };
  hosted_server_upsell: {
    action: "shown" | "see_plans" | "dismissed";
    entry_point: "routine_created" | "routines_list" | "server_offline";
  };
  hosted_server_plans_action: {
    action:
      | "viewed"
      | "currency_changed"
      | "interval_changed"
      | "plan_selected"
      | "create_failed"
      | "payment_open_failed"
      | "retried"
      | "closed"
      | "join_opened";
    entry_point?: HostedServerEntryPoint;
    plan?: BillingPlanId;
    interval?: BillingInterval;
    currency?: BillingCurrency;
    failure_code?: string;
  };
  limit_reached: {
    kind: "servers" | "members" | "license_users";
    action: "shown" | "manage_clicked" | "confirmed" | "dismissed" | "contact_clicked";
    role?: "admin" | "member";
  };
  license_action: {
    action:
      | "buy_opened"
      | "checkout_opened"
      | "users_change_requested"
      | "plan_change_requested"
      | "cancel_requested"
      | "cancel_kept"
      | "renewal_resumed"
      | "over_limit_shown";
    result?: AnalyticsOutcome;
    direction?: "up" | "down";
    failure_code?: string;
  };
  sales_contact_clicked: { entry_point: "add_server" | "license" | "members" };
  billing_return_viewed: { outcome: "completed" | "cancelled"; kind?: "plan" | "license" | "portal" };
  usage_limit_action: {
    action: "shown" | "model_switched" | "waited";
    from_provider?: AgentProviderId;
    to_provider?: AgentProviderId;
    to_model?: AgentModelId;
  };
  agent_template_action: {
    action: "published" | "updated" | "unpublished" | "link_copied" | "installed";
    result: AnalyticsResult;
    entry_point?: "deep_link" | "in_app";
    failure_code?: string;
  };
  mobile_connect_action: {
    action: "code_shown" | "link_created" | "connected" | "cancelled" | "revoked" | "link_revoked";
    result: AnalyticsResult;
    failure_code?: string;
  };
  connector_action: {
    connector: "slack" | "discord" | "telegram" | "github" | "onepassword" | "bitwarden";
    action: "connect_started" | "connected" | "disconnected" | "enabled" | "disabled";
    result: AnalyticsResult;
    failure_code?: string;
  };
  computer_use_action: { action: "permission_opened"; permission: "screen-recording" | "accessibility" };
  help_link_opened: { destination: "discord" | "feedback" | "guides" | "changelog" };
  channel_action: {
    action: "created" | "archived" | "member_added";
    result: AnalyticsResult;
    failure_code?: string;
  };
  server_transfer_action: {
    action: "export" | "import";
    result: AnalyticsOutcome;
    failure_code?: string;
  };
  usage_viewed: { scope: "agent" | "server"; range?: "7d" | "30d" | "90d" | "1y"; filtered?: boolean };
  /** Sent once, before tracking stops. A user who turns analytics on again sends nothing for it. */
  analytics_preference_changed: { enabled: false };
}

type OnboardingStep = "choose" | "plan" | "computer" | "language";
type OnboardingPath = "free" | "plan";
type AttachmentKind = "image" | "document" | "spreadsheet" | "zip" | "other";

type AnalyticsEventName = keyof DesktopAnalyticsEvents;
export type DesktopAnalyticsProperties<Name extends AnalyticsEventName> = DesktopAnalyticsEvents[Name];
type AnalyticsIdentity = Pick<CentralAuthUser, "id" | "email">;
export interface DesktopAnalyticsScope {
  track<Name extends AnalyticsEventName>(name: Name, properties: DesktopAnalyticsEvents[Name]): void;
}

const NO_SCOPE: DesktopAnalyticsScope = {
  track: () => {
    // No sink: see `DesktopAnalytics`.
  },
};

/**
 * The product analytics of the desktop app and of the web client. They are off in every build.
 *
 * The upstream OpenBot app sent these events, with the account ID and email, to an analytics service
 * of the upstream project. Builders Bot does not control that service, so phase 0 of
 * `.openbot-build/bug-reports/DESIGN.md` removed the client. Builders Bot has no service of its own
 * yet. The event types stay, so each `track` call keeps its checked shape, but no event is kept or
 * sent. `scripts/telemetry-destination-guard.ts` stops a merge that brings the upstream client back.
 */
class DesktopAnalytics {
  /** False: there is no sink, so the caller records no app start and no update. */
  configure(_appInfo: AppInfo): boolean {
    return false;
  }

  /** The web client has no sink either. False: no sink. */
  configureWeb(_options: { version: string; user: AnalyticsIdentity | null; enabled: boolean }): boolean {
    return false;
  }

  setUser(_user: AnalyticsIdentity | null): void {
    // No sink: no identity is kept or sent.
  }

  /** The saved answer still follows the account and the Settings, but no value starts a send. */
  setTrackingEnabled(_enabled: boolean, _options: { recordOptOut?: boolean } = {}): void {
    // No sink: see the class comment.
  }

  scope(): DesktopAnalyticsScope {
    return NO_SCOPE;
  }

  anonymousScope(): DesktopAnalyticsScope {
    return NO_SCOPE;
  }

  track<Name extends AnalyticsEventName>(_name: Name, _properties: DesktopAnalyticsEvents[Name]): void {
    // No sink: see the class comment.
  }
}

export const desktopAnalytics = new DesktopAnalytics();
