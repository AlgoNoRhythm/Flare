import * as os from 'node:os';

/**
 * Where this server can actually be reached from.
 *
 * `127.0.0.1` is the right thing to *bind* and the wrong thing to *print*: on
 * a remote machine the person reading the console is not on that machine, and
 * a loopback URL sends them nowhere. So the addresses of the real network
 * interfaces are worked out and shown, along with whether they will answer —
 * which depends on what the server bound to, not on what we print.
 */

export interface ReachableUrls {
  /** true when the bind address covers more than loopback */
  exposed: boolean;
  /** every base URL that should answer, best guess first */
  urls: string[];
  /** addresses that exist but will not answer, because we bound to loopback */
  unreachable: string[];
  /** true when the first url was supplied rather than guessed */
  declared: boolean;
}

/**
 * The address *you* reach this machine at, when the machine cannot know it.
 *
 * A managed notebook or a cloud workstation is fronted by a proxy on some
 * hostname of its own — `gcp.jupyter.identifier27276`, say — which appears
 * nowhere in the VM's own network interfaces or hostname. Nothing can derive
 * it, so it is told: `--public-url`, and every URL Flare prints is built from
 * it, port and project slug included.
 *
 * Accepts a bare host, a host:port, or a full base URL with a path prefix, and
 * only fills in this server's port when the answer is otherwise unambiguous:
 * an explicit port, a path, or https (which implies something is already
 * listening on 443 in front of us) are all left exactly as given.
 */
export function normalisePublicBase(spec: string, port: number): string {
  const trimmed = spec.trim();
  if (trimmed === '') return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return '';
  }
  const hasPath = url.pathname.replace(/\/+$/, '') !== '';
  if (!url.port && !hasPath && url.protocol === 'http:') url.port = String(port);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}/`;
  return base;
}

/**
 * Addresses of this machine's real (non-loopback) interfaces, IPv4 first.
 *
 * IPv4 first because these end up in a "paste this into your browser" line,
 * and `192.168.1.71` is a great deal easier to retype off a terminal than
 * `[2a02:aa16:517a:5900:278:384d:eb5e:e47a]`.
 */
export function machineAddresses(): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === 'IPv6') {
        // link-local needs a scope id to be usable and is noise here
        if (entry.address.startsWith('fe80')) continue;
        v6.push(`[${entry.address}]`);
      } else {
        v4.push(entry.address);
      }
    }
  }
  return [...v4, ...v6];
}

const WILDCARD = new Set(['0.0.0.0', '::', '[::]', '*']);

/**
 * Work out the address this machine is reached at, from the environment.
 *
 * Every hosted dev environment has a different shape — a Codespace is
 * `name-port.domain`, Gitpod puts the port in front of the workspace host, a
 * JupyterHub proxies it under the user's prefix — and none of them appear in
 * the VM's own interfaces or hostname. They do each announce themselves in the
 * environment, though, so the shape is derived rather than assumed, and a
 * plain machine (a PC, a bare VM) falls through to its real addresses, which
 * *are* discoverable.
 *
 * `--public-url` overrides all of it, for the ones nobody has taught it yet.
 */
export function detectPublicUrl(env: NodeJS.ProcessEnv, port: number): string {
  if (env.FLARE_PUBLIC_URL) return env.FLARE_PUBLIC_URL;

  // GitHub Codespaces: documented as $CODESPACE_NAME-$PORT.$DOMAIN
  if (env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return `https://${env.CODESPACE_NAME}-${port}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/`;
  }

  // Gitpod: the port goes in front of the workspace host
  if (env.GITPOD_WORKSPACE_URL) {
    try {
      const workspace = new URL(env.GITPOD_WORKSPACE_URL);
      return `${workspace.protocol}//${port}-${workspace.host}/`;
    } catch {
      // malformed — fall through to the next candidate
    }
  }

  // JupyterHub and anything using jupyter-server-proxy: a port is served under
  // the user's own prefix at /proxy/<port>/
  const hubBase = env.JUPYTERHUB_PUBLIC_URL ?? env.JUPYTERHUB_HOST;
  if (hubBase) {
    const prefix = env.JUPYTERHUB_SERVICE_PREFIX ?? '/';
    const joined = `${hubBase.replace(/\/+$/, '')}/${prefix.replace(/^\/+|\/+$/g, '')}`;
    return `${joined.replace(/\/+$/, '')}/proxy/${port}/`;
  }

  return '';
}

export function reachableUrls(
  host: string,
  port: number,
  addresses: string[] = machineAddresses(),
  hostname: string = os.hostname(),
  publicUrl = '',
): ReachableUrls {
  const base = (h: string): string => `http://${h}:${port}/`;
  const exposed = WILDCARD.has(host) || !isLoopback(host);
  // a declared address wins over anything guessed: it is the only one that
  // knows about the proxy in front, and it is right even on loopback, since
  // that proxy is what is doing the reaching
  const declared = normalisePublicBase(publicUrl, port);

  const guessed = ((): string[] => {
    if (!exposed) return [base(host)];
    if (!WILDCARD.has(host)) return [base(host)]; // one specific interface
    // bound to everything: the hostname is usually what a colleague resolves,
    // the raw addresses always work
    const named = hostname && hostname !== 'localhost' ? [base(hostname)] : [];
    return [...named, ...addresses.map(base), base('127.0.0.1')];
  })();

  return {
    exposed,
    urls: declared ? [declared, ...guessed] : guessed,
    unreachable: exposed || declared ? [] : addresses.map(base),
    declared: declared !== '',
  };
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}
