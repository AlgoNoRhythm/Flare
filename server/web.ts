import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Core } from '../electron/core';
import type { HttpMount, MountContext } from '../electron/services/mcp';
import type { EventChannel } from '../shared/channels';
import {
  authorize,
  cookieFor,
  isSecureRequest,
  NO_AUTH,
  TOKEN_FILE,
  TOKEN_PARAM,
  type WebAuth,
} from './auth';

/**
 * Flare in a browser tab.
 *
 * This is a transport, not a second implementation: it serves the same built
 * `dist/` the desktop app loads and forwards every request to the same
 * `Core.handle`. It knows no channel names — which is the point, since the
 * whole value of running Flare this way is that it stays the same Flare.
 *
 * It rides on the MCP server's two ports (see `HttpMount`), so one instance
 * exposes one port: agents talk to `/mcp/<slug>`, browsers open `/<slug>/`.
 * That matters wherever a single forwarded port is all you get, which is the
 * normal case for a remote machine.
 *
 * Everything it serves is behind the token in `auth.ts`, including the
 * websocket. The agent endpoint is not — see the note there.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/** An RPC call from a browser. Without an `id` it is a notification: no reply. */
interface Call {
  id?: number;
  channel: string;
  args: unknown[];
}

/**
 * Nagle's algorithm holds a small write back in case more follows, and a
 * keystroke is exactly the small write it holds — up to a delayed-ACK's worth
 * on the far side. `ws` turns it off for the sockets it owns; the two it does
 * not see are the raw ends of a proxied session, below.
 */
function noDelay(socket: Duplex): void {
  const s = socket as Duplex & { setNoDelay?: (on: boolean) => void };
  if (typeof s.setNoDelay === 'function') s.setNoDelay(true);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export class WebUi implements HttpMount {
  private core: Core | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    private readonly distDir: string,
    private readonly auth: WebAuth = NO_AUTH,
  ) {}

  attach(core: Core): void {
    this.core = core;
  }

  /** Push an event to every open tab. */
  broadcast(channel: EventChannel, payload: unknown): void {
    if (this.clients.size === 0) return;
    const frame = JSON.stringify({ event: channel, payload });
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(frame);
    }
  }

  close(): void {
    for (const client of this.clients) client.close();
    this.wss.close();
  }

  // ------------------------------------------------------------------
  // routing
  // ------------------------------------------------------------------

  /**
   * Split a URL into the session it addresses and the path within it.
   *
   * On the shared gateway the first segment is the project slug, which is what
   * makes several projects reachable at stable URLs from one port. On an
   * instance's own port there is only ever one session, so the whole path is
   * the file path.
   */
  private route(url: string, ctx: MountContext): { slug: string | null; rest: string } {
    const clean = (url || '/').split('?')[0];
    if (!ctx.gateway) return { slug: ctx.slug, rest: clean };
    // A running session claims its first segment; everything else — the start
    // screen at `/`, its assets, a slug whose session has gone — belongs to
    // whoever holds the port.
    const match = /^\/([\w-]+)(\/.*)?$/.exec(clean);
    if (match && ctx.sessions().some((s) => s.slug === match[1])) {
      return { slug: match[1], rest: match[2] ?? '' };
    }
    return { slug: null, rest: clean };
  }

  request(req: http.IncomingMessage, res: http.ServerResponse, ctx: MountContext): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const { slug, rest } = this.route(req.url ?? '/', ctx);

    if (rest === '/mcp' || rest.startsWith('/mcp/')) return false; // the agent endpoint

    const verdict = authorize(req.url ?? '/', req.headers, this.auth);
    if (verdict === 'deny') {
      this.sendLogin(res);
      return true;
    }
    if (verdict === 'grant') {
      // the token came in the URL: remember it, so the rest of the session —
      // assets, the websocket, the next tab — carries no secret in its address
      res.setHeader(
        'set-cookie',
        cookieFor(this.auth.token, isSecureRequest(req.headers, 'encrypted' in req.socket)),
      );
    }

    if (slug !== null && rest === '') {
      // "/<slug>" without the slash resolves the page's relative asset links
      // against the root instead of against the session
      res.writeHead(302, { location: `/${slug}/` }).end();
      return true;
    }

    // A single bare segment that is not a live session is a stale bookmark —
    // an unresolvable asset path would be a 404 anyway, so only guess for
    // things that look like a page.
    if (ctx.gateway && slug === null && /^\/[\w-]+\/?$/.test(rest) && rest !== '/') {
      this.sendMissing(res, rest.replace(/\//g, ''));
      return true;
    }

    this.sendStatic(res, rest === '/' || rest === '' ? '/index.html' : rest);
    return true;
  }

  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, ctx: MountContext): void {
    const { slug, rest } = this.route(req.url ?? '/', ctx);
    if (rest !== '/ws') {
      socket.destroy();
      return;
    }
    if (authorize(req.url ?? '/', req.headers, this.auth) === 'deny') {
      // answer before hanging up: a bare reset looks like a crashed backend,
      // and the tab would retry it for ever without saying why
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      return;
    }
    const owner = ctx.gateway && slug !== null ? ctx.sessions().find((s) => s.slug === slug) : null;
    if (owner && owner.slug !== ctx.slug) {
      // another process owns this project: hand it the raw socket
      noDelay(socket);
      pipeUpgrade(req, socket, head, owner.port);
      return;
    }
    // `/ws` at the root is the start screen talking to whoever holds the port
    this.wss.handleUpgrade(req, socket, head, (client) => this.serve(client));
  }

  // ------------------------------------------------------------------
  // the connection: RPC in, events out
  // ------------------------------------------------------------------

  private serve(client: WebSocket): void {
    this.clients.add(client);
    client.on('close', () => this.clients.delete(client));
    client.on('error', () => this.clients.delete(client));
    client.on('message', (raw) => {
      let call: Call;
      try {
        call = JSON.parse(String(raw)) as Call;
      } catch {
        return;
      }
      if (typeof call?.channel !== 'string') return;
      if (call.id !== undefined && typeof call.id !== 'number') return;
      void this.answer(client, call);
    });
  }

  private async answer(client: WebSocket, call: Call): Promise<void> {
    let frame: string;
    try {
      const result = await this.core?.handle(call.channel, call.args ?? []);
      if (call.id === undefined) return; // a notification: nobody is waiting
      frame = JSON.stringify({ id: call.id, ok: true, result: result ?? null });
    } catch (err) {
      if (call.id === undefined) return;
      frame = JSON.stringify({ id: call.id, ok: false, error: (err as Error).message });
    }
    if (client.readyState === client.OPEN) client.send(frame);
  }

  // ------------------------------------------------------------------
  // static files
  // ------------------------------------------------------------------

  private sendStatic(res: http.ServerResponse, rest: string): void {
    const abs = path.join(this.distDir, path.normalize(rest).replace(/^(\.\.[/\\])+/, ''));
    if (!abs.startsWith(this.distDir)) {
      res.writeHead(403).end();
      return;
    }
    let body: Buffer;
    try {
      body = fs.readFileSync(abs);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    // hashed asset names are immutable; index.html must never be cached or a
    // rebuilt UI keeps loading chunks that are no longer there
    const cache = rest.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store';
    res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'content-length': body.length });
    res.end(body);
  }

  /**
   * No token, or the wrong one.
   *
   * A form rather than a bare 401, because the person reading it has the token
   * a few lines up in a terminal, and a GET form puts it back on the same URL
   * as `?token=…` — the one route in that already works. No `action`, so it
   * submits to whatever URL the browser is on: the session slug is kept, and so
   * is any proxy prefix in front of it.
   */
  private sendLogin(res: http.ServerResponse): void {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Flare</title>
<style>body{margin:0;padding:12vh 8vw;background:#0d0f13;color:#c9d1dc;
font:14px/1.7 ui-sans-serif,system-ui,'Segoe UI',sans-serif}
input{background:#151922;border:1px solid #2a313d;border-radius:4px;color:#c9d1dc;
padding:6px 8px;font:inherit;width:22em;max-width:60vw}
button{background:#e0a45c;border:0;border-radius:4px;color:#1b1206;padding:7px 14px;
font:inherit;cursor:pointer;margin-left:6px}
code{font-family:ui-monospace,Consolas,monospace;color:#7c8798}</style>
<p>This Flare needs its token. It is printed by <code>flare serve</code> on
startup, and stored in <code>~/.flare/${TOKEN_FILE}</code> on that machine.</p>
<form method="get">
<input type="password" name="${TOKEN_PARAM}" autofocus placeholder="token"
 aria-label="token"><button type="submit">Open</button></form>`,
    );
  }

  /**
   * A stale session URL.
   *
   * Deliberately the only HTML this file writes: the start screen is Flare's
   * own, served from `dist/` like everything else, because a second hand-built
   * project picker would be exactly the kind of parallel copy that drifts.
   * `../` rather than `/` so it still lands right under a proxy prefix.
   */
  private sendMissing(res: http.ServerResponse, slug: string): void {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Flare</title>
<style>body{margin:0;padding:12vh 8vw;background:#0d0f13;color:#c9d1dc;
font:14px/1.7 ui-sans-serif,system-ui,'Segoe UI',sans-serif}
a{color:#e0a45c}code{font-family:ui-monospace,Consolas,monospace;color:#7c8798}</style>
<p>No Flare session is running for <code>${escapeHtml(slug)}</code> — it may have been closed.</p>
<p><a href="../">Pick a project</a></p>`,
    );
  }
}

/**
 * Hand a websocket upgrade to the instance that owns the project.
 *
 * Replaying the request line and headers onto a raw TCP connection and then
 * piping both ways keeps the gateway out of the protocol entirely: the 101 and
 * every frame after it, including multi-megabyte file reads, pass through
 * untouched.
 */
function pipeUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  port: number,
): void {
  const upstream = net.connect(port, '127.0.0.1', () => {
    upstream.setNoDelay(true);
    const lines = ['GET /ws HTTP/1.1'];
    for (const [key, value] of Object.entries(req.headers)) {
      for (const one of Array.isArray(value) ? value : [value]) {
        if (one !== undefined) lines.push(`${key}: ${one}`);
      }
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}
