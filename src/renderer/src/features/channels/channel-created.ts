/**
 * A channel that the service has just accepted as new. The channels domain sits above the sidebar, so it
 * cannot read the selected section; the part that can reads this and files the channel there.
 */
type ChannelCreatedListener = (channelId: string) => void;

const listeners = new Set<ChannelCreatedListener>();

/** Returns the function that removes the listener. */
export function onChannelCreated(listener: ChannelCreatedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function announceChannelCreated(channelId: string): void {
  for (const listener of listeners) listener(channelId);
}
