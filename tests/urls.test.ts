import { describe, expect, it } from 'vitest';
import { detectPublicUrl, isLoopback, normalisePublicBase, reachableUrls } from '../server/urls';

const LAN = ['10.0.0.7', '192.168.1.20'];

describe('what url to print for a served instance', () => {
  it('does not pretend a loopback bind is reachable from elsewhere', () => {
    // the whole reason to serve Flare is that you are not sitting at the
    // machine, so a bare 127.0.0.1 in the console is a dead end
    const where = reachableUrls('127.0.0.1', 7345, LAN, 'workbench');
    expect(where.exposed).toBe(false);
    expect(where.urls).toEqual(['http://127.0.0.1:7345/']);
    expect(where.unreachable).toEqual(['http://10.0.0.7:7345/', 'http://192.168.1.20:7345/']);
  });

  it('prints the addresses that will answer when bound to everything', () => {
    const where = reachableUrls('0.0.0.0', 7345, LAN, 'workbench');
    expect(where.exposed).toBe(true);
    expect(where.unreachable).toEqual([]);
    // the hostname first: on a cloud VM it is usually what resolves for others
    expect(where.urls[0]).toBe('http://workbench:7345/');
    expect(where.urls).toContain('http://10.0.0.7:7345/');
    // and loopback still works from the machine itself
    expect(where.urls).toContain('http://127.0.0.1:7345/');
  });

  it('takes the address it was given when bound to one interface', () => {
    const where = reachableUrls('10.0.0.7', 7345, LAN, 'workbench');
    expect(where.exposed).toBe(true);
    expect(where.urls).toEqual(['http://10.0.0.7:7345/']);
  });

  it('handles ipv6 wildcards and a machine with no useful hostname', () => {
    const where = reachableUrls('::', 7345, ['[2001:db8::1]'], 'localhost');
    expect(where.exposed).toBe(true);
    expect(where.urls[0]).toBe('http://[2001:db8::1]:7345/');
  });

  it('knows which hosts are loopback', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(isLoopback(host), host).toBe(true);
    }
    for (const host of ['0.0.0.0', '10.0.0.7', '::']) {
      expect(isLoopback(host), host).toBe(false);
    }
  });

  it('says nothing is unreachable when there are no other interfaces', () => {
    const where = reachableUrls('127.0.0.1', 7345, [], 'box');
    expect(where.unreachable).toEqual([]);
  });
});

describe('the address the machine cannot know about itself', () => {
  it('takes a bare host and adds this server port', () => {
    // a managed notebook is fronted by a proxy whose hostname appears nowhere
    // in the VM's interfaces — nothing can derive it, so it is told
    expect(normalisePublicBase('gcp.jupyter.identifier27276', 7345)).toBe(
      'http://gcp.jupyter.identifier27276:7345/',
    );
  });

  it('leaves an explicit port, a path prefix or https alone', () => {
    expect(normalisePublicBase('workbench:8080', 7345)).toBe('http://workbench:8080/');
    expect(normalisePublicBase('https://lab.example.com/proxy/7345/', 7345)).toBe(
      'https://lab.example.com/proxy/7345/',
    );
    // https implies something is already listening on 443 in front of us
    expect(normalisePublicBase('https://lab.example.com', 7345)).toBe('https://lab.example.com/');
  });

  it('always ends in a single slash, so slugs append cleanly', () => {
    for (const spec of ['host', 'http://host:7345', 'http://host:7345/', 'https://h/p//']) {
      expect(normalisePublicBase(spec, 7345).endsWith('/'), spec).toBe(true);
      expect(normalisePublicBase(spec, 7345).endsWith('//'), spec).toBe(false);
    }
  });

  it('is the url everything else is built from, and outranks the guesses', () => {
    const where = reachableUrls('127.0.0.1', 7345, LAN, 'vm', 'gcp.jupyter.identifier27276');
    expect(where.declared).toBe(true);
    expect(where.urls[0]).toBe('http://gcp.jupyter.identifier27276:7345/');
    // and it is right even bound to loopback, because the proxy is what reaches us
    expect(where.unreachable).toEqual([]);
    expect(`${where.urls[0]}api-3f21b8/`).toBe(
      'http://gcp.jupyter.identifier27276:7345/api-3f21b8/',
    );
  });

  it('ignores an empty or unparseable value rather than printing nonsense', () => {
    expect(normalisePublicBase('   ', 7345)).toBe('');
    expect(reachableUrls('127.0.0.1', 7345, LAN, 'vm', '').declared).toBe(false);
  });
});

describe('working the address out from the environment', () => {
  it('derives a Codespaces url', () => {
    expect(
      detectPublicUrl(
        { CODESPACE_NAME: 'fluffy-space-8x2', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' },
        7345,
      ),
    ).toBe('https://fluffy-space-8x2-7345.app.github.dev/');
  });

  it('derives a Gitpod url, port in front of the workspace host', () => {
    expect(detectPublicUrl({ GITPOD_WORKSPACE_URL: 'https://abc123.ws-eu01.gitpod.io' }, 7345)).toBe(
      'https://7345-abc123.ws-eu01.gitpod.io/',
    );
  });

  it('derives a JupyterHub url through the user prefix and the port proxy', () => {
    expect(
      detectPublicUrl(
        { JUPYTERHUB_PUBLIC_URL: 'https://hub.example.com', JUPYTERHUB_SERVICE_PREFIX: '/user/malte/' },
        7345,
      ),
    ).toBe('https://hub.example.com/user/malte/proxy/7345/');
  });

  it('lets an explicit value win over anything derived', () => {
    expect(
      detectPublicUrl(
        { FLARE_PUBLIC_URL: 'my-vm.internal', GITPOD_WORKSPACE_URL: 'https://abc.gitpod.io' },
        7345,
      ),
    ).toBe('my-vm.internal');
  });

  it('finds nothing on an ordinary machine, which then uses its real addresses', () => {
    // a PC or a bare VM has a discoverable address; only a proxy in front
    // needs announcing, so falling through here is the correct answer
    expect(detectPublicUrl({}, 7345)).toBe('');
    expect(detectPublicUrl({ PATH: '/usr/bin', HOME: '/home/malte' }, 7345)).toBe('');
  });

  it('ignores a malformed workspace url instead of printing rubbish', () => {
    expect(detectPublicUrl({ GITPOD_WORKSPACE_URL: 'not a url' }, 7345)).toBe('');
  });
});
