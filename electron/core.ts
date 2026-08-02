import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectSession } from './session';
import { PtyService } from './services/pty';
import { AgentMonitor } from './services/agents';
import { McpServer } from './services/mcp';
import { McpRegistry } from './services/mcpRegistry';
import { SlugBook } from './services/slugs';
import type { EventChannel } from '../shared/channels';
import type { Board } from '../shared/tasks';
import type { ProjectInfo } from '../shared/types';

/**
 * Everything Flare does, with no window and no Electron.
 *
 * This is the *only* implementation. The desktop app and the browser server
 * are transports: they translate a request into `handle(channel, args)` and
 * push `onEvent` back out. Neither knows a single channel name, so a feature
 * added here reaches both without a second edit — there is no desktop copy and
 * web copy to keep in step.
 *
 * The handful of things that genuinely need a desktop — a native folder
 * picker, the OS clipboard, the window buttons — arrive as optional `CoreHost`
 * callbacks. Their channels always exist and degrade quietly when no host
 * supplied them, rather than existing in one build and missing from the other.
 */

/** A previously opened project, newest first in `Settings.recents`. */
export interface RecentEntry {
  path: string;
  openedAt: number;
}

export interface Settings {
  lastProject?: string;
  /** older builds wrote bare strings; both shapes are read */
  recents?: (string | RecentEntry)[];
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
}

/** The parts of the experience only a native shell can provide. */
export interface CoreHost {
  /** native directory picker; without it the UI falls back to typing a path */
  pickDirectory?(): Promise<string | null>;
  /** show a file in Explorer/Finder/the file manager */
  revealInFolder?(abs: string): void;
  clipboardWrite?(text: string): void;
  clipboardRead?(): string;
  windowControl?(action: 'minimize' | 'maximize' | 'close'): void;
  /** the shell may want to retitle itself when a project opens */
  onProjectOpened?(info: ProjectInfo): void;
  /**
   * Start — or find — a separate session for a project, and say where it is.
   *
   * Served over the network, a project is a process with a URL of its own, so
   * "open this folder" means "take me to its session" rather than "replace the
   * one in this process". A desktop window has nowhere to send you and leaves
   * this out, which is what makes `project:open` mean the right thing in both.
   */
  openSession?(root: string): Promise<string>;
  /**
   * Open a project in a second window, leaving this one alone.
   *
   * A window holds exactly one session — one watcher, one set of terminals,
   * one shadow history — so opening a project in the window you are in
   * necessarily closes the one you were working on, agents and all. On the
   * desktop the second window is a second process, which is the same shape
   * the served build already uses for its sessions.
   */
  openInNewWindow?(root: string): void;
}

/** What `project:open` answers when the project lives somewhere else. */
export interface SessionRedirect {
  redirect: string;
}


export interface CoreOptions {
  /** where settings, per-project stores and the shadow repo live */
  dataDir: string;
  onEvent(channel: EventChannel, payload: unknown): void;
  host?: CoreHost;
  /** the port the MCP gateway tries to own; ephemeral ports are per instance */
  mcpPort?: number;
  /** interface for that shared port; loopback unless a served build widens it */
  mcpHost?: string;
}

export interface Core {
  /** every channel a transport should expose, derived not declared */
  readonly channels: string[];
  handle(channel: string, args: unknown[]): Promise<unknown>;
  readonly mcp: McpServer;
  /** resolves once the MCP/UI ports are listening */
  readonly ready: Promise<void>;
  /**
   * The settings file, for the shell's own slice of it (window bounds and
   * maximized state). The core owns the file so there is one reader and one
   * writer, whichever shell is running.
   */
  readonly settings: { get(): Settings; set(patch: Partial<Settings>): void };
  dispose(): Promise<void>;
}

/** Handlers are called through `handle`, which validates nothing but the name. */
type Handler = (...args: any[]) => unknown;

export function createCore(options: CoreOptions): Core {
  const { dataDir, onEvent, host = {} } = options;

  let session: ProjectSession | null = null;

  const settingsFile = (): string => path.join(dataDir, 'settings.json');

  function loadSettings(): Settings {
    try {
      return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    } catch {
      return {};
    }
  }

  function saveSettings(patch: Partial<Settings>): void {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify({ ...loadSettings(), ...patch }));
    } catch {
      // best effort
    }
  }

  const ptys = new PtyService({
    onData: (id, data) => {
      // the session reads test verdicts out of this stream
      session?.noteTerminalOutput(id, data);
      onEvent('evt:ptyData', { id, data });
    },
    onExit: (id, exitCode) => onEvent('evt:ptyExit', { id, exitCode }),
  });

  const agentMonitor = new AgentMonitor(
    () => ptys.getPids(),
    (terminals) => onEvent('evt:agentStatus', { terminals }),
    (command) => {
      session?.recordCommand(command);
      onEvent('evt:agentCommand', command);
    },
    (pid) => session?.endCommand(pid),
  );
  agentMonitor.start(Number(process.env.FLARE_AGENT_POLL_MS) || 1200);

  const mcpServer = new McpServer(
    () => session,
    options.mcpPort ?? (Number(process.env.FLARE_MCP_PORT) || 7345),
    new McpRegistry(McpRegistry.defaultDir()),
    options.mcpHost,
    // remembered next to the rest of this install's state, so a project keeps
    // the same url across restarts and reboots
    new SlugBook(path.join(dataDir, 'slugs.json')),
  );
  const ready = mcpServer.start();

  /**
   * Read the recents list in either shape.
   *
   * Builds before this stored bare path strings. Those still open fine, they
   * just have no timestamp — dated to zero so they sort last rather than
   * claiming to be the newest thing you touched.
   */
  function normaliseRecents(raw: Settings['recents']): RecentEntry[] {
    return (raw ?? [])
      .map((entry) => (typeof entry === 'string' ? { path: entry, openedAt: 0 } : entry))
      .filter((entry) => typeof entry?.path === 'string')
      .sort((a, b) => b.openedAt - a.openedAt);
  }

  async function openProject(root: string): Promise<ProjectInfo> {
    if (session) await session.dispose();
    session = new ProjectSession(root, dataDir, {
      onGraphPatch: (patch) => onEvent('evt:graphPatch', patch),
      onFilesChanged: (event) => onEvent('evt:filesChanged', event),
      onGitStatus: (status) => onEvent('evt:gitStatus', status),
      onTreeChanged: (tree) => onEvent('evt:treeChanged', tree),
      onShadowSnapshot: (hash) => onEvent('evt:shadowSnapshot', hash),
      onCoverage: (coverage) => onEvent('evt:coverage', coverage),
      onActivity: (bursts) => onEvent('evt:activity', bursts),
      onCommandUpdate: (command) => onEvent('evt:commandUpdate', command),
      onDangerousCommand: (command) => onEvent('evt:dangerousCommand', command),
      onBoard: (board) => onEvent('evt:board', board),
    });
    session.attributionProvider = () => agentMonitor.attribution();
    const info = await session.open();
    const previous = normaliseRecents(loadSettings().recents).filter((r) => r.path !== root);
    const recents: RecentEntry[] = [{ path: root, openedAt: Date.now() }, ...previous].slice(0, 12);
    saveSettings({ lastProject: root, recents });
    mcpServer.updateProject(session.root, info.name);
    host.onProjectOpened?.(info);
    onEvent('evt:projectOpened', info);
    return info;
  }

  const handlers = new Map<string, Handler>();
  const on = (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  };

  on('project:openDialog', async () => {
    const picked = await host.pickDirectory?.();
    return picked ? openProject(picked) : null;
  });

  /**
   * Open a project here, or say where it lives.
   *
   * Served over the network a project is a session of its own, so "open" means
   * "go there"; in a window it means "open it in this one". Both callers below
   * need that distinction to work the same way.
   */
  const openOrRedirect = async (root: string, detached = false): Promise<unknown> => {
    /*
     * "Somewhere else" means a second window on the desktop and a second tab
     * in a browser, and only the desktop can do it from here — a tab has to be
     * opened by the page, so the served build gets the slug back and opens it
     * itself. Either way the session you are in is untouched.
     */
    if (detached && host.openInNewWindow) {
      host.openInNewWindow(root);
      return { opened: true };
    }
    if (host.openSession) return { redirect: await host.openSession(root), detached };
    return openProject(root);
  };

  on('project:open', async (root: string, detached?: boolean) => {
    if (typeof root !== 'string' || !fs.existsSync(root)) return null;
    return openOrRedirect(root, detached === true);
  });

  /**
   * Start a project in a folder that does not exist yet.
   *
   * Opening a repository you already have and starting something from nothing
   * are different intentions, and only one of them was reachable — "open this
   * folder" cannot create one. The folder is made here rather than left to the
   * agent, so the graph, the watcher and the shadow history are all running
   * before the first file is written.
   */
  on('project:create', async (parent: string, name: string, detached?: boolean) => {
    if (typeof parent !== 'string' || typeof name !== 'string') return { error: 'bad request' };
    const clean = name.trim();
    if (clean === '') return { error: 'give the project a folder name' };
    if (/[\\/]/.test(clean) || clean === '.' || clean === '..') {
      return { error: 'a name, not a path — no slashes' };
    }
    const root = path.join(path.resolve(parent), clean);
    if (fs.existsSync(root)) {
      const taken = fs.readdirSync(root).length > 0;
      if (taken) return { error: `${clean} already exists here and is not empty` };
    } else {
      try {
        fs.mkdirSync(root, { recursive: true });
      } catch (err) {
        return { error: `could not create it: ${(err as Error).message}` };
      }
    }
    return openOrRedirect(root, detached === true);
  });

  /**
   * List the folders inside one folder, for picking a project.
   *
   * Typing an absolute path is fine when you already know it and hopeless when
   * you do not — and on a served instance the filesystem being browsed is on
   * the far machine, where no native dialog can reach. Directories only: the
   * question is always "which project", never "which file". A folder that
   * looks like a repository is marked, so the answer is usually one glance
   * rather than a hunt.
   */
  on('dir:browse', (at?: string) => {
    const home = os.homedir();
    const target = typeof at === 'string' && at !== '' ? path.resolve(at) : (session?.root ?? home);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return { path: target, parent: null, home, dirs: [], error: 'cannot read that folder' };
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        const full = path.join(target, e.name);
        const marks = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];
        return {
          name: e.name,
          path: full,
          project: marks.some((m) => fs.existsSync(path.join(full, m))),
        };
      })
      .sort((a, b) => Number(b.project) - Number(a.project) || a.name.localeCompare(b.name));
    const parent = path.dirname(target);
    return { path: target, parent: parent === target ? null : parent, home, dirs, error: null };
  });

  on('project:get', async () => {
    if (!session) return null;
    const info = session.getProjectInfo();
    const git = await session.git.status();
    return { ...info, git };
  });

  on('file:read', (rel: string) => session?.readFile(rel) ?? null);
  on('file:readDataUrl', (rel: string) => session?.readFileDataUrl(rel) ?? null);
  on('file:write', (rel: string, content: string) =>
    session ? session.writeFile(rel, content) : false,
  );
  on('file:create', (rel: string) => session?.createFile(rel) ?? false);
  on('dir:create', (rel: string) => session?.createDir(rel) ?? false);
  on('project:rescan', () => session?.refreshFromDisk() ?? Promise.resolve());
  on('file:rename', (from: string, to: string) => session?.renameFile(from, to) ?? false);
  on('file:delete', (rels: string[]) => (session ? session.deleteFiles(rels) : false));

  on('git:status', () => session?.git.status() ?? null);
  on('git:showHead', (rel: string) => session?.git.showHead(rel) ?? null);

  on('node:details', (id: string) => session?.nodeDetails(id) ?? null);
  on('node:symbolGraph', (id: string) => session?.symbolGraph(id) ?? null);
  on('git:churn', () => session?.git.churn() ?? {});
  on('commands:get', () => session?.commands ?? []);
  on('activity:get', () => session?.getBursts() ?? []);
  on('activity:intent', (goal: string, ruledOut?: string) => {
    session?.setIntent(goal, ruledOut, 'you');
    return true;
  });
  on('activity:lastGreen', () => session?.lastGreenSnapshot() ?? null);
  on('board:get', () => session?.getBoard() ?? null);
  on('board:set', (board: Board) => {
    session?.setBoard(board);
    return true;
  });
  on('board:format', (taskId: string) => session?.formatTask(taskId) ?? null);
  on('review:markRead', (paths: string[]) => {
    session?.markRead(paths);
    return true;
  });
  on('coverage:get', () => session?.coverage ?? {});

  on('shadow:timeline', (limit?: number) => session?.shadow.timeline(limit) ?? []);
  on('shadow:show', (hash: string, rel: string) => session?.shadow.show(hash, rel) ?? null);
  on('shadow:restoreFile', (hash: string, rel: string) =>
    session?.shadow.restoreFile(hash, rel) ?? false,
  );
  on('shadow:restoreAll', (hash: string) => session?.shadow.restoreAll(hash) ?? false);

  on('review:get', () => session?.getReviewInfo() ?? null);
  on('review:approve', (paths: string[]) => {
    session?.store.approve(paths);
    return session?.getReviewInfo() ?? null;
  });
  on('review:checkpoint', () => {
    session?.store.checkpoint();
    return session?.getReviewInfo() ?? null;
  });

  on('mcp:info', () => ({ port: mcpServer.publicPort, slug: mcpServer.slug }));
  on('recents:get', () =>
    normaliseRecents(loadSettings().recents).filter((r) => fs.existsSync(r.path)),
  );
  on('recents:forget', (root: string) => {
    const recents = normaliseRecents(loadSettings().recents).filter((r) => r.path !== root);
    saveSettings({ recents });
    return recents.filter((r) => fs.existsSync(r.path));
  });

  on('file:reveal', (rel: string) => {
    if (!session || !host.revealInFolder) return false;
    const abs = path.join(session.root, rel);
    if (!fs.existsSync(abs)) return false;
    host.revealInFolder(abs);
    return true;
  });

  on('ui:load', () => session?.store.ui ?? {});
  on('ui:save', (ui: Record<string, unknown>) => {
    session?.store.setUi(ui);
    return true;
  });
  on('collapsed:load', () => session?.store.collapsedDirs ?? null);
  on('collapsed:save', (dirs: string[]) => {
    session?.store.setCollapsedDirs(dirs);
    return true;
  });
  on('positions:load', () => session?.store.positions ?? {});
  on('positions:save', (positions: Record<string, { x: number; y: number }>) => {
    session?.store.mergePositions(positions);
    return true;
  });

  // The Windows clipboard service can wedge system-wide (cbdhsvc); keep the
  // last written text so in-app reads still work while the OS misbehaves. In a
  // browser tab there is no host clipboard at all and this *is* the clipboard
  // for in-app copies, with the page falling back to the async clipboard API.
  let lastClipboardWrite = '';
  on('clipboard:write', (text: string) => {
    lastClipboardWrite = String(text);
    try {
      host.clipboardWrite?.(lastClipboardWrite);
    } catch {
      // OS clipboard unavailable — the fallback below still serves reads
    }
    return true;
  });
  on('clipboard:read', () => {
    try {
      const text = host.clipboardRead?.() ?? '';
      if (text !== '') return text;
    } catch {
      // fall through
    }
    return lastClipboardWrite;
  });

  on('window:control', (action: 'minimize' | 'maximize' | 'close') => {
    host.windowControl?.(action);
    return true;
  });


  on('pty:create', (id: string, cols: number, rows: number, cwd?: string) => {
    const root = session?.root ?? os.homedir();
    // a requested cwd is a project-relative directory; anything that escapes
    // the project or no longer exists falls back to the project root
    let dir = root;
    if (typeof cwd === 'string' && cwd !== '' && session) {
      const abs = path.resolve(root, cwd);
      if ((abs === root || abs.startsWith(root + path.sep)) && fs.existsSync(abs)) {
        dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      }
    }
    ptys.create(id, dir, cols, rows);
    return true;
  });
  on('pty:write', (id: string, data: string) => {
    ptys.write(id, data);
    return true;
  });
  on('pty:resize', (id: string, cols: number, rows: number) => {
    ptys.resize(id, cols, rows);
    return true;
  });
  on('pty:dispose', (id: string) => {
    ptys.dispose(id);
    return true;
  });

  return {
    channels: [...handlers.keys()],
    async handle(channel: string, args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`unknown channel: ${channel}`);
      return handler(...args);
    },
    mcp: mcpServer,
    ready,
    settings: { get: loadSettings, set: saveSettings },
    async dispose(): Promise<void> {
      agentMonitor.stop();
      mcpServer.stop();
      ptys.disposeAll();
      if (session) await session.dispose();
      session = null;
    },
  };
}
