/**
 * Composite keys for the renderer's per-conversation caches. A NUL separator
 * cannot appear in a server id, agent id or message id, so the parts stay
 * unambiguous without escaping.
 */

/** Identifies one agent conversation, which is an agent *on a server*. */
export function agentConversationKey(serverId: string, agentId: string): string {
  return `${serverId}\0${agentId}`;
}

/** Identifies one message within an agent's conversation. */
export function agentMessageKey(agentId: string, messageId: string): string {
  return `${agentId}\0${messageId}`;
}

/**
 * Identifies one composer draft: an agent *on a server*, or one tab of a channel on a server. A draft
 * never shows in another tab, and a send never takes the draft of another tab.
 */
export function composerDraftKey(target: { agentId: string; serverId: string; tabId?: string | undefined }): string {
  const chat = target.serverId === "local" ? target.agentId : `${target.serverId}:${target.agentId}`;
  return target.tabId ? `${chat}\0tab:${target.tabId}` : chat;
}

/** Whether two targets are the same draft. */
export function sameComposerDraft(
  left: { agentId: string; serverId: string; tabId?: string | undefined } | undefined,
  right: { agentId: string; serverId: string; tabId?: string | undefined } | undefined,
): boolean {
  return left !== undefined && right !== undefined && composerDraftKey(left) === composerDraftKey(right);
}

/**
 * The key that a channel draft had before each tab kept its own: the channel without a tab. The first
 * tab that shows such a draft takes it, so an update loses no text.
 */
export function legacyChannelDraftKey(target: { agentId: string; serverId: string; tabId?: string | undefined }) {
  return target.tabId ? composerDraftKey({ agentId: target.agentId, serverId: target.serverId }) : undefined;
}

/** Identifies the composer draft of one side thread of an agent, or of its new thread tab. */
export function threadDraftKey(target: { agentId: string; serverId: string }, threadId: string): string {
  return `${composerDraftKey(target)}\0${threadId}`;
}

/** Drops every cached body belonging to one agent. */
export function deleteAgentMessageBodies(messages: Map<string, string>, agentId: string): void {
  const prefix = `${agentId}\0`;
  for (const key of messages.keys()) {
    if (key.startsWith(prefix)) messages.delete(key);
  }
}

/**
 * Identifies one outstanding question. A request id is only unique within its
 * turn, so both parts are needed; either one missing means there is nothing to
 * answer yet.
 */
export function promptRequestKey(turnId: string | undefined, requestId: string | number | undefined): string | null {
  if (!turnId || requestId === undefined) return null;
  return JSON.stringify([turnId, String(requestId)]);
}

export function messagePromptRequestKey(message: {
  turnId?: string | undefined;
  questionPrompt?: { requestId: string | number } | undefined;
}): string | null {
  return promptRequestKey(message.turnId, message.questionPrompt?.requestId);
}
