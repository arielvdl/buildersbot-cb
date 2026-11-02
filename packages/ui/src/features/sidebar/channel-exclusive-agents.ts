import type { ChannelSummary } from "@openbot/contracts/ipc";

/**
 * The member agents that exist only in this channel: no other channel in `channels` has them. They
 * are the ones the delete confirmation may offer to delete along with the channel. A member that is
 * no longer in `agentIds` is already gone, so it is left out.
 */
export function channelExclusiveAgentIds(
  channelId: string,
  channels: readonly Pick<ChannelSummary, "id" | "members">[],
  agentIds: readonly string[],
): string[] {
  const target = channels.find((channel) => channel.id === channelId);
  if (!target) return [];
  const inOtherChannels = new Set<string>();
  for (const channel of channels) {
    if (channel.id === channelId) continue;
    for (const member of channel.members) inOtherChannels.add(member.agentId);
  }
  const existing = new Set(agentIds);
  const exclusive = new Set<string>();
  for (const member of target.members) {
    if (existing.has(member.agentId) && !inOtherChannels.has(member.agentId)) exclusive.add(member.agentId);
  }
  return [...exclusive];
}
