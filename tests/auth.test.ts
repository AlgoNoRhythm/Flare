import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorize,
  cookieFor,
  isSecureRequest,
  newToken,
  NO_AUTH,
  presentedToken,
  readCookie,
  resolveWebAuth,
  TOKEN_COOKIE,
  TOKEN_FILE,
  withToken,
  type WebAuth,
} from '../server/auth';

/**
 * The token in front of the served UI.
 *
 * What matters here is not that a correct token is let in — it is that
 * everything else is kept out, and that the one deliberate way out (`--no-token`)
 * is the only way out.
 */

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flare-auth-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const auth: WebAuth = { enabled: true, token: 'secret-token', generated: false };

describe('resolving the token', () => {
  it('generates one and remembers it', () => {
    const dataDir = tempDir();
    const first = resolveWebAuth({ env: {}, dataDir });
    expect(first.enabled).toBe(true);
    expect(first.token.length).toBeGreaterThan(20);
    expect(fs.readFileSync(path.join(dataDir, TOKEN_FILE), 'utf8').trim()).toBe(first.token);

    // a second process on the same machine has to agree with the first, or a
    // browser holding a cookie stops working the moment the port changes hands
    expect(resolveWebAuth({ env: {}, dataDir }).token).toBe(first.token);
  });

  it('prefers an explicit token over the remembered one, without storing it', () => {
    const dataDir = tempDir();
    const remembered = resolveWebAuth({ env: {}, dataDir }).token;
    const chosen = resolveWebAuth({ token: 'mine', env: {}, dataDir });
    expect(chosen).toMatchObject({ enabled: true, token: 'mine', generated: false });
    expect(fs.readFileSync(path.join(dataDir, TOKEN_FILE), 'utf8').trim()).toBe(remembered);
  });

  it('takes the token from the environment, which is how sessions inherit it', () => {
    expect(resolveWebAuth({ env: { FLARE_TOKEN: 'passed-down' }, dataDir: tempDir() }).token).toBe(
      'passed-down',
    );
  });

  it('turns off for --no-token and for $FLARE_NO_TOKEN, and writes nothing', () => {
    const dataDir = tempDir();
    expect(resolveWebAuth({ disabled: true, env: {}, dataDir })).toEqual(NO_AUTH);
    expect(resolveWebAuth({ env: { FLARE_NO_TOKEN: '1' }, dataDir })).toEqual(NO_AUTH);
    expect(fs.existsSync(path.join(dataDir, TOKEN_FILE))).toBe(false);
  });

  it('reads FLARE_NO_TOKEN=0 as "no, leave it on"', () => {
    expect(resolveWebAuth({ env: { FLARE_NO_TOKEN: '0' }, dataDir: tempDir() }).enabled).toBe(true);
  });

  it('still serves when the data dir cannot be written', () => {
    const missing = path.join(tempDir(), 'file-not-a-dir');
    fs.writeFileSync(missing, 'x');
    const resolved = resolveWebAuth({ env: {}, dataDir: path.join(missing, 'nested') });
    expect(resolved.enabled).toBe(true);
    expect(resolved.token).not.toBe('');
  });

  it('makes a different token every time', () => {
    expect(newToken()).not.toBe(newToken());
  });
});

describe('what a request presents', () => {
  it('finds the token in the query, a bearer header, x-flare-token or the cookie', () => {
    expect(presentedToken('/alpha/?token=abc', {})).toEqual({ value: 'abc', from: 'query' });
    expect(presentedToken('/', { authorization: 'Bearer abc' })).toEqual({
      value: 'abc',
      from: 'header',
    });
    expect(presentedToken('/', { 'x-flare-token': 'abc' })).toEqual({ value: 'abc', from: 'header' });
    expect(presentedToken('/', { cookie: `${TOKEN_COOKIE}=abc` })).toEqual({
      value: 'abc',
      from: 'cookie',
    });
    expect(presentedToken('/', {})).toEqual({ value: '', from: null });
  });

  it('prefers the query, so a fresh link can replace a stale cookie', () => {
    expect(presentedToken('/?token=new', { cookie: `${TOKEN_COOKIE}=old` })).toEqual({
      value: 'new',
      from: 'query',
    });
  });

  it('picks its own cookie out of the others', () => {
    const header = `theme=dark; ${TOKEN_COOKIE}=abc%2Fd; other=1`;
    expect(readCookie(header, TOKEN_COOKIE)).toBe('abc/d');
    expect(readCookie('nothing-here', TOKEN_COOKIE)).toBeNull();
    expect(readCookie(undefined, TOKEN_COOKIE)).toBeNull();
  });
});

describe('authorising', () => {
  it('grants a cookie when the token arrives in the url', () => {
    expect(authorize('/alpha/?token=secret-token', {}, auth)).toBe('grant');
  });

  it('serves a request that already carries the cookie or a header', () => {
    expect(authorize('/alpha/', { cookie: `${TOKEN_COOKIE}=secret-token` }, auth)).toBe('ok');
    expect(authorize('/ws', { authorization: 'Bearer secret-token' }, auth)).toBe('ok');
  });

  it('denies no token, the wrong token, and a near miss', () => {
    expect(authorize('/alpha/', {}, auth)).toBe('deny');
    expect(authorize('/alpha/?token=nope', {}, auth)).toBe('deny');
    expect(authorize('/alpha/?token=secret-toke', {}, auth)).toBe('deny');
    expect(authorize('/alpha/?token=secret-tokenn', {}, auth)).toBe('deny');
    expect(authorize('/alpha/', { cookie: `${TOKEN_COOKIE}=` }, auth)).toBe('deny');
  });

  it('lets everything through only when the token was turned off', () => {
    expect(authorize('/alpha/', {}, NO_AUTH)).toBe('ok');
    expect(authorize('/ws', {}, NO_AUTH)).toBe('ok');
  });
});

describe('what gets handed back', () => {
  it('scopes the cookie to the whole origin and keeps it off scripts', () => {
    const cookie = cookieFor('abc', false);
    expect(cookie).toContain(`${TOKEN_COOKIE}=abc`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });

  it('marks the cookie Secure only when the browser came over https', () => {
    expect(cookieFor('abc', true)).toContain('Secure');
    expect(isSecureRequest({ 'x-forwarded-proto': 'https' })).toBe(true);
    expect(isSecureRequest({ 'x-forwarded-proto': 'https, http' })).toBe(true);
    // a tunnel to http://127.0.0.1 must not be handed a cookie it cannot return
    expect(isSecureRequest({})).toBe(false);
    expect(isSecureRequest({ 'x-forwarded-proto': 'http' }, true)).toBe(false);
    expect(isSecureRequest({}, true)).toBe(true);
  });

  it('prints a url you can paste, and leaves it alone when there is no token', () => {
    expect(withToken('http://127.0.0.1:7345/alpha/', auth)).toBe(
      'http://127.0.0.1:7345/alpha/?token=secret-token',
    );
    expect(withToken('http://127.0.0.1:7345/', NO_AUTH)).toBe('http://127.0.0.1:7345/');
  });

  it('escapes a token that would otherwise break the url', () => {
    const odd: WebAuth = { enabled: true, token: 'a b&c=d', generated: false };
    const printed = withToken('http://x/', odd);
    expect(printed).toBe('http://x/?token=a%20b%26c%3Dd');
    // and it survives the round trip back out of that url
    expect(authorize(new URL(printed).pathname + new URL(printed).search, {}, odd)).toBe('grant');
  });
});
