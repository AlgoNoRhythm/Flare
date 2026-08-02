import { contextBridge, ipcRenderer } from 'electron';
import { isEventChannel } from '../shared/channels';

/**
 * The desktop transport.
 *
 * Deliberately generic: it forwards a channel name with its arguments and
 * knows nothing about what any of them mean. The typed API the app actually
 * calls is built once, in `src/api.ts`, on top of this shape — and the browser
 * build supplies the same two methods over a websocket. So there is one client
 * surface rather than one per transport, and adding an endpoint never means
 * writing it out a second time here.
 *
 * Exposing a generic `invoke` widens nothing: every channel the core registers
 * was already reachable from the renderer, the set is closed, and the window
 * never loads remote content.
 */
const bridge = {
  kind: 'desktop' as const,
  invoke: (channel: string, args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
    if (!isEventChannel(channel)) return () => undefined;
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

export type FlareBridge = typeof bridge;

contextBridge.exposeInMainWorld('flare', bridge);
