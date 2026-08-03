import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

/**
 * A shared secret in front of the served UI.
 *
 * Behind this port are your files, your git history and a live shell, and the
 * whole point of serving Flare is that the port is reachable from somewhere
 * else — an SSH tunnel, a forwarded port, a colleague's laptop on the same
 * network. A tunnel is already an authentication of sorts; `--host 0.0.0.0` is
 * not, and neither is a cloud IDE's port forwarding once the URL is guessed or
 * shared. So the browser side carries a token by default, the same way Jupyter
 * does, and `--no-token` turns it off for the cases where something in front
 * has already done the job.
 *
 * Three ways in, in the order they are consulted:
 *
 * - `?token=…`, which is what the startup banner prints. It is accepted on any
 *   URL and answered with a cookie, so it is needed once per browser.
 * - `Authorization: Bearer …` or `X-Flare-Token: …`, for scripts and probes.
 * - the cookie, for every request after the first.
 *
 * The websocket is covered by the same check: the browser sends the cookie on
 * the upgrade, so nothing in the transport had to learn about any of this.
 *
 * Agents are deliberately not covered — `/mcp/<slug>` is a separate endpoint
 * with its own audience, and putting a browser cookie in front of it would
 * break every `claude mcp add` line already in a config file.
 */

/** Query parameter the banner prints, and the login form submits. */
export const TOKEN_PARAM = 'token';
/** Cookie the first successful request sets. */
export const TOKEN_COOKIE = 'flare_token';
/** Where a generated token is remembered, under the user data dir. */
export const TOKEN_FILE = 'web-token';

export interface WebAuth {
  /** false when `--no-token` was given: every request is served */
  readonly enabled: boolean;
  /** the secret, or '' when disabled */
  readonly token: string;
  /** true when it was generated rather than supplied */
  readonly generated: boolean;
}

/** No token asked for; every request is served. */
export const NO_AUTH: WebAuth = { enabled: false, token: '', generated: false };

/**
 * 192 bits, URL- and cookie-safe.
 *
 * Long enough that nobody can guess it and short enough to be pasted out of a
 * terminal by hand, which is how it will actually travel.
 */
export function newToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function isOff(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/**
 * Decide the token for this process.
 *
 * A generated one is remembered in the data dir rather than being fresh per
 * run, because on this machine there may be several Flare processes — a
 * supervisor, a session per project, whichever one took the port over when the
 * last holder exited — and a browser holding a cookie has to be able to talk to
 * all of them. Persisting also means a bookmarked URL survives a restart.
 */
export function resolveWebAuth(opts: {
  disabled?: boolean;
  token?: string;
  env: NodeJS.ProcessEnv;
  dataDir: string;
}): WebAuth {
  if (opts.disabled || isOff(opts.env.FLARE_NO_TOKEN)) return NO_AUTH;

  const given = (opts.token ?? opts.env.FLARE_TOKEN ?? '').trim();
  if (given !== '') return { enabled: true, token: given, generated: false };

  const file = path.join(opts.dataDir, TOKEN_FILE);
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved !== '') return { enabled: true, token: saved, generated: true };
  } catch {
    // no token yet, or unreadable — make one below
  }

  const token = newToken();
  try {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    // 0600: the token is the login, so it is not for other accounts to read
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  } catch {
    // an unwritable data dir costs the URL its stability, nothing more
  }
  return { enabled: true, token, generated: true };
}

/** Constant-time compare, so a wrong token leaks nothing about the right one. */
export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** The token a request carries, and where it came from. */
export function presentedToken(
  url: string,
  headers: http.IncomingHttpHeaders,
): { value: string; from: 'query' | 'header' | 'cookie' | null } {
  const query = new URL(url || '/', 'http://flare.invalid').searchParams.get(TOKEN_PARAM);
  if (query) return { value: query, from: 'query' };

  const auth = headers.authorization ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (bearer) return { value: bearer[1].trim(), from: 'header' };

  const header = headers['x-flare-token'];
  const direct = Array.isArray(header) ? header[0] : header;
  if (direct) return { value: direct.trim(), from: 'header' };

  const cookie = readCookie(headers.cookie, TOKEN_COOKIE);
  if (cookie) return { value: cookie, from: 'cookie' };

  return { value: '', from: null };
}

/**
 * `ok` — serve it. `grant` — serve it and hand back a cookie, because the
 * token arrived in the URL. `deny` — 401.
 */
export function authorize(
  url: string,
  headers: http.IncomingHttpHeaders,
  auth: WebAuth,
): 'ok' | 'grant' | 'deny' {
  if (!auth.enabled) return 'ok';
  const { value, from } = presentedToken(url, headers);
  if (from === null || !sameToken(value, auth.token)) return 'deny';
  return from === 'query' ? 'grant' : 'ok';
}

/**
 * The cookie that carries the token for the rest of the session.
 *
 * No `Max-Age`: it lasts as long as the browser is open, which is the right
 * lifetime for something that also grants a shell. `Secure` only when the
 * request arrived over https, since the common case — an SSH tunnel to
 * `http://127.0.0.1` — would otherwise be handed a cookie the browser refuses
 * to send back.
 */
export function cookieFor(token: string, secure: boolean): string {
  const parts = [
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** True when the browser reached us over https, directly or through a proxy. */
export function isSecureRequest(headers: http.IncomingHttpHeaders, encrypted = false): boolean {
  const forwarded = headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (proto) return proto.split(',')[0].trim() === 'https';
  return encrypted;
}

/** A printable URL that will let you straight in. */
export function withToken(base: string, auth: WebAuth): string {
  if (!auth.enabled) return base;
  return `${base}?${TOKEN_PARAM}=${encodeURIComponent(auth.token)}`;
}
