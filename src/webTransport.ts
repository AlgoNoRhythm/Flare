import { isEventChannel } from '../shared/channels';
import type { ConnectionState, FlareTransport } from './api';

/**
 * The browser transport.
 *
 * One websocket carries both directions: `{id, channel, args}` out,
 * `{id, ok, result}` back, and unsolicited `{event, payload}` for everything
 * the backend pushes. A frame sent without an `id` is a notification: it is
 * handled and never answered, which is what a keystroke wants. One connection
 * rather than a POST endpoint plus a separate event stream, because this is
 * meant to survive being forwarded through someone else's proxy, and one
 * thing to forward is easier than three.
 *
 * It implements the same `FlareTransport` the Electron preload does, so
 * `createApi` — and therefore the whole app above it — cannot tell the two
 * apart.
 */

interface Pending {
  settle(value: unknown): void;
}

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 8000;

function socketUrl(): string {
  // relative to the page: /<slug>/ → /<slug>/ws, and it keeps working under a
  // proxy prefix like /proxy/7345/<slug>/ without being told about it
  const url = new URL('ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function createWebTransport(): FlareTransport {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const pending = new Map<number, Pending>();
  let queued: string[] = [];
  let socket: WebSocket | null = null;
  let nextId = 1;
  let retry = RETRY_MIN_MS;
  let everConnected = false;

  /*
   * Whether there is a backend on the other end.
   *
   * Without this every call simply resolves empty when the socket is down,
   * which the UI cannot tell apart from a real answer — open this page against
   * something that is not a Flare server and "no project open, no recents, no
   * such folder" is what you get, all of it a lie.
   */
  let state: ConnectionState = 'connecting';
  const watchers = new Set<(s: ConnectionState) => void>();
  const setState = (next: ConnectionState): void => {
    if (state === next) return;
    state = next;
    for (const watcher of watchers) watcher(state);
  };

  const emit = (channel: string, payload: unknown): void => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };

  /**
   * After a dropped connection the backend kept running — its watchers, its
   * terminals and its git state are all still there — but this page missed
   * whatever happened in the gap. Asking for the project again and announcing
   * it as freshly opened puts the UI back through the same path it takes at
   * startup, rather than inventing a second way to recover.
   */
  const rebootstrap = (): void => {
    void call('project:get', []).then((info) => {
      if (info) emit('evt:projectOpened', info);
    });
  };

  const connect = (): void => {
    const ws = new WebSocket(socketUrl());
    socket = ws;

    ws.onopen = () => {
      retry = RETRY_MIN_MS;
      setState('open');
      for (const frame of queued) ws.send(frame);
      queued = [];
      if (everConnected) rebootstrap();
      everConnected = true;
    };

    ws.onmessage = (event) => {
      let message: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; payload?: unknown };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof message.event === 'string') {
        emit(message.event, message.payload);
        return;
      }
      if (typeof message.id !== 'number') return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.ok === false) console.error('flare: request failed —', message.error);
      waiter.settle(message.ok === false ? null : message.result);
    };

    ws.onclose = () => {
      socket = null;
      setState('closed');
      // Nothing will answer these now. They resolve empty rather than reject:
      // the callers are UI reads that would otherwise become unhandled
      // rejections, and the reconnect re-fetches everything anyway.
      for (const waiter of pending.values()) waiter.settle(null);
      pending.clear();
      window.setTimeout(() => {
        setState(everConnected ? 'reconnecting' : 'connecting');
        connect();
      }, retry);
      retry = Math.min(retry * 2, RETRY_MAX_MS);
    };

    ws.onerror = () => ws.close();
  };

  const post = (frame: string): void => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(frame);
    else queued.push(frame);
  };

  const call = (channel: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { settle: resolve });
      post(JSON.stringify({ id, channel, args }));
    });

  const notify = (channel: string, args: unknown[]): void => {
    post(JSON.stringify({ channel, args }));
  };

  connect();

  return {
    kind: 'web',
    invoke: call,
    notify,
    status: {
      get: () => state,
      subscribe(watcher) {
        watchers.add(watcher);
        return () => {
          watchers.delete(watcher);
        };
      },
    },
    on(channel, listener) {
      if (!isEventChannel(channel)) return () => undefined;
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
  };
}
