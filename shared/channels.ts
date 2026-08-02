/**
 * The events the backend pushes to a UI, in one place.
 *
 * Both transports forward events blindly — neither the preload bridge nor the
 * websocket client names a channel — so adding an event means adding it here
 * and emitting it, and both the desktop and the browser see it.
 */
export const EVENT_CHANNELS = [
  'evt:projectOpened',
  'evt:graphPatch',
  'evt:filesChanged',
  'evt:gitStatus',
  'evt:treeChanged',
  'evt:shadowSnapshot',
  'evt:ptyData',
  'evt:ptyExit',
  'evt:agentStatus',
  'evt:agentCommand',
  'evt:commandUpdate',
  'evt:dangerousCommand',
  'evt:activity',
  'evt:board',
  'evt:coverage',
  'evt:windowState',
] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];

const known: ReadonlySet<string> = new Set(EVENT_CHANNELS);

export function isEventChannel(channel: string): channel is EventChannel {
  return known.has(channel);
}
