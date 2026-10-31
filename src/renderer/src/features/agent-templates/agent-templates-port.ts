import type { BuildersBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * What the publish and install dialogs reach in main: the agent templates of this computer, and
 * adding a template's agent on a joined server.
 */
export interface AgentTemplatesPort {
  agent: Pick<BuildersBotDesktopApi["agent"], "addTemplateAgent">;
  agentTemplates: Pick<
    BuildersBotDesktopApi["agentTemplates"],
    "get" | "install" | "preview" | "publish" | "unpublish"
  >;
}

/** What the publish dialog reaches. The web client passes the host's. */
export type AgentTemplatePublishCalls = Pick<AgentTemplatesPort["agentTemplates"], "preview" | "publish" | "unpublish">;

/** What the install dialog reaches: reading a template, and adding its agent. The web client passes its own. */
export interface AgentTemplateInstallCalls {
  agent: AgentTemplatesPort["agent"];
  agentTemplates: Pick<AgentTemplatesPort["agentTemplates"], "get" | "install">;
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function agentTemplatesPort(): AgentTemplatesPort {
  return window.openbot;
}
