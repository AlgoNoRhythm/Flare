import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCore, type Core, type CoreHost } from '../electron/core';
import { WebUi } from './web';
import { detectPublicUrl, reachableUrls } from './urls';

/**
 * `flare serve` — the same IDE, reachable from a browser.
 *
 * Written for any machine that is not the one you are sitting at, and
 * especially for the ones you cannot install a desktop app on: a VM, a dev
 * container, a build box, a cloud workstation. The backend has to run *there*,
 * because the thing Flare does that nothing else does — attributing a change
 * to the agent that made it, and knowing what that agent ran — comes from
 * watching the process tree under its own terminals.
 *
 * Two roles, one binary:
 *
 * - a **supervisor** holds the shared port and serves the start screen at `/`.
 *   It has no project of its own; picking one starts a session for it.
 * - a **session** is one project in one process, at `/<slug>/`, with a slug
 *   that stays the same across restarts.
 *
 * Sessions are separate processes on purpose: a browser tab per project, each
 * with its own terminals and its own agents, and no way for one to disturb
 * another. `--session` is how a supervisor starts one; you never type it.
 *
 * Everything either role does is `electron/core.ts`, unchanged and
 * unduplicated — the browser reaches it over a websocket instead of Electron's
 * IPC.
 */

interface Args {
  root: string | null;
  port: number | undefined;
  host: string | undefined;
  publicUrl: string | undefined;
  /** true when a supervisor started us for one project */
  session: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const rest: string[] = [];
  let port: number | undefined;
  let host: string | undefined;
  let publicUrl: string | undefined;
  let session = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--session') session = true;
    else if (arg === '--port' || arg === '-p') port = Number(argv[(i += 1)]);
    else if (arg.startsWith('--port=')) port = Number(arg.slice('--port='.length));
    else if (arg === '--host') host = argv[(i += 1)];
    else if (arg.startsWith('--host=')) host = arg.slice('--host='.length);
    else if (arg === '--public-url') publicUrl = argv[(i += 1)];
    else if (arg.startsWith('--public-url=')) publicUrl = arg.slice('--public-url='.length);
    else rest.push(arg);
  }
  return { root: rest[0] ? path.resolve(rest[0]) : null, port, host, publicUrl, session, help };
}

const USAGE = `flare serve — Flare in a browser, backend on the machine with the code

  node dist-server/index.cjs [project] [--port 7345] [--host 0.0.0.0]

  project   open this folder straight away (optional — without it you get the
            start screen and pick from there)
  --port    the shared port everything is served from (default 7345, or
            $FLARE_PORT)
  --host    interface to listen on (default 127.0.0.1, or $FLARE_HOST). Use
            0.0.0.0 to reach it from another machine directly, at the address
            printed on startup. Flare has no login of its own, so only do that
            on a network you trust — see below.
  --public-url
            the address YOU reach this machine at. Codespaces, Gitpod and
            JupyterHub are detected automatically; an ordinary machine uses its
            own hostname and addresses. Pass this for anything else fronted by
            a proxy Flare cannot see. $FLARE_PUBLIC_URL.
              --public-url my-vm.corp.example
                → http://my-vm.corp.example:7345/<slug>/
              --public-url https://lab.example.com/proxy/7345/
                → https://lab.example.com/proxy/7345/<slug>/

Open the port in a browser and you get Flare's start screen. Picking a project
starts a session for it and takes you to its own URL, /<project-slug>/, which
stays the same across restarts. Each project is its own process, so you can
keep several open in several tabs. Agents connect to the same port at
/mcp/<slug>.

Reaching it from your laptop, safest first:
  ssh -L 7345:127.0.0.1:7345 you@machine     # nothing exposed, works anywhere
  your cloud IDE's port forwarding, or a reverse proxy in front
  --host 0.0.0.0                             # direct, and unauthenticated

State lives in ~/.flare (override with $FLARE_USERDATA).`;

/** Where this bundle lives, so a supervisor can start more of itself. */
const ENTRY = process.argv[1];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.root !== null && !fs.existsSync(args.root)) {
    console.error(`no such folder: ${args.root}`);
    process.exitCode = 1;
    return;
  }

  const dataDir = process.env.FLARE_USERDATA ?? path.join(os.homedir(), '.flare');
  const publicPort = args.port ?? (Number(process.env.FLARE_PORT) || undefined);
  const bindHost = args.host ?? process.env.FLARE_HOST ?? '127.0.0.1';
  // told, or worked out from a hosted environment that announces itself
  const publicUrl = args.publicUrl ?? detectPublicUrl(process.env, Number(publicPort ?? process.env.FLARE_MCP_PORT ?? 7345));
  const web = new WebUi(path.join(__dirname, '..', 'dist'));

  let core: Core;

  /**
   * Start a session for a project, or point at the one already running.
   *
   * Re-opening something that is already up has to land on the same session —
   * otherwise two processes would watch one folder and both claim its slug.
   */
  const openSession = async (root: string): Promise<string> => {
    const slug = core.mcp.slugFor(root);
    if (core.mcp.sessions().some((s) => s.slug === slug)) return slug;

    const child = spawn(
      process.execPath,
      [
        ENTRY, root, '--session',
        '--port', String(core.mcp.publicPort),
        '--host', bindHost,
        ...(publicUrl ? ['--public-url', publicUrl] : []),
      ],
      { env: process.env, stdio: 'ignore' },
    );
    child.unref();

    // wait for it to register rather than guessing how long a scan takes
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (core.mcp.sessions().some((s) => s.slug === slug)) return slug;
      if (child.exitCode !== null) throw new Error(`session for ${root} exited on startup`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`session for ${root} did not start in time`);
  };

  /*
   * No native dialog, clipboard or window frame in a tab. The one capability a
   * served Flare has that a window does not is somewhere else to send you —
   * and it is filled in below rather than here, because a session has to open
   * its *own* project in-process first. Were `openSession` already set, that
   * first open would redirect, and the session would spawn a session for
   * itself, for ever.
   */
  const host: CoreHost = {};

  core = createCore({
    dataDir,
    mcpPort: publicPort,
    mcpHost: bindHost,
    onEvent: (channel, payload) => web.broadcast(channel, payload),
    host,
  });
  web.attach(core);
  core.mcp.mount(web);
  await core.ready;

  const where = reachableUrls(bindHost, core.mcp.publicPort, undefined, undefined, publicUrl);
  const primary = where.urls[0];

  if (args.session) {
    // one project, this process, its own URL
    await core.handle('project:open', [args.root]);
    host.openSession = openSession;
    console.log(`Flare session — ${args.root}`);
    console.log(`  UI    ${primary}${core.mcp.slug}/`);
    console.log(`  MCP   ${primary}mcp/${core.mcp.slug}`);
  } else {
    host.openSession = openSession;
    console.log(`Flare — ${primary}`);
    for (const url of where.urls.slice(1)) console.log(`        ${url}`);
    if (!(await core.mcp.gatewayDecided)) {
      console.log('  (another Flare already holds that port; its start screen is the live one)');
    }
    if (where.exposed) {
      console.log('  ! listening beyond this machine, and Flare has no login: anyone who can');
      console.log('    reach that address gets your files and a shell. Trusted networks only.');
    } else if (!where.declared && where.unreachable.length > 0) {
      // the whole point of serving is that you are not sitting at this machine,
      // so say plainly that the loopback URL will not help from anywhere else
      console.log('  reachable from this machine only. From your laptop, either');
      console.log(`    ssh -L ${core.mcp.publicPort}:127.0.0.1:${core.mcp.publicPort} you@${os.hostname()}`);
      console.log(`    or restart with --host 0.0.0.0 for ${where.unreachable[0]}`);
    }
    if (!where.declared) {
      // a proxy in front of this machine has a hostname the machine cannot see
      console.log('  behind a proxy or a managed notebook? --public-url <your-host> and every');
      console.log('  url printed here, slugs included, is built from it.');
    }
    if (args.root !== null) {
      const slug = await openSession(args.root);
      console.log(`  ${path.basename(args.root)} → ${primary}${slug}/`);
    } else {
      console.log('  open it to pick a project — each one gets its own url');
    }
  }

  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    // a wedged pty or watcher must never keep the process alive
    const force = setTimeout(() => process.exit(0), 2500);
    void (async () => {
      web.close();
      await core.dispose();
      clearTimeout(force);
      process.exit(0);
    })();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
