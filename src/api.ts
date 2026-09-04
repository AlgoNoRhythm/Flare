import type { CoverageMap } from '../shared/coverage';
import type { ChangeBurst } from '../shared/activity';
import type { BurstEdit } from '../shared/conflicts';
import type { Board } from '../shared/tasks';
import type { UiState } from '../electron/services/store';
import type { AgentsSnapshot } from '../electron/services/roster';
import type { PostKind } from '../shared/channel';
import type { SessionSummary } from '../shared/session';
import type { SearchHit, SearchOptions } from '../shared/search';
import type { RecentEntry, SessionRedirect } from '../electron/core';
import { createWebTransport } from './webTransport';
import type {
  ChangeEvent,
  CommandLogEntry,
  FileTreeNode,
  GitStatus,
  GraphPatch,
  NodeDetails,
  ProjectInfo,
  ReviewState,
  ShadowSnapshot,
  SymbolGraph,
} from '../shared/types';

/** One level of the filesystem, for picking a project folder. */
export interface DirListing {
  path: string;
  /** null at the filesystem root */
  parent: string | null;
  home: string;
  dirs: { name: string; path: string; project: boolean }[];
  error: string | null;
}

export interface ReviewInfo {
  review: ReviewState;
  changedAt: Record<string, number>;
  changedBy: Record<string, string>;
}

export interface FlareApi {
  openProjectDialog(): Promise<ProjectInfo | null>;
  /** `detached` opens it beside this one — a second window, or a second tab */
  openProject(root: string, detached?: boolean): Promise<ProjectInfo | null>;
  getProject(): Promise<ProjectInfo | null>;
  readFile(rel: string): Promise<string | null>;
  readFileDataUrl(rel: string): Promise<string | null>;
  writeFile(rel: string, content: string): Promise<boolean>;
  /** find text across every scanned file — see shared/search */
  searchText(query: string, options?: SearchOptions): Promise<SearchHit[]>;
  /** replace across the files the same query hits, or just `paths` */
  searchReplace(
    query: string,
    replacement: string,
    options?: SearchOptions,
    paths?: string[],
  ): Promise<{ files: number; replacements: number }>;
  createFile(rel: string): Promise<boolean>;
  createDir(rel: string): Promise<boolean>;
  rescan(): Promise<void>;
  renameFile(from: string, to: string): Promise<boolean>;
  deleteFiles(rels: string[]): Promise<boolean>;
  gitStatus(): Promise<GitStatus | null>;
  gitShowHead(rel: string): Promise<string | null>;
  nodeDetails(id: string): Promise<NodeDetails | null>;
  symbolGraph(id: string): Promise<SymbolGraph | null>;
  gitChurn(): Promise<Record<string, number>>;
  commandsGet(): Promise<CommandLogEntry[]>;
  coverageGet(): Promise<CoverageMap>;
  shadowTimeline(limit?: number): Promise<ShadowSnapshot[]>;
  shadowShow(hash: string, rel: string): Promise<string | null>;
  shadowRestoreFile(hash: string, rel: string): Promise<boolean>;
  shadowRestoreAll(hash: string): Promise<boolean>;
  reviewGet(): Promise<ReviewInfo | null>;
  reviewApprove(paths: string[]): Promise<ReviewInfo | null>;
  reviewCheckpoint(): Promise<ReviewInfo | null>;
  mcpInfo(): Promise<{ port: number; slug: string | null }>;
  recentsGet(): Promise<RecentEntry[]>;
  recentsForget(root: string): Promise<RecentEntry[]>;
  browseDir(at?: string): Promise<DirListing>;
  /** create a folder and open it as a project; resolves to an error to show */
  createProject(parent: string, name: string, detached?: boolean): Promise<{ error: string } | null>;
  revealFile(rel: string): Promise<boolean>;
  activityGet(): Promise<ChangeBurst[]>;
  activityIntent(goal: string, ruledOut?: string): Promise<boolean>;
  activityLastGreen(): Promise<{ hash: string; at: number } | null>;
  /** which lines each burst wrote — what lets a conflict say "12 of 14 lines" */
  activityEdits(): Promise<BurstEdit[]>;
  markRead(paths: string[]): Promise<boolean>;
  /** who is connected over MCP, and what they have said to each other */
  agentsGet(): Promise<AgentsSnapshot>;
  /** what each agent says it did this session */
  summariesGet(): Promise<SessionSummary[]>;
  /** post into the same channel the agents coordinate in */
  agentsSay(input: {
    text: string;
    kind?: PostKind;
    paths?: string[];
    to?: string | null;
  }): Promise<boolean>;
  boardGet(): Promise<Board | null>;
  boardSet(board: Board): Promise<boolean>;
  boardFormat(taskId: string): Promise<string | null>;
  uiLoad(): Promise<UiState>;
  uiSave(ui: UiState): Promise<boolean>;
  collapsedLoad(): Promise<string[] | null>;
  collapsedSave(dirs: string[]): Promise<boolean>;
  positionsLoad(): Promise<Record<string, { x: number; y: number }>>;
  positionsSave(positions: Record<string, { x: number; y: number }>): Promise<boolean>;
  ptyCreate(id: string, cols: number, rows: number, cwd?: string): Promise<boolean>;
  ptyWrite(id: string, data: string): void;
  ptyResize(id: string, cols: number, rows: number): void;
  ptyDispose(id: string): Promise<boolean>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  clipboardWrite(text: string): Promise<boolean>;
  clipboardRead(): Promise<string>;
  connection(): ConnectionState;
  onConnection(watcher: (state: ConnectionState) => void): () => void;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

/**
 * Is there a backend on the other end?
 *
 * Only meaningful for the browser transport — Electron IPC is either there
 * or the window does not exist. Without it the UI cannot tell an empty
 * answer from an unanswered one, and reports "no such folder" for a page
 * that is simply not talking to a Flare server.
 */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * How the app reaches its backend: a channel in, a result out, plus a stream
 * of events. The desktop preload implements it over Electron IPC and the
 * browser build over a websocket, and nothing above this line changes between
 * the two.
 */
export interface FlareTransport {
  kind: 'desktop' | 'web';
  /** absent on desktop, where the answer is always "open" */
  status?: {
    get(): ConnectionState;
    subscribe(watcher: (state: ConnectionState) => void): () => void;
  };
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /**
   * The same call with no answer wanted.
   *
   * A keystroke is the case: nothing waits on it, and over a network an
   * acknowledgement per key is a frame back for every frame out — the return
   * half of a round trip spent on a `true` nobody reads. A transport that
   * leaves this out gets `invoke` with the result dropped.
   */
  notify?(channel: string, args: unknown[]): void;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

/**
 * The one place a method name becomes a channel name.
 *
 * Both builds call this with their own transport, so an endpoint added to the
 * core shows up here once and is then available everywhere Flare runs.
 */
export function createApi(t: FlareTransport): FlareApi {
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    t.invoke(channel, args) as Promise<T>;
  const send = (channel: string, ...args: unknown[]): void => {
    if (t.notify) t.notify(channel, args);
    else void t.invoke(channel, args);
  };

  /**
   * Follow a project to the session that owns it.
   *
   * Served over the network a project is a process with its own URL, so
   * opening one is a navigation rather than a state change. Sessions live one
   * level down — `<base>/<slug>/` — and `<base>` is whatever prefix a proxy
   * put in front of us, so the hop is worked out from the page's own URL:
   * drop the current slug when we are inside a session, keep the path when we
   * are on the start screen.
   */
  const sessionUrl = async (slug: string): Promise<string> => {
    const here = await call<{ slug: string | null } | null>('mcp:info');
    const dir = new URL('.', window.location.href);
    const base = here?.slug ? new URL('..', dir) : dir;
    return new URL(`${slug}/`, base).toString();
  };

  /**
   * Claim the second tab now, while the click is still the reason we are here.
   *
   * Starting a session takes as long as scanning the project, and a browser
   * only lets a page open a tab as the direct consequence of a gesture — by
   * the time the slug came back, `window.open` was a popup and got blocked. So
   * the tab is opened empty and pointed at the session once there is one.
   * `noopener` is deliberately absent: with it, `window.open` returns null and
   * there would be no handle to aim.
   */
  const reserveTab = (detached: boolean): Window | null =>
    detached && t.kind === 'web' ? window.open('', '_blank') : null;

  /**
   * What came back from an open, whichever way it was asked for.
   *
   * `redirect` is a served session's slug; `detached` says it was asked for
   * beside this one rather than in place of it; `opened` is the desktop saying
   * it launched a second window and there is nothing here left to do.
   */
  const settleOpen = async (
    result: ProjectInfo | (SessionRedirect & { detached?: boolean }) | { opened: true } | null,
    tab: Window | null,
  ): Promise<ProjectInfo | null> => {
    if (result && 'opened' in result) {
      tab?.close();
      return null;
    }
    if (result && 'redirect' in result) {
      const url = await sessionUrl(result.redirect);
      if (result.detached) {
        // the project in this tab keeps its terminals, its agents and its
        // place on the graph
        if (tab) tab.location.href = url;
        else window.open(url, '_blank');
        return null;
      }
      window.location.assign(url);
      // this page is being replaced, so nothing waiting on the open should
      // run — and a caller that sees `null` can trust it means "did not open"
      return new Promise<null>(() => undefined);
    }
    tab?.close();
    return result;
  };

  const openProject = async (root: string, detached = false): Promise<ProjectInfo | null> => {
    const tab = reserveTab(detached);
    return settleOpen(
      await call<ProjectInfo | SessionRedirect | { opened: true } | null>(
        'project:open',
        root,
        detached,
      ),
      tab,
    );
  };

  return {
    openProjectDialog: () => call('project:openDialog'),
    openProject,
    getProject: () => call('project:get'),

    readFile: (rel) => call('file:read', rel),
    readFileDataUrl: (rel) => call('file:readDataUrl', rel),
    writeFile: (rel, content) => call('file:write', rel, content),
    searchText: (query, options) => call('search:text', query, options ?? {}),
    searchReplace: (query, replacement, options, paths) =>
      call('search:replace', query, replacement, options ?? {}, paths),
    createFile: (rel) => call('file:create', rel),
    createDir: (rel) => call('dir:create', rel),
    rescan: () => call('project:rescan'),
    renameFile: (from, to) => call('file:rename', from, to),
    deleteFiles: (rels) => call('file:delete', rels),
    revealFile: (rel) => call('file:reveal', rel),

    gitStatus: () => call('git:status'),
    gitShowHead: (rel) => call('git:showHead', rel),
    gitChurn: () => call('git:churn'),

    nodeDetails: (id) => call('node:details', id),
    symbolGraph: (id) => call('node:symbolGraph', id),
    commandsGet: () => call('commands:get'),
    coverageGet: () => call('coverage:get'),

    activityGet: () => call('activity:get'),
    activityIntent: (goal, ruledOut) => call('activity:intent', goal, ruledOut),
    activityLastGreen: () => call('activity:lastGreen'),
    activityEdits: () => call('activity:edits'),
    markRead: (paths) => call('review:markRead', paths),
    agentsGet: () => call('agents:get'),
    summariesGet: () => call('summaries:get'),
    agentsSay: (input) => call('agents:say', input),
    boardGet: () => call('board:get'),
    boardSet: (board) => call('board:set', board),
    boardFormat: (taskId) => call('board:format', taskId),

    shadowTimeline: (limit) => call('shadow:timeline', limit),
    shadowShow: (hash, rel) => call('shadow:show', hash, rel),
    shadowRestoreFile: (hash, rel) => call('shadow:restoreFile', hash, rel),
    shadowRestoreAll: (hash) => call('shadow:restoreAll', hash),

    reviewGet: () => call('review:get'),
    reviewApprove: (paths) => call('review:approve', paths),
    reviewCheckpoint: () => call('review:checkpoint'),

    mcpInfo: () => call('mcp:info'),
    recentsGet: () => call('recents:get'),
    recentsForget: (root) => call('recents:forget', root),
    browseDir: (at) => call('dir:browse', at),
    createProject: async (parent, name, detached = false) => {
      const tab = reserveTab(detached);
      const result = await call<
        ProjectInfo | SessionRedirect | { opened: true } | { error: string } | null
      >('project:create', parent, name, detached);
      if (result && 'error' in result) {
        tab?.close();
        return result;
      }
      await settleOpen(result as Parameters<typeof settleOpen>[0], tab);
      return null;
    },

    uiLoad: () => call('ui:load'),
    uiSave: (ui) => call('ui:save', ui),
    collapsedLoad: () => call('collapsed:load'),
    collapsedSave: (dirs) => call('collapsed:save', dirs),
    positionsLoad: () => call('positions:load'),
    positionsSave: (positions) => call('positions:save', positions),

    ptyCreate: (id, cols, rows, cwd) => call('pty:create', id, cols, rows, cwd),
    // keystrokes and resizes are fire-and-forget: nothing awaits them, so
    // nothing is sent back for them either
    ptyWrite: (id, data) => send('pty:write', id, data),
    ptyResize: (id, cols, rows) => send('pty:resize', id, cols, rows),
    ptyDispose: (id) => call('pty:dispose', id),

    windowControl: (action) => void call('window:control', action),
    // In a tab the clipboard worth writing to is the viewer's, not the one on
    // the machine running the backend. The backend still keeps a copy, which
    // is what `clipboardRead` serves for paste inside the app.
    clipboardWrite: (text) => {
      if (t.kind === 'web') void navigator.clipboard?.writeText(text).catch(() => undefined);
      return call('clipboard:write', text);
    },
    clipboardRead: () => call('clipboard:read'),

    connection: () => t.status?.get() ?? 'open',
    onConnection: (watcher) => t.status?.subscribe(watcher) ?? (() => undefined),
    on: (channel, listener) => t.on(channel, listener),
  };
}

declare global {
  interface Window {
    /** the Electron preload's bridge; absent in a browser tab */
    flare?: FlareTransport;
  }
}

/**
 * The entire difference between the desktop app and the browser: which
 * transport is there. Everything above this line is shared.
 */
export const api: FlareApi = createApi(window.flare ?? createWebTransport());

/**
 * Whether a native shell is behind the app.
 *
 * The window buttons, the folder picker and "reveal in file manager" have no
 * meaning in a browser tab. This is the transport's own identity rather than
 * anything sniffed from the environment: the desktop bridge exists exactly
 * when `electron/main.ts` supplied the core with a host that implements them.
 */
export const isDesktop = window.flare?.kind === 'desktop';

export type { AgentsSnapshot };
export type { ChangeEvent, FileTreeNode, GitStatus, GraphPatch, NodeDetails, ProjectInfo, ShadowSnapshot };
