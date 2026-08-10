import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  CommandLogEntry,
  FileTreeNode,
  GitStatus,
  GraphEdge,
  GraphNode,
  GraphPatch,
  ProjectInfo,
  ShadowSnapshot,
  SymbolGraph,
} from '../shared/types';
import type { CoverageMap } from '../shared/coverage';
import type { ReviewInfo } from './api';
import { api, isDesktop } from './api';
import { DetailsPanel } from './components/DetailsPanel';
import { StartScreen } from './components/StartScreen';
import { NewProjectDialog } from './components/NewProjectDialog';
import { FlareMark } from './components/FlareMark';
import { GraphEmpty } from './components/GraphEmpty';
import { CanvasTools } from './components/CanvasTools';
import { MCP_TARGETS, mcpUrl } from './components/McpConnect';
import type { RecentEntry } from '../electron/core';
import { DiffPane } from './components/DiffPane';
import { EditorPane } from './components/EditorPane';
import { DocumentPane } from './components/DocumentPane';
import { previewKindFor } from '../shared/preview';
import { plural } from './format';
import { FileTree, type FileTreeHandle } from './components/FileTree';
import {
  CanvasView,
  type CanvasProps,
  type GraphStats,
  type GraphViewHandle,
} from './components/CanvasView';
import { WheelView } from './components/WheelView';
import { DistrictsView } from './components/DistrictsView';
import { LensLegend } from './components/LensLegend';
import { HelpOverlay } from './components/HelpOverlay';
import { MenuBar, tidySeparators, type MenuDef } from './components/MenuBar';
import { Splitter } from './components/Splitter';
import { TerminalPanel } from './components/TerminalPanel';
import { Timeline } from './components/Timeline';
import { CommandPalette, type PaletteItem } from './components/CommandPalette';
import { InsightsPanel } from './components/InsightsPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { BoardPanel } from './components/BoardPanel';
import { boardSummary, createTask, emptyBoard, type Board } from '../shared/tasks';
import type { ChangeBurst } from '../shared/activity';
import { unverifiedCount } from '../shared/activity';
import { computeInsights, type Insights } from '../shared/insights';
import { ContextMenu, Modal, type MenuItem, type ModalRequest } from './components/Menus';
import { Toasts, toast } from './components/Toasts';
import { RiskAlerts } from './components/RiskAlerts';
import { riskAlerts, type RiskAlert } from '../shared/riskAlerts';
import { LENSES, riskScore, type Lens } from './graph/lenses';
import { buildLensContext, lensSignal } from './graph/lensColor';
import {
  DRILL_ABOVE,
  drillCount,
  foldDir,
  parseSymbolNode,
  unfoldDir,
} from './graph/renderModel';
import { formatPathsFlat, formatPathsTree } from '../shared/pathFormat';

const IS_MAC = navigator.platform.toUpperCase().includes('MAC');

/**
 * Leave room for macOS's traffic lights, which sit *inside* the window.
 *
 * Only the desktop window has them. The same page in a Safari tab on the same
 * Mac has a browser chrome of its own, so reserving the space there would just
 * be a gap where nothing is.
 */
const RESERVE_TRAFFIC_LIGHTS = isDesktop && IS_MAC;

/**
 * Above this many files, a freshly-opened project starts with its directories
 * folded into single cards. Below it, everything is shown: a small repo laid
 * out flat is the overview, and folding it hides the only thing on screen.
 */
const FOLD_ON_OPEN_ABOVE = 70;

/**
 * File-menu entries that need a native shell behind them.
 *
 * Not "recent": served over the network that still works, it just means
 * something slightly different — a project is a session with a url of its own,
 * so picking one takes you there rather than swapping it into this window.
 * "open" is the native folder dialog specifically, which a tab cannot show.
 */
const DESKTOP_ONLY_MENU = new Set(['open', 'reveal', 'exit']);

function WindowControls() {
  if (!isDesktop) return null; // a browser tab has its own frame
  if (RESERVE_TRAFFIC_LIGHTS) return null; // macOS draws its own
  return (
    <div className="window-controls">
      <button className="win-btn" onClick={() => api.windowControl('minimize')} title="Minimize">
        ─
      </button>
      <button className="win-btn" onClick={() => api.windowControl('maximize')} title="Maximize">
        ☐
      </button>
      <button className="win-btn close" onClick={() => api.windowControl('close')} title="Close">
        ✕
      </button>
    </div>
  );
}

interface Tab {
  key: string;
  kind: 'file' | 'diff';
  path: string;
  source?: 'head' | { hash: string };
}


type GraphViewKind = 'canvas' | 'wheel' | 'districts';

function edgeMapKey(e: GraphEdge): string {
  return `${e.source}\n${e.target}`;
}

export function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [fileTree, setFileTree] = useState<FileTreeNode | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [changedAt, setChangedAt] = useState<Record<string, number>>({});
  const [changedBy, setChangedBy] = useState<Record<string, string>>({});
  const [agentStatus, setAgentStatus] = useState<Record<string, string | null>>({});
  const [commands, setCommands] = useState<CommandLogEntry[]>([]);
  const [recentChanges, setRecentChanges] = useState<{ path: string; time: number; agent: string }[]>([]);
  const [churn, setChurn] = useState<Record<string, number>>({});
  const [coverage, setCoverage] = useState<CoverageMap>({});
  const [snapshots, setSnapshots] = useState<ShadowSnapshot[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [reviewInfo, setReviewInfo] = useState<ReviewInfo | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entries: { path: string; isDir: boolean }[] } | null>(null);
  const [modal, setModal] = useState<ModalRequest | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [lens, setLens] = useState<Lens>('clusters');
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(new Set());
  const [symbolGraphs, setSymbolGraphs] = useState<ReadonlyMap<string, SymbolGraph>>(new Map());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string>('graph');
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
  const [externalVersions, setExternalVersions] = useState<Record<string, number>>({});
  const [pendingLine, setPendingLine] = useState<Record<string, number>>({});
  const [showTimeline, setShowTimeline] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [graphVersion, setGraphVersion] = useState(0);
  const [stats, setStats] = useState<GraphStats>({ nodes: 0, edges: 0, clusters: [] });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [graphView, setGraphView] = useState<GraphViewKind>('canvas');
  const [zoomPct, setZoomPct] = useState(100);
  const [helpOpen, setHelpOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  /** canvas: a plain drag picks files rather than moving the view */
  const [selectMode, setSelectMode] = useState(false);
  /** the folder chips are put away; the summary row stays */
  const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [bursts, setBursts] = useState<ChangeBurst[]>([]);
  const [lastGreen, setLastGreen] = useState<{ hash: string; at: number } | null>(null);
  /**
   * Risky-change alerts the person has answered.
   *
   * In memory and per session, like the bursts they come from: this says "I
   * have seen that popup", which is not a fact worth persisting past the
   * changes it was about. Dismissing is deliberately *not* approving — the
   * review queue keeps its own, persisted, record of that.
   */
  const [dismissedAlerts, setDismissedAlerts] = useState<ReadonlySet<string>>(new Set());
  /** the review row an alert asked to be taken to */
  const [reviewFocus, setReviewFocus] = useState<string | null>(null);
  const [walk, setWalk] = useState<{ paths: string[]; index: number } | null>(null);
  const [board, setBoard] = useState<Board>(emptyBoard());
  const [openTerminalAt, setOpenTerminalAt] = useState<{ dir: string; nonce: number } | null>(null);
  const [viewReady, setViewReady] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [mcpInfo, setMcpInfo] = useState<{ port: number; slug: string | null }>({ port: 0, slug: null });
  const [sidebarWidth, setSidebarWidth] = useState(216);
  const [detailsWidth, setDetailsWidth] = useState(320);
  // The terminal takes a share of the window rather than a fixed 280px, so a
  // taller screen gives the graph the extra room instead of the shell.
  const [terminalHeight, setTerminalHeight] = useState(() =>
    Math.max(150, Math.min(300, Math.round(window.innerHeight * 0.2))),
  );

  const graphRef = useRef<GraphViewHandle | null>(null);
  const treeRef = useRef<FileTreeHandle | null>(null);
  const fullNodesRef = useRef<Map<string, GraphNode>>(new Map());
  const fullEdgesRef = useRef<Map<string, GraphEdge>>(new Map());
  const projectRef = useRef<ProjectInfo | null>(null);

  const resetForProject = useCallback((info: ProjectInfo) => {
    projectRef.current = info;
    setProject(info);
    setFileTree(info.fileTree);
    setGitStatus(info.git);
    setSelected(null);
    setFocusId(null);
    setTabs([]);
    setActiveTab('graph');
    setDirtyTabs(new Set());
    setShowTimeline(false);
    setLens('clusters');
    setExpandedFiles(new Set());
    setSymbolGraphs(new Map());
    fullNodesRef.current = new Map(info.graph.nodes.map((n) => [n.id, n]));
    fullEdgesRef.current = new Map(info.graph.edges.map((e) => [edgeMapKey(e), e]));
    setGraphVersion((v) => v + 1);
    // The graph mounts only once the collapse state is known, so the first
    // layout runs on the graph the user is actually going to see.
    setViewReady(false);
    void api.collapsedLoad().then((saved) => {
      if (saved !== null) {
        setCollapsedDirs(new Set(saved));
      } else {
        const counts = new Map<string, number>();
        for (const n of info.graph.nodes) {
          if (n.cluster !== '') counts.set(n.cluster, (counts.get(n.cluster) ?? 0) + 1);
        }
        // Folding everything was the old default, which meant every project —
        // including the ten-file one you opened to look at ten files — greeted
        // you with a handful of opaque folder cards. Fold only when the
        // unfolded graph genuinely cannot be read: past this many files the
        // cards no longer fit on screen at a legible zoom, so folding is the
        // difference between an overview and a wall of unreadable rectangles.
        const foldable = [...counts].filter(([, c]) => c >= 2);
        let initial = new Set(
          info.graph.nodes.length > FOLD_ON_OPEN_ABOVE ? foldable.map(([d]) => d) : [],
        );
        // A cluster holding most of the repo folds into a card with no edges at
        // all — every dependency it has is internal to it. Open those one level
        // so the first screen shows the shape of src/, not a single box.
        const paths = info.graph.nodes.map((n) => n.id);
        for (const [dir, count] of foldable) {
          if (initial.has(dir) && count > DRILL_ABOVE) initial = unfoldDir(initial, dir, paths);
        }
        setCollapsedDirs(initial);
      }
      setViewReady(true);
    });
    void api.reviewGet().then((r) => {
      if (r) {
        setReviewInfo(r);
        setChangedAt(r.changedAt);
        setChangedBy(r.changedBy);
      }
    });
    void api.gitChurn().then(setChurn);
    void api.commandsGet().then(setCommands);
    setWalk(null);
    setDismissedAlerts(new Set());
    setReviewFocus(null);
    void api.activityGet().then(setBursts);
    void api.boardGet().then((b) => b && setBoard(b));
    void api.activityLastGreen().then(setLastGreen);
    void api.coverageGet().then(setCoverage);
    void api.recentsGet().then(setRecents);
    void api.mcpInfo().then(setMcpInfo);
    // restore the previous session's workspace state for this project
    void api.uiLoad().then((ui) => {
      if (ui.lens) setLens(ui.lens as Lens);
      if (typeof ui.selectMode === 'boolean') setSelectMode(ui.selectMode);
      if (typeof ui.legendCollapsed === 'boolean') setLegendCollapsed(ui.legendCollapsed);
      if (ui.graphView === 'canvas' || ui.graphView === 'wheel' || ui.graphView === 'districts') {
        setGraphView(ui.graphView);
      }
      if (ui.sidebarWidth) setSidebarWidth(ui.sidebarWidth);
      if (ui.terminalHeight) setTerminalHeight(ui.terminalHeight);
      if (ui.detailsWidth) setDetailsWidth(ui.detailsWidth);
      if (ui.tabs && ui.tabs.length > 0) {
        const restored = ui.tabs
          .filter((t) => t.kind === 'file')
          .map((t) => ({ key: `file:${t.path}`, kind: 'file' as const, path: t.path }));
        setTabs(restored);
        if (
          ui.activeTab &&
          (ui.activeTab === 'graph' ||
            ui.activeTab === 'insights' ||
            ui.activeTab === 'review' ||
            ui.activeTab === 'board' ||
            restored.some((t) => t.key === ui.activeTab))
        ) {
          setActiveTab(ui.activeTab);
        }
      }
    });
  }, []);

  useEffect(() => {
    void api.getProject().then((info) => {
      if (info) resetForProject(info);
    });
    const unsubs = [
      api.on('evt:projectOpened', (payload) => resetForProject(payload as ProjectInfo)),
      api.on('evt:graphPatch', (payload) => {
        const patch = payload as GraphPatch;
        const nodes = fullNodesRef.current;
        const edges = fullEdgesRef.current;
        for (const n of [...patch.addedNodes, ...patch.updatedNodes]) nodes.set(n.id, n);
        for (const id of patch.removedNodeIds) nodes.delete(id);
        for (const e of [...patch.addedEdges, ...patch.updatedEdges]) edges.set(edgeMapKey(e), e);
        for (const e of patch.removedEdges) edges.delete(edgeMapKey(e));
        setGraphVersion((v) => v + 1);
        setRefreshKey((k) => k + 1);
        // refresh symbol data for expanded files that changed
        for (const n of [...patch.addedNodes, ...patch.updatedNodes]) {
          if (expandedFilesRef.current.has(n.id)) void fetchSymbolGraph(n.id);
        }
      }),
      api.on('evt:filesChanged', (payload) => {
        const event = payload as ChangeEvent;
        setChangedAt((prev) => {
          const next = { ...prev };
          for (const p of [...event.changed, ...event.removed]) next[p] = event.time;
          return next;
        });
        setChangedBy((prev) => {
          const next = { ...prev };
          for (const p of [...event.changed, ...event.removed]) next[p] = event.agent;
          return next;
        });
        setExternalVersions((prev) => {
          const next = { ...prev };
          for (const p of event.changed) next[p] = (next[p] ?? 0) + 1;
          return next;
        });
        if (event.agent !== 'you') {
          setRecentChanges((prev) =>
            [...prev, ...event.changed.map((p) => ({ path: p, time: event.time, agent: event.agent }))].slice(-80),
          );
        }
      }),
      api.on('evt:agentStatus', (payload) =>
        setAgentStatus((payload as { terminals: Record<string, string | null> }).terminals),
      ),
      api.on('evt:agentCommand', (payload) =>
        setCommands((prev) => [...prev.slice(-499), payload as CommandLogEntry]),
      ),
      api.on('evt:coverage', (payload) => {
        setCoverage(payload as CoverageMap);
        toast('Coverage data updated from lcov.info', 'info');
      }),
      api.on('evt:gitStatus', (payload) => setGitStatus(payload as GitStatus)),
      api.on('evt:treeChanged', (payload) => setFileTree(payload as FileTreeNode)),
      api.on('evt:board', (payload) => setBoard(payload as Board)),
      api.on('evt:activity', (payload) => {
        setBursts([...(payload as ChangeBurst[])]);
        void api.activityLastGreen().then(setLastGreen);
      }),
      api.on('evt:commandUpdate', (payload) => {
        const updated = payload as CommandLogEntry;
        setCommands((prev) => prev.map((c) => (c.pid === updated.pid ? updated : c)));
      }),
      api.on('evt:dangerousCommand', (payload) => {
        const cmd = payload as CommandLogEntry;
        toast(`${cmd.agent ?? 'you'} ran a destructive command: ${cmd.command.slice(0, 70)}`, 'warn');
      }),
      api.on('evt:shadowSnapshot', () => setRefreshKey((k) => k + 1)),
    ];
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetForProject]);

  const expandedFilesRef = useRef(expandedFiles);
  expandedFilesRef.current = expandedFiles;

  // persist workspace state (debounced) + window title
  useEffect(() => {
    if (!project) return;
    document.title = `${project.name} — Flare`;
  }, [project]);
  useEffect(() => {
    if (!project) return;
    const timer = setTimeout(() => {
      void api.uiSave({
        tabs: tabs.map((t) => ({ kind: t.kind, path: t.path })),
        activeTab,
        lens,
        graphView,
        sidebarWidth,
        terminalHeight,
        detailsWidth,
        selectMode,
        legendCollapsed,
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [project, tabs, activeTab, lens, graphView, sidebarWidth, terminalHeight, detailsWidth, selectMode, legendCollapsed]);

  // ---------- insights: metrics + issues + alerts ----------
  useEffect(() => {
    if (!project) return;
    void api.shadowTimeline(300).then(setSnapshots);
  }, [project, refreshKey]);

  useEffect(() => {
    if (!project) return;
    const timer = setTimeout(() => {
      setInsights(
        computeInsights({
          nodes: [...fullNodesRef.current.values()],
          edges: [...fullEdgesRef.current.values()],
          churn,
          coverage,
          changedAt,
          changedBy,
          review: reviewInfo?.review ?? null,
          snapshots,
        }),
      );
    }, 600);
    return () => clearTimeout(timer);
  }, [project, graphVersion, changedAt, changedBy, churn, coverage, reviewInfo, snapshots]);

  const seenCriticalsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!insights) return;
    const fresh = insights.issues.filter(
      (i) => i.severity === 'critical' && !seenCriticalsRef.current.has(i.id),
    );
    for (const issue of fresh) seenCriticalsRef.current.add(issue.id);
    for (const issue of fresh.slice(0, 2)) toast(`● ${issue.title}`, 'warn');
  }, [insights]);

  /**
   * The risky changes waiting for an answer.
   *
   * Derived rather than accumulated: bursts, metrics and what has been approved
   * are all already state, so the queue is a view of them. An alert that stops
   * being true — the file gets approved, or a later burst makes it the same
   * file's newer alert — leaves on its own, with nothing to keep in sync.
   */
  const alerts = useMemo(
    () =>
      riskAlerts({
        bursts,
        metrics: new Map((insights?.files ?? []).map((f) => [f.path, f])),
        approvedAt: reviewInfo?.review.approvedAt ?? {},
        dismissed: dismissedAlerts,
      }),
    [bursts, insights, reviewInfo, dismissedAlerts],
  );

  const dismissAlert = useCallback((alert: RiskAlert) => {
    setDismissedAlerts((prev) => new Set([...prev, alert.id]));
  }, []);

  const dismissAllAlerts = useCallback(() => {
    setDismissedAlerts((prev) => new Set([...prev, ...alerts.map((a) => a.id)]));
  }, [alerts]);

  // ---------- selection model (single + multi) ----------
  const allDirs = useMemo(() => {
    const dirs = new Set<string>();
    const walk = (node: FileTreeNode) => {
      if (node.type === 'dir') {
        if (node.path !== '') dirs.add(node.path);
        node.children?.forEach(walk);
      }
    };
    if (fileTree) walk(fileTree);
    return dirs;
  }, [fileTree]);

  const idToEntry = useCallback(
    (id: string): { path: string; isDir: boolean } => {
      if (id.startsWith('@dir:')) return { path: id.slice(5), isDir: true };
      const sym = parseSymbolNode(id);
      if (sym) return { path: sym.path, isDir: false };
      return { path: id, isDir: allDirs.has(id) };
    },
    [allDirs],
  );

  const selectedPathsRef = useRef(selectedPaths);
  selectedPathsRef.current = selectedPaths;

  const selectSingle = useCallback((id: string | null) => {
    setSelected(id);
    setSelectedPaths(id ? new Set([id]) : new Set());
  }, []);

  /**
   * Answering an alert: go and read the change.
   *
   * The card is dismissed on the way, because the review panel it lands in is
   * a better version of the same information — leaving the popup up behind the
   * panel that is showing the file would be asking the same question twice.
   */
  const reviewAlert = useCallback(
    (alert: RiskAlert) => {
      dismissAlert(alert);
      selectSingle(alert.path);
      setActiveTab('review');
      setReviewFocus(alert.path);
    },
    [dismissAlert, selectSingle],
  );

  const toggleSelect = useCallback((id: string) => {
    // pure updater — safe under React's update replay/interleaving
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelected(id);
  }, []);

  const boxSelect = useCallback((ids: string[]) => {
    setSelectedPaths(new Set(ids));
    /*
     * A bulk selection does not open the details panel.
     *
     * It used to set `selected` to the last node caught, which opened the
     * single-file panel — narrowing the canvas, re-wrapping the layout and
     * moving every card out from under the rectangle you had just drawn. It
     * also answered the wrong question: a selection of twenty files is not
     * about the twentieth one. The action bar speaks for the set instead.
     */
    setSelected(ids.length === 1 ? ids[0] : null);
  }, []);

  const openContextMenu = useCallback(
    (payload: { x: number; y: number; id: string | null }) => {
      if (payload.id === null) {
        setCtxMenu({ x: payload.x, y: payload.y, entries: [] });
        return;
      }
      let ids: string[];
      if (selectedPaths.has(payload.id) && selectedPaths.size > 1) {
        ids = [...selectedPaths];
      } else {
        ids = [payload.id];
        selectSingle(payload.id);
      }
      const seen = new Set<string>();
      const entries = ids
        .map(idToEntry)
        .filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true)));
      setCtxMenu({ x: payload.x, y: payload.y, entries });
    },
    [selectedPaths, selectSingle, idToEntry],
  );

  // ---------- file operations ----------
  const doCreateFile = useCallback((targetDir: string) => {
    setModal({
      title: `New file in ${targetDir === '' ? 'project root' : `${targetDir}/`}`,
      input: { initial: targetDir === '' ? '' : `${targetDir}/`, placeholder: 'path/to/file.ts' },
      confirmLabel: 'Create',
      onConfirm: (value) => {
        const rel = value.trim().replace(/\\/g, '/');
        void api.createFile(rel).then((ok) => {
          if (ok) {
            treeRef.current?.reveal(rel);
            toast(`Created ${rel}`, 'success');
            openFile(rel);
          } else {
            toast(`Could not create ${rel} (already exists?)`, 'warn');
          }
        });
      },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doCreateFolder = useCallback((targetDir: string) => {
    setModal({
      title: `New folder in ${targetDir === '' ? 'project root' : `${targetDir}/`}`,
      input: { initial: targetDir === '' ? '' : `${targetDir}/`, placeholder: 'path/to/folder' },
      confirmLabel: 'Create',
      onConfirm: (value) => {
        const rel = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
        if (rel === '') return;
        void api.createDir(rel).then((ok) => {
          if (ok) {
            treeRef.current?.reveal(`${rel}/x`);
            toast(`Created ${rel}/`, 'success');
          } else {
            toast(`Could not create ${rel}/ (already exists?)`, 'warn');
          }
        });
      },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doRename = useCallback((path: string) => {
    setModal({
      title: `Rename ${path}`,
      input: { initial: path },
      confirmLabel: 'Rename',
      onConfirm: (value) => {
        const to = value.trim().replace(/\\/g, '/');
        if (to === path) return;
        void api.renameFile(path, to).then((ok) => {
          if (ok) {
            toast(`Renamed to ${to}`, 'success');
            closeTabNow(`file:${path}`);
            setSelectedPaths(new Set());
            setSelected(null);
          } else {
            toast('Rename failed (target exists?)', 'warn');
          }
        });
      },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doDelete = useCallback((entries: { path: string; isDir: boolean }[]) => {
    const paths = entries.map((e) => e.path);
    const label =
      paths.length === 1 ? `${entries[0].isDir ? 'folder ' : ''}${paths[0]}` : `${paths.length} items`;
    setModal({
      title: `Delete ${label}?\n\nA local-history snapshot is taken first, so this is restorable from ↺ History.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        void api.deleteFiles(paths).then((ok) => {
          toast(ok ? `Deleted ${label}` : 'Some items could not be deleted', ok ? 'success' : 'warn');
          for (const p of paths) closeTabNow(`file:${p}`);
          setSelectedPaths(new Set());
          setSelected(null);
        });
      },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const idToEntryRef = useRef(idToEntry);
  idToEntryRef.current = idToEntry;
  const doDeleteRef = useRef(doDelete);
  doDeleteRef.current = doDelete;

  const copyPaths = useCallback((paths: string[], flat: boolean) => {
    const text = flat ? formatPathsFlat(paths) : formatPathsTree(paths);
    void api.clipboardWrite(text);
    toast(
      paths.length === 1 ? 'Path copied' : `${paths.length} paths copied (${flat ? 'flat' : 'structured'})`,
      'success',
    );
  }, []);


  const fetchSymbolGraph = useCallback(async (path: string) => {
    const sg = await api.symbolGraph(path);
    if (sg) {
      setSymbolGraphs((prev) => {
        const next = new Map(prev);
        next.set(path, sg);
        return next;
      });
    }
    return sg;
  }, []);

  const expandFile = useCallback(
    async (path: string) => {
      const sg = await fetchSymbolGraph(path);
      if (sg) {
        setExpandedFiles((prev) => new Set([...prev, path]));
        setActiveTab('graph');
      }
    },
    [fetchSymbolGraph],
  );

  const collapseFile = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const updateCollapsed = useCallback((next: Set<string>) => {
    setCollapsedDirs(next);
    void api.collapsedSave([...next]);
  }, []);

  const toggleDir = useCallback(
    (dir: string) => {
      if (dir === '' || dir === '(root)') return;
      setCollapsedDirs((prev) => {
        const unfolding = prev.has(dir);
        const paths = [...fullNodesRef.current.keys()];
        const drilled = unfolding ? drillCount(prev, dir, paths) : 0;
        const next = unfolding ? unfoldDir(prev, dir, paths) : foldDir(prev, dir);
        void api.collapsedSave([...next]);
        // Unfolding removes the folder's card, which is also the only thing you
        // could have clicked to fold it again — so say where the way back is at
        // the moment it disappears, not in a help overlay nobody opens.
        if (unfolding) {
          toast(
            drilled > 0
              ? `Unfolded ${dir}/ into ${drilled} sub-folders — click one to go deeper`
              : `Unfolded ${dir}/ — fold it again from the Folders row below the toolbar`,
            'info',
          );
        }
        return next;
      });
    },
    [],
  );

  // Folding a directory that holds a single file gains nothing, and the
  // default never folds them — so they must not decide whether the graph
  // counts as "all folded" either, or the button says "Fold all" over a graph
  // that is visibly already folded and appears to do nothing when clicked.
  const allClusters = useMemo(
    () => stats.clusters.filter((c) => c.name !== '(root)' && c.count >= 2).map((c) => c.name),
    [stats.clusters],
  );
  const allCollapsed = allClusters.length > 0 && allClusters.every((c) => collapsedDirs.has(c));

  /**
   * Where the explorer's New file / New folder buttons create things: the
   * selected folder, or the selected file's folder, or the root. Creating in
   * the root while a folder is highlighted is the behaviour people misread as
   * the button being broken.
   */
  const selectedDir = useMemo(() => {
    if (!selected) return '';
    const entry = idToEntry(selected);
    if (entry.isDir) return entry.path;
    return entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
  }, [selected, idToEntry]);

  const openFile = useCallback((path: string, line?: number) => {
    const key = `file:${path}`;
    setTabs((prev) => (prev.some((t) => t.key === key) ? prev : [...prev, { key, kind: 'file', path }]));
    setActiveTab(key);
    setSelected(path);
    if (line) setPendingLine((prev) => ({ ...prev, [path]: line }));
    // opening a file in the editor is the only *evidence* a human read it —
    // approving is a claim, this is the thing the never-read lens counts
    void api.markRead([path]).then(() => api.reviewGet().then((r) => r && setReviewInfo(r)));
  }, []);

  const openDiff = useCallback((path: string, source: 'head' | { hash: string }) => {
    const suffix = source === 'head' ? 'HEAD' : source.hash.slice(0, 7);
    const key = `diff:${path}@${suffix}`;
    setTabs((prev) =>
      prev.some((t) => t.key === key) ? prev : [...prev, { key, kind: 'diff', path, source }],
    );
    setActiveTab(key);
  }, []);

  const closeTabNow = useCallback((key: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === key);
      const next = prev.filter((t) => t.key !== key);
      setActiveTab((cur) => (cur === key ? (next[Math.max(0, idx - 1)]?.key ?? 'graph') : cur));
      return next;
    });
    setDirtyTabs((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const dirtyTabsRef = useRef(dirtyTabs);
  dirtyTabsRef.current = dirtyTabs;

  /** Close a tab, asking first when it has unsaved edits. */
  const closeTab = useCallback(
    (key: string) => {
      if (dirtyTabsRef.current.has(key)) {
        setModal({
          title: `${key.replace(/^file:/, '')} has unsaved changes.\nClose without saving?`,
          confirmLabel: 'Close anyway',
          danger: true,
          onConfirm: () => closeTabNow(key),
        });
      } else {
        closeTabNow(key);
      }
    },
    [closeTabNow],
  );

  /** Unreviewed changes ordered by risk (highest first). */
  const unreviewed = useMemo(() => {
    if (!reviewInfo) return [];
    const { approvedAt, checkpointAt } = reviewInfo.review;
    return Object.entries(changedAt)
      .filter(([p, t]) => t > Math.max(approvedAt[p] ?? 0, checkpointAt))
      .map(([p]) => p)
      .sort((a, b) => {
        const na = fullNodesRef.current.get(a);
        const nb = fullNodesRef.current.get(b);
        return (
          (nb ? riskScore(nb, coverage[b]?.pct) : 0) - (na ? riskScore(na, coverage[a]?.pct) : 0)
        );
      });
  }, [changedAt, reviewInfo, coverage, graphVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = useCallback((path: string) => {
    void api.reviewApprove([path]).then((r) => r && setReviewInfo(r));
  }, []);

  const approveAll = useCallback(() => {
    void api.reviewCheckpoint().then((r) => r && setReviewInfo(r));
  }, []);

  const saveBoard = useCallback((next: Board) => {
    setBoard(next);
    void api.boardSet(next);
  }, []);

  /** File the current selection as a task without leaving the graph. */
  const taskFromSelection = useCallback(
    (paths: string[]) => {
      const title = paths.length === 1 ? `Work on ${paths[0].split('/').pop()}` : `Work on ${paths.length} files`;
      setBoard((prev) => {
        const next = createTask(prev, { title, paths }).board;
        void api.boardSet(next);
        return next;
      });
      setActiveTab('board');
      toast(`Task filed with ${paths.length} file${paths.length === 1 ? '' : 's'}`, 'success');
    },
    [],
  );

  const approvePaths = useCallback((paths: string[]) => {
    void api.reviewApprove(paths).then((r) => r && setReviewInfo(r));
    void api.markRead(paths);
  }, []);

  const revertFileTo = useCallback((hash: string, path: string) => {
    void api.shadowRestoreFile(hash, path).then((ok) => {
      toast(ok ? `Reverted ${path}` : `Could not revert ${path}`, ok ? 'success' : 'warn');
      if (ok) setRefreshKey((k) => k + 1);
    });
  }, []);

  const revertAllTo = useCallback((hash: string, label: string) => {
    setModal({
      title: `Revert the whole project to before ${label}?`,
      body: 'Every file goes back to that snapshot. A new snapshot is taken first, so this is itself undoable from the history timeline.',
      confirmLabel: 'Revert everything',
      danger: true,
      onConfirm: () => {
        void api.shadowRestoreAll(hash).then((ok) => {
          toast(ok ? 'Project reverted' : 'Revert failed', ok ? 'success' : 'warn');
          if (ok) setRefreshKey((k) => k + 1);
        });
      },
    });
  }, []);

  const backToGreen = useCallback(() => {
    if (!lastGreen) return;
    setModal({
      title: 'Go back to the last state whose checks passed?',
      body: 'Every file is restored to the snapshot taken after the last burst that ran green. A new snapshot is taken first, so this is undoable.',
      confirmLabel: 'Restore last green',
      danger: true,
      onConfirm: () => {
        void api.shadowRestoreAll(lastGreen.hash).then((ok) => {
          toast(ok ? 'Restored the last verified state' : 'Restore failed', ok ? 'success' : 'warn');
          if (ok) setRefreshKey((k) => k + 1);
        });
      },
    });
  }, [lastGreen]);

  const startWalkthrough = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setWalk({ paths, index: 0 });
    setActiveTab('graph');
    setSelected(paths[0]);
    void api.markRead([paths[0]]).then(() => api.reviewGet().then((r) => r && setReviewInfo(r)));
    requestAnimationFrame(() => graphRef.current?.focusNode(paths[0]));
  }, []);

  const walkTo = useCallback((index: number) => {
    setWalk((prev) => {
      if (!prev) return prev;
      const next = Math.max(0, Math.min(prev.paths.length - 1, index));
      const path = prev.paths[next];
      setSelected(path);
      void api.markRead([path]).then(() => api.reviewGet().then((r) => r && setReviewInfo(r)));
      requestAnimationFrame(() => graphRef.current?.focusNode(path));
      return { ...prev, index: next };
    });
  }, []);

  const reviewNext = useCallback(() => {
    if (unreviewed.length > 0) {
      setSelected(unreviewed[0]);
      setActiveTab('graph');
      graphRef.current?.focusNode(unreviewed[0]);
    }
  }, [unreviewed]);

  const unverifiedBursts = useMemo(() => unverifiedCount(bursts), [bursts]);

  /**
   * The reuse score per file, for the lens.
   *
   * Computed by the metrics engine rather than in the views: it needs the
   * transitive dependency count of every file, which is a whole-graph walk,
   * and having one owner keeps the lens and the Insights table saying the
   * same thing about the same file.
   */
  const reuseByPath = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const f of insights?.files ?? []) out[f.path] = f.reuse;
    return out;
  }, [insights]);

  // when the active lens has nothing to colour, the strip says so rather than
  // leaving a uniformly grey graph that reads as broken
  const lensNote = useMemo(
    () =>
      lensSignal(
        fullNodesRef.current.values(),
        buildLensContext(fullNodesRef.current.values(), {
          lens,
          churn,
          coverage,
          reuse: reuseByPath,
          changedAt,
          readAt: reviewInfo?.review.readAt ?? {},
          clusterColor: () => '#000000',
        }),
      ),
    [lens, churn, coverage, reuseByPath, changedAt, reviewInfo, graphVersion],
  );
  const boardSelection = useMemo(
    () => (selectedPaths.size > 0 ? [...selectedPaths] : selected ? [selected] : []),
    [selectedPaths, selected],
  );

  const searchCycleRef = useRef({ query: '', index: -1 });
  const onSearchKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return;
        const matches = [...fullNodesRef.current.keys()]
          .filter((id) => id.toLowerCase().includes(q))
          .sort();
        if (matches.length === 0) return;
        // repeated Enter cycles through the matches
        const cycle = searchCycleRef.current;
        cycle.index = cycle.query === q ? (cycle.index + 1) % matches.length : 0;
        cycle.query = q;
        const match = matches[cycle.index];
        selectSingle(match);
        setActiveTab('graph');
        graphRef.current?.focusNode(match);
        if (matches.length > 1) toast(`${cycle.index + 1}/${matches.length}: ${match}`, 'info');
      }
      if (e.key === 'Escape') {
        setSearchQuery('');
        (e.target as HTMLInputElement).blur();
      }
    },
    [searchQuery, selectSingle],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFocusId(null);
        setExpandedFiles((prev) => (prev.size > 0 ? new Set() : prev));
        // a selection with an action bar over the graph needs a way out that
        // is not "click precisely on empty board"
        setSelectedPaths((prev) => (prev.size > 0 ? new Set() : prev));
      }
      if (e.key === 'Delete') {
        const el = e.target as HTMLElement;
        if (el.closest?.('input, textarea, .xterm, .monaco-editor, .palette')) return;
        const current = selectedPathsRef.current;
        if (current.size > 0) {
          const seen = new Set<string>();
          const entries = [...current]
            .map(idToEntryRef.current)
            .filter((en) => (seen.has(en.path) ? false : (seen.add(en.path), true)));
          doDeleteRef.current(entries);
        }
      }
      if (e.key === '?' && !(e.target as HTMLElement).closest?.('input, textarea, .xterm, .monaco-editor')) {
        e.preventDefault();
        setHelpOpen((o) => !o);
      }
      // V swaps the pointer tool, as it does in every other canvas
      if (
        e.key.toLowerCase() === 'v' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !(e.target as HTMLElement).closest?.('input, textarea, .xterm, .monaco-editor, .palette')
      ) {
        setSelectMode((on) => !on);
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'p')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarVisible((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        setActiveTab((cur) => {
          if (cur !== 'graph') closeTab(cur);
          return cur;
        });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        graphRef.current?.fitView();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        graphRef.current?.zoom(1);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        graphRef.current?.zoom(-1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeTab]);

  // ---------- application menu ----------
  const appMenus = useMemo<MenuDef[]>(() => {
    const viewEntry = (id: GraphViewKind, label: string) => ({
      id: `view-${id}`,
      label,
      checked: graphView === id,
      run: () => {
        setGraphView(id);
        setActiveTab('graph');
      },
    });
    return [
      {
        id: 'file',
        label: 'File',
        /*
         * Served in a browser, a Flare process is one project — you start
         * another `flare serve` for another folder and it gets its own URL.
         * So the entries that switch or leave the project are desktop-only,
         * rather than being present and quietly doing nothing.
         */
        entries: tidySeparators(
          [
            { id: 'open', label: 'Open Folder...', run: () => void api.openProjectDialog() },
            {
              id: 'new-project',
              label: 'New/Open Project...',
              run: () => setNewProjectOpen(true),
            },
            {
              id: 'recent',
              label: 'Open Recent',
              disabled: recents.length === 0,
              submenu: recents.slice(0, 8).map((r, i) => ({
                id: `recent-${i}`,
                label: r.path.split(/[\\/]/).pop() ?? r.path,
                hint: r.path,
                run: () => void api.openProject(r.path),
              })),
            },
            { id: 'sep1', separator: true },
            { id: 'new-file', label: 'New File...', hint: selectedDir === '' ? 'root' : `${selectedDir}/`, run: () => doCreateFile(selectedDir) },
            { id: 'new-folder', label: 'New Folder...', hint: selectedDir === '' ? 'root' : `${selectedDir}/`, run: () => doCreateFolder(selectedDir) },
            { id: 'reveal', label: 'Reveal Project in File Manager', run: () => void api.revealFile('') },
            { id: 'sep2', separator: true },
            {
              id: 'approve',
              label: 'Dismiss All Change Markers',
              hint: `${unreviewed.length} flagged`,
              disabled: unreviewed.length === 0,
              run: approveAll,
            },
            { id: 'sep3', separator: true },
            { id: 'exit', label: 'Exit', danger: true, run: () => void api.windowControl('close') },
          ].filter((entry) => isDesktop || !DESKTOP_ONLY_MENU.has(entry.id)),
        ),
      },
      {
        id: 'view',
        label: 'View',
        entries: [
          { id: 'tab-graph', label: 'Graph', checked: activeTab === 'graph', run: () => setActiveTab('graph') },
          {
            id: 'tab-board',
            label: 'Tasks',
            hint: boardSummary(board) || undefined,
            checked: activeTab === 'board',
            run: () => setActiveTab('board'),
          },
          {
            id: 'tab-insights',
            label: 'Insights',
            hint: insights ? `${insights.summary.criticals + insights.summary.warnings} issues` : undefined,
            checked: activeTab === 'insights',
            run: () => setActiveTab('insights'),
          },
          { id: 'sep1', separator: true },
          {
            id: 'sidebar',
            label: 'Sidebar',
            hint: 'Ctrl+B',
            checked: sidebarVisible,
            run: () => setSidebarVisible((v) => !v),
          },
          {
            id: 'history',
            label: 'Local History',
            checked: showTimeline,
            run: () => setShowTimeline((v) => !v),
          },
          { id: 'sep2', separator: true },
          { id: 'zoom-in', label: 'Zoom In', hint: 'Ctrl +', run: () => graphRef.current?.zoom(1) },
          { id: 'zoom-out', label: 'Zoom Out', hint: 'Ctrl -', run: () => graphRef.current?.zoom(-1) },
          { id: 'zoom-fit', label: 'Fit to Screen', hint: 'Ctrl 0', run: () => graphRef.current?.fitView() },
          { id: 'sep3', separator: true },
          { id: 'palette', label: 'Command Palette...', hint: 'Ctrl+K', run: () => setPaletteOpen(true) },
        ],
      },
      {
        id: 'graph',
        label: 'Graph',
        entries: [
          viewEntry('canvas', 'Draw as Canvas'),
          viewEntry('wheel', 'Draw as Wheel'),
          viewEntry('districts', 'Draw as Districts'),
          { id: 'sep1', separator: true },
          {
            id: 'lens',
            label: 'Colour by',
            hint: LENSES.find((l) => l.id === lens)?.label,
            submenu: LENSES.filter((l) => l.id !== 'coverage' || Object.keys(coverage).length > 0).map((l) => ({
              id: `lens-${l.id}`,
              label: l.label,
              hint: l.hint,
              checked: lens === l.id,
              run: () => {
                setLens(l.id);
                setActiveTab('graph');
              },
            })),
          },
          { id: 'sep2', separator: true },
          {
            id: 'fold-all',
            label: allCollapsed ? 'Unfold All Directories' : 'Fold All Directories',
            run: () => updateCollapsed(allCollapsed ? new Set() : new Set(allClusters)),
          },
          { id: 'relayout', label: 'Re-layout', run: () => graphRef.current?.relayout() },
          {
            id: 'clear-focus',
            label: 'Clear Focus Mode',
            hint: 'Esc',
            disabled: focusId === null,
            run: () => setFocusId(null),
          },
        ],
      },
      {
        id: 'go',
        label: 'Go',
        entries: [
          { id: 'goto-file', label: 'Go to File...', hint: 'Ctrl+K', run: () => setPaletteOpen(true) },
          { id: 'sep1', separator: true },
          {
            id: 'review-next',
            label: 'Riskiest Unreviewed Change',
            disabled: unreviewed.length === 0,
            run: reviewNext,
          },
          { id: 'goto-issues', label: 'Issue Feed', run: () => setActiveTab('insights') },
          { id: 'sep2', separator: true },
          {
            id: 'clear-selection',
            label: 'Clear Selection',
            disabled: selectedPaths.size === 0 && selected === null,
            run: () => {
              setSelected(null);
              setSelectedPaths(new Set());
            },
          },
        ],
      },
      {
        id: 'help',
        label: 'Help',
        entries: [
          { id: 'cheatsheet', label: 'Graph Cheat Sheet...', hint: '?', run: () => setHelpOpen(true) },
          { id: 'sep1', separator: true },
          {
            id: 'mcp',
            label: 'Copy MCP Setup Command',
            hint: mcpInfo.port ? `:${mcpInfo.port}` : 'starting...',
            disabled: mcpInfo.port === 0,
            run: () => {
              void api.clipboardWrite(
                MCP_TARGETS[0].snippet(mcpUrl(mcpInfo.port, mcpInfo.slug)),
              );
              toast('MCP setup command copied - paste it in your shell', 'success');
            },
          },
          { id: 'sep2', separator: true },
          {
            id: 'about',
            label: 'About Flare',
            run: () =>
              setModal({
                title: 'Flare',
                branded: true,
                body: [
                  'A graph-first IDE for agentic coding.',
                  '',
                  `project   ${project?.root ?? '-'}`,
                  `files     ${insights?.summary.files ?? 0}`,
                  `mcp       ${mcpInfo.port ? `http://127.0.0.1:${mcpInfo.port}/${mcpInfo.slug ?? ''}` : 'not running'}`,
                ].join('\n'),
                confirmLabel: 'Close',
                onConfirm: () => undefined,
              }),
          },
        ],
      },
    ];
  }, [
    graphView,
    activeTab,
    sidebarVisible,
    showTimeline,
    lens,
    coverage,
    allCollapsed,
    allClusters,
    focusId,
    unreviewed.length,
    board,
    selectedPaths.size,
    selected,
    recents,
    mcpInfo,
    insights,
    project,
    approveAll,
    reviewNext,
    updateCollapsed,
    doCreateFile,
    doCreateFolder,
    selectedDir,
  ]);

  const ctxItems = useMemo<MenuItem[]>(() => {
    if (!ctxMenu) return [];
    const { entries } = ctxMenu;
    const files = entries.filter((e) => !e.isDir).map((e) => e.path);
    const dirs = entries.filter((e) => e.isDir).map((e) => e.path);
    const allPaths = entries.map((e) => e.path);
    const items: MenuItem[] = [];

    if (entries.length === 0) {
      items.push(
        { id: 'new-file', label: 'New file…', run: () => doCreateFile('') },
        { id: 'new-folder', label: 'New folder…', run: () => doCreateFolder('') },
        { id: 'sep0', label: '', separator: true },
        { id: 'tree-collapse', label: 'Collapse all folders in explorer', run: () => treeRef.current?.collapseAll() },
        { id: 'tree-expand', label: 'Expand all folders in explorer', run: () => treeRef.current?.expandAll() },
        { id: 'sep0b', label: '', separator: true },
        {
          id: 'collapse-all',
          label: 'Fold all folders in graph',
          run: () => updateCollapsed(new Set(allClusters)),
        },
        { id: 'expand-all', label: 'Unfold all folders in graph', run: () => updateCollapsed(new Set()) },
      );
      return items;
    }

    if (files.length > 0) {
      items.push({
        id: 'open',
        label: files.length > 1 ? `Open ${files.length} files` : 'Open',
        run: () => files.forEach((f) => openFile(f)),
      });
    }
    items.push({
      id: 'open-terminal',
      label: dirs.length > 0 || entries.length === 0 ? 'Open terminal here' : 'Open terminal in this folder',
      run: () => {
        const dir = entries.length === 0 ? '' : dirs[0] ?? allPaths[0].split('/').slice(0, -1).join('/');
        setOpenTerminalAt({ dir, nonce: Date.now() });
        toast(dir === '' ? 'Terminal opened at the project root' : `Terminal opened in ${dir}/`, 'success');
      },
    });
    items.push({ id: 'sep-terminal', label: '', separator: true });
    items.push({
      id: 'new-task',
      label:
        allPaths.length > 1
          ? `New task with these ${allPaths.length} files`
          : 'New task with this file',
      run: () => taskFromSelection(allPaths),
    });
    items.push({ id: 'sep-task', label: '', separator: true });
    items.push({
      id: 'copy-paths',
      label: allPaths.length > 1 ? `Copy ${allPaths.length} paths (structured)` : 'Copy path',
      run: () => copyPaths(allPaths, false),
    });
    if (allPaths.length > 1) {
      items.push({
        id: 'copy-paths-flat',
        label: 'Copy paths (flat list)',
        run: () => copyPaths(allPaths, true),
      });
    }
    items.push({
      id: 'copy-abs',
      label: allPaths.length > 1 ? 'Copy absolute paths' : 'Copy absolute path',
      run: () => {
        const root = projectRef.current?.root.replace(/\\/g, '/') ?? '';
        void api.clipboardWrite(allPaths.map((p) => `${root}/${p}`).join('\n'));
        toast('Absolute path copied', 'success');
      },
    });
    if (entries.length === 1 && isDesktop) {
      items.push({
        id: 'reveal',
        label: 'Reveal in Explorer',
        run: () => void api.revealFile(entries[0].path),
      });
    }
    items.push({ id: 'sep1', label: '', separator: true });
    const newFileTarget =
      dirs[0] ?? (files[0]?.includes('/') ? files[0].slice(0, files[0].lastIndexOf('/')) : '');
    items.push({
      id: 'new-file',
      label: `New file in ${newFileTarget === '' ? 'root' : `${newFileTarget}/`}…`,
      run: () => doCreateFile(newFileTarget),
    });
    items.push({
      id: 'new-folder',
      label: `New folder in ${newFileTarget === '' ? 'root' : `${newFileTarget}/`}…`,
      run: () => doCreateFolder(newFileTarget),
    });
    if (entries.length === 1) {
      // folders rename too — fs.rename does not care, and not offering it read
      // as the tree being view-only for directories
      items.push({
        id: 'rename',
        label: entries[0].isDir ? 'Rename folder…' : 'Rename…',
        run: () => doRename(entries[0].path),
      });
    }
    const unreviewedInSelection = files.filter((f) => unreviewed.includes(f));
    if (unreviewedInSelection.length > 0) {
      items.push({
        id: 'approve',
        label: `Dismiss ${unreviewedInSelection.length} change marker${unreviewedInSelection.length === 1 ? '' : 's'}`,
        run: () => void api.reviewApprove(unreviewedInSelection).then((r) => r && setReviewInfo(r)),
      });
    }
    if (entries.length === 1 && dirs.length === 1) {
      items.push({
        id: 'toggle-dir',
        label: collapsedDirs.has(dirs[0]) ? 'Unfold in graph' : 'Fold into one card in graph',
        run: () => toggleDir(dirs[0]),
      });
    } else if (entries.length === 1 && files.length === 1 && files[0].includes('/')) {
      // Once a folder is unfolded its card is gone, so there is nothing left to
      // right-click to fold it again. Offer it from any file inside instead —
      // the folder it actually sits in, which after drilling into a large tree
      // is several levels below the cluster.
      const parent = files[0].slice(0, files[0].lastIndexOf('/'));
      let owner = files[0].slice(0, files[0].indexOf('/'));
      let siblings = 0;
      for (const id of fullNodesRef.current.keys()) {
        if (id.startsWith(`${parent}/`)) siblings++;
      }
      if (siblings >= 2) owner = parent;
      if (owner === parent || allClusters.includes(owner)) {
        items.push({
          id: 'fold-owner',
          label: collapsedDirs.has(owner) ? `Unfold ${owner}/ in graph` : `Fold ${owner}/ into one card in graph`,
          run: () => toggleDir(owner),
        });
      }
    }
    items.push({ id: 'sep2', label: '', separator: true });
    items.push({
      id: 'delete',
      label: `Delete ${entries.length > 1 ? `${entries.length} items` : entries[0].isDir ? 'folder' : 'file'}…`,
      danger: true,
      run: () => doDelete(entries),
    });
    return items;
  }, [ctxMenu, unreviewed, collapsedDirs, allClusters, doCreateFile, doCreateFolder, doRename, doDelete, copyPaths, openFile, toggleDir, updateCollapsed, taskFromSelection]);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    for (const l of LENSES) {
      items.push({
        id: `lens:${l.id}`,
        label: `Lens: ${l.label}`,
        hint: l.hint,
        kind: 'command',
        run: () => {
          setLens(l.id);
          setActiveTab('graph');
        },
      });
    }
    for (const v of [
      { id: 'canvas', label: 'Canvas', hint: 'dependency cards, ordered left-to-right' },
      { id: 'wheel', label: 'Wheel', hint: 'radial hierarchy with bundled dependency chords' },
      { id: 'districts', label: 'Districts', hint: 'treemap sized by lines of code' },
    ] as const) {
      items.push({
        id: `view:${v.id}`,
        label: `View: ${v.label}`,
        hint: v.hint,
        kind: 'command',
        run: () => {
          setGraphView(v.id);
          setActiveTab('graph');
        },
      });
    }
    items.push(
      {
        id: 'cmd:approve-all',
        label: 'Review: dismiss all change markers',
        kind: 'command',
        run: () => {
          approveAll();
          toast('Markers cleared — the code on disk is unchanged', 'success');
        },
      },
      {
        id: 'cmd:review-next',
        label: 'Review: jump to riskiest change',
        kind: 'command',
        run: reviewNext,
      },
      {
        id: 'cmd:timeline',
        label: 'Toggle local history timeline',
        kind: 'command',
        run: () => setShowTimeline((s) => !s),
      },
      {
        id: 'cmd:collapse-all',
        label: 'Graph: collapse all directories',
        kind: 'command',
        run: () => updateCollapsed(new Set(stats.clusters.map((c) => c.name).filter((n) => n !== '(root)'))),
      },
      {
        id: 'cmd:expand-all',
        label: 'Graph: expand all directories',
        kind: 'command',
        run: () => updateCollapsed(new Set()),
      },
      {
        id: 'cmd:sidebar',
        label: 'Toggle sidebar',
        hint: 'Ctrl+B',
        kind: 'command',
        run: () => setSidebarVisible((v) => !v),
      },
      {
        id: 'cmd:insights',
        label: 'Open Insights',
        kind: 'command',
        run: () => setActiveTab('insights'),
      },
      {
        id: 'cmd:fit',
        label: 'Graph: fit view',
        hint: 'Ctrl+0',
        kind: 'command',
        run: () => {
          setActiveTab('graph');
          graphRef.current?.fitView();
        },
      },
      {
        id: 'cmd:shortcuts',
        label: 'Help: keyboard shortcuts',
        kind: 'command',
        run: () =>
          setModal({
            title: 'Keyboard shortcuts',
            body: [
              'Ctrl+K / Ctrl+P   command palette',
              'Ctrl+B            toggle sidebar',
              'Ctrl+W            close tab',
              'Ctrl+S            save file',
              'Ctrl+0            fit graph',
              'Ctrl+= / Ctrl+-   zoom graph',
              'Enter (search)    jump / cycle matches',
              'Esc               clear focus & drill-down',
              'Delete            delete selection',
              'Ctrl+click        multi-select node/row',
              'Ctrl+drag         box-select nodes (or pick the arrow tool on the canvas, or press V)',
              'Shift+click       import path between nodes',
              'Double-click      open file / expand dir / fit (stage)',
              'Right-click       context menu',
            ].join('\n'),
            confirmLabel: 'Close',
            onConfirm: () => undefined,
          }),
      },
    );
    for (const recent of recents.map((r) => r.path).filter((r) => r !== projectRef.current?.root)) {
      items.push({
        id: `recent:${recent}`,
        label: `Open recent: ${recent.split(/[\\/]/).pop()}`,
        hint: recent,
        kind: 'command',
        run: () => void api.openProject(recent),
      });
    }
    for (const id of fullNodesRef.current.keys()) {
      items.push({
        id: `file:${id}`,
        label: id,
        kind: 'file',
        run: () => openFile(id),
      });
    }
    return items;
  }, [approveAll, reviewNext, openFile, stats.clusters, recents, graphVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDirtyChange = useCallback((path: string, dirty: boolean) => {
    const key = `file:${path}`;
    setDirtyTabs((prev) => {
      if (prev.has(key) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // what is currently selected (file, dir meta-node, or symbol)?
  const selection = useMemo(() => {
    if (!selected) return null;
    if (selected.startsWith('@dir:')) {
      const dir = selected.slice(5);
      const members = [...fullNodesRef.current.values()].filter((n) => n.id.startsWith(`${dir}/`));
      return { type: 'dir' as const, dir, members };
    }
    const sym = parseSymbolNode(selected);
    if (sym) {
      const sg = symbolGraphs.get(sym.path);
      return {
        type: 'symbol' as const,
        ...sym,
        info: sg?.symbols.find((s) => s.name === sym.symbol) ?? null,
      };
    }
    return { type: 'file' as const, path: selected };
  }, [selected, symbolGraphs, graphVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) {
    return (
      <div className="app">
        <div className="topbar">
          <span className="brand"><FlareMark size={15} />Flare</span>
          <span className="spacer" />
          <WindowControls />
        </div>
        <StartScreen />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar" style={RESERVE_TRAFFIC_LIGHTS ? { paddingLeft: 76 } : undefined}>
        <span className="brand"><FlareMark size={15} />Flare</span>
        <MenuBar menus={appMenus} />
        <input
          className="search"
          placeholder="search files…  (Enter to jump)"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={onSearchKey}
          data-testid="search-input"
        />
        <span className="spacer" />
        <span className="project-chip" title={project.root} data-testid="project-name">
          {project.name}
        </span>
        {focusId && (
          <span className="badge" title="Focus mode: only this file and its 2-hop neighbourhood are shown. Esc or ✕ to clear.">
            focus: {focusId.split('/').pop()}{' '}
            <a style={{ cursor: 'pointer' }} onClick={() => setFocusId(null)}>
              ✕
            </a>
          </span>
        )}
        <button
          className="btn"
          title="Local history — every change burst this session is snapshotted; restore a file or the whole tree from any point"
          onClick={() => setShowTimeline((s) => !s)}
          data-testid="btn-timeline"
        >
          ↺ History
        </button>
        {(insights?.summary.criticals ?? 0) > 0 && (
          <span
            className="badge warn alert-badge"
            style={{ color: '#f0a0a0', borderColor: '#d03b3b' }}
            onClick={() => setActiveTab('insights')}
            data-testid="alert-badge"
            title="open Insights"
          >
            ● {insights!.summary.criticals} critical
          </span>
        )}
        {selectedPaths.size > 1 && (
          <span className="badge selection-chip" data-testid="selection-chip">
            {selectedPaths.size} selected
            <a
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setSelectedPaths(new Set());
                setSelected(null);
              }}
            >
              ✕
            </a>
          </span>
        )}
        {unreviewed.length > 0 && (
          <span
            className="badge warn"
            title="Files an agent or your editor changed since your last check. They are already saved — this marker is a reminder to look, not a gate. Clear it by dismissing, or undo the change by reverting."
            data-testid="unreviewed-badge"
          >
            {unreviewed.length} unreviewed
          </span>
        )}
        <button
          className="btn"
          onClick={() => setPaletteOpen(true)}
          title="Command palette (Ctrl+K) — jump to any file or run any command"
          data-testid="btn-palette"
        >
          ⌘K
        </button>
        <WindowControls />
      </div>

      {unreviewed.length > 0 && (
        <div className="review-banner" data-testid="review-banner">
          <span>
            ⚠︎ {unreviewed.length} file{unreviewed.length === 1 ? '' : 's'} changed since last review —{' '}
            <b>already written to disk</b>. Ordered by risk.
          </span>
          <button
            className="btn warn"
            title="Select the riskiest flagged file and focus the graph on it"
            onClick={reviewNext}
            data-testid="btn-review-next"
          >
            Review next
          </button>
          <button
            className="btn"
            title="Clear the amber markers. Nothing is approved by doing this — the code is already saved, and this only stops flagging it. To undo a change, use Revert in the Review tab or ↺ History."
            onClick={approveAll}
            data-testid="btn-approve-all"
          >
            Dismiss all
          </button>
          <button
            className="btn"
            title="The Review tab shows what each change did, whether anything verified it, and lets you revert a file or a whole burst"
            onClick={() => setActiveTab('review')}
            data-testid="btn-open-review"
          >
            Open review →
          </button>
        </div>
      )}

      <div className="main-row">
        {sidebarVisible && (
          <>
            <div className="sidebar" style={{ width: sidebarWidth }}>
              {/* Creating a file used to be reachable only by right-clicking a
                  row, which is not a place anyone looks for it. */}
              <div className="explorer-head" data-testid="explorer-head">
                <span className="explorer-title" title={selectedDir === '' ? 'New items go in the project root' : `New items go in ${selectedDir}/`}>
                  Explorer
                  {selectedDir !== '' && <span className="explorer-target">{selectedDir}/</span>}
                </span>
                <button
                  className="ehbtn"
                  title={`New file in ${selectedDir === '' ? 'the project root' : `${selectedDir}/`} (select a folder to change where)`}
                  aria-label="New file"
                  onClick={() => doCreateFile(selectedDir)}
                  data-testid="explorer-new-file"
                >
                  ⊞
                </button>
                <button
                  className="ehbtn"
                  title={`New folder in ${selectedDir === '' ? 'the project root' : `${selectedDir}/`} (select a folder to change where)`}
                  aria-label="New folder"
                  onClick={() => doCreateFolder(selectedDir)}
                  data-testid="explorer-new-folder"
                >
                  ⊕
                </button>
                <button
                  className="ehbtn"
                  title="Collapse every folder in this tree"
                  aria-label="Collapse all folders"
                  onClick={() => treeRef.current?.collapseAll()}
                  data-testid="explorer-collapse-all"
                >
                  ⇱
                </button>
                <button
                  className="ehbtn"
                  title="Re-read the folder tree and git state from disk. The watcher does this automatically — use it when something outside the IDE changed files behind its back."
                  aria-label="Refresh"
                  onClick={() => {
                    void api.rescan();
                    toast('Re-scanning project…', 'info');
                  }}
                  data-testid="explorer-refresh"
                >
                  ↻
                </button>
              </div>
              {fileTree && (
                <FileTree
                  ref={treeRef}
                  key={project?.root ?? 'none'}
                  tree={fileTree}
                  gitFiles={gitStatus?.files ?? {}}
                  selected={selected}
                  selectedPaths={selectedPaths}
                  onOpenFile={openFile}
                  onSelect={(p) => {
                    selectSingle(p);
                    openFile(p);
                  }}
                  onToggleSelect={toggleSelect}
                  onRowContextMenu={({ x, y, path }) =>
                    openContextMenu({ x, y, id: path === '' ? null : path })
                  }
                />
              )}
            </div>
            <Splitter direction="horizontal" onDrag={(x) => setSidebarWidth(Math.max(140, Math.min(500, x)))} />
          </>
        )}

        <div className="center-col">
          <div className="main-area" style={{ display: 'flex', flexDirection: 'row' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div className="tabs">
                <div
                  className={`tab${activeTab === 'graph' ? ' active' : ''}`}
                  onClick={() => setActiveTab('graph')}
                  data-testid="tab-graph"
                >
                  ◆ Graph
                </div>
                <div
                  className={`tab${activeTab === 'board' ? ' active' : ''}`}
                  onClick={() => setActiveTab('board')}
                  data-testid="tab-board"
                  title="Tasks written to be pasted into an agent — and queryable by one over MCP"
                >
                  ☰ Tasks
                  {board.tasks.length > 0 && <span className="muted"> {board.tasks.length}</span>}
                </div>
                <div
                  className={`tab${activeTab === 'review' ? ' active' : ''}`}
                  onClick={() => setActiveTab('review')}
                  data-testid="tab-review"
                  title="What changed, whether anything checked it, and which files deserve your attention"
                >
                  ✓ Review
                  {unverifiedBursts > 0 && <span style={{ color: '#fab219' }}> {unverifiedBursts}</span>}
                </div>
                <div
                  className={`tab${activeTab === 'insights' ? ' active' : ''}`}
                  onClick={() => setActiveTab('insights')}
                  data-testid="tab-insights"
                >
                  ◆ Insights
                  {(insights?.summary.criticals ?? 0) > 0 && (
                    <span style={{ color: '#d03b3b' }}> {insights!.summary.criticals}</span>
                  )}
                </div>
                {tabs.map((t) => (
                  <div
                    key={t.key}
                    className={`tab${activeTab === t.key ? ' active' : ''}`}
                    onClick={() => setActiveTab(t.key)}
                    onAuxClick={(e) => {
                      if (e.button === 1) closeTab(t.key);
                    }}
                    data-testid={`tab-${t.key}`}
                  >
                    <span>
                      {t.kind === 'diff' ? '± ' : ''}
                      {t.path.split('/').pop()}
                      {t.kind === 'diff' && (
                        <span className="muted">
                          {' '}
                          @{t.source === 'head' ? 'HEAD' : t.source!.hash.slice(0, 7)}
                        </span>
                      )}
                      {dirtyTabs.has(t.key) ? ' ●' : ''}
                    </span>
                    <span
                      className="close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.key);
                      }}
                    >
                      ✕
                    </span>
                  </div>
                ))}
              </div>
              <div className="tab-body">
                <div style={{ position: 'absolute', inset: 0, display: activeTab === 'graph' ? 'block' : 'none' }}>
                  {viewReady && (
                    <CanvasTools
                      selectMode={selectMode}
                      onChange={setSelectMode}
                      zoomPct={zoomPct}
                      onZoom={(d) => graphRef.current?.zoom(d)}
                      onFit={() => graphRef.current?.fitView()}
                      onCenter={() => graphRef.current?.centerView()}
                      onHelp={() => setHelpOpen(true)}
                    />
                  )}
                  {viewReady && stats.nodes === 0 && <GraphEmpty />}
                  {viewReady && (
                  <ActiveGraphView
                    kind={graphView}
                    ref={graphRef}
                    graphVersion={graphVersion}
                    fullNodes={fullNodesRef.current}
                    fullEdges={fullEdgesRef.current}
                    projectRoot={project.root}
                    gitStatus={gitStatus}
                    changedAt={changedAt}
                    changedBy={changedBy}
                    churn={churn}
                    coverage={coverage}
                    reuse={reuseByPath}
                    selectMode={selectMode}
                    reviewInfo={reviewInfo}
                    selected={selected}
                    searchQuery={searchQuery}
                    focusId={focusId}
                    lens={lens}
                    collapsedDirs={collapsedDirs}
                    expandedFiles={expandedFiles}
                    symbolGraphs={symbolGraphs}
                    recentChanges={recentChanges}
                    selectedPaths={selectedPaths}
                    onSelect={selectSingle}
                    onToggleSelect={toggleSelect}
                    onBoxSelect={boxSelect}
                    onNodeContextMenu={openContextMenu}
                    onOpenFile={openFile}
                    onToggleDir={toggleDir}
                    onStats={setStats}
                    onZoom={setZoomPct}
                  />
                  )}
                  {walk && (
                    <div className="walkbar" data-testid="walkbar">
                      <span className="walk-count">
                        {walk.index + 1} / {walk.paths.length}
                      </span>
                      <span className="mono walk-path">{walk.paths[walk.index]}</span>
                      <button className="btn" onClick={() => walkTo(walk.index - 1)} disabled={walk.index === 0}>
                        ‹ Prev
                      </button>
                      <button
                        className="btn primary"
                        onClick={() => walkTo(walk.index + 1)}
                        disabled={walk.index >= walk.paths.length - 1}
                        data-testid="walk-next"
                      >
                        Next ›
                      </button>
                      <button className="btn" onClick={() => openDiff(walk.paths[walk.index], 'head')}>
                        Diff
                      </button>
                      <button
                        className="btn"
                        onClick={() => {
                          approvePaths([walk.paths[walk.index]]);
                          if (walk.index < walk.paths.length - 1) walkTo(walk.index + 1);
                        }}
                      >
                        ✓ Approve
                      </button>
                      <button className="btn" onClick={() => setWalk(null)} data-testid="walk-exit">
                        Exit
                      </button>
                    </div>
                  )}
                  {/* the toolbar only exists once the persisted collapse state
                      has loaded — otherwise a fold/unfold click made in the
                      first moments is silently overwritten by that load */}
                  <div className="graph-overlay" style={{ display: viewReady ? undefined : 'none' }}>
                    <div className="lens-switcher" data-testid="lens-switcher">
                      <span className="switch-label" title="pick the question you want the colours to answer">
                        Colour by
                      </span>
                      {LENSES.filter((l) => l.id !== 'coverage' || Object.keys(coverage).length > 0).map((l) => (
                        <button
                          key={l.id}
                          className={`lens-btn${lens === l.id ? ' active' : ''}`}
                          title={`${l.hint}\n${l.reading}`}
                          onClick={() => setLens(l.id)}
                          data-testid={`lens-${l.id}`}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                    <div className="lens-switcher" data-testid="view-switcher">
                      <span className="switch-label" title="pick how the same graph is drawn">
                        Draw as
                      </span>
                      {(
                        [
                          {
                            id: 'canvas',
                            label: '▤ Canvas',
                            hint: 'Dependency cards on a board, ordered left-to-right: foundations left, entry points right. Best for reading structure and dragging things around.',
                          },
                          {
                            id: 'wheel',
                            label: '◎ Wheel',
                            hint: 'Every file on one ring, grouped by folder, dependencies drawn as chords through the middle. Best for "what talks to what" across the whole repo.',
                          },
                          {
                            id: 'districts',
                            label: '▩ Districts',
                            hint: 'Treemap where tile area is lines of code. Best for "how big is this repo and where does the mass sit".',
                          },
                        ] as const
                      ).map((v) => (
                        <button
                          key={v.id}
                          className={`lens-btn${graphView === v.id ? ' active' : ''}`}
                          title={v.hint}
                          onClick={() => setGraphView(v.id)}
                          data-testid={`view-${v.id}`}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                    <div className="lens-switcher" data-testid="layout-switcher">
                      <button
                        className="lens-btn"
                        title={
                          graphView === 'canvas'
                            ? 'Re-run the layout from scratch and re-frame it. Also forgets any cards you dragged.'
                            : 'Reset the view to its default framing and rotation.'
                        }
                        onClick={() => graphRef.current?.relayout()}
                        data-testid="layout-reset"
                      >
                        ↻ Re-layout
                      </button>
                      <button
                        className="lens-btn"
                        title={
                          allCollapsed
                            ? 'Unfold every directory so each file gets its own node.'
                            : 'Fold every directory into a single node — the fastest way out of a hairball.'
                        }
                        onClick={() => updateCollapsed(allCollapsed ? new Set() : new Set(allClusters))}
                        data-testid="collapse-toggle-all"
                      >
                        {allCollapsed ? '▢ Unfold all' : '▣ Fold all'}
                      </button>
                    </div>
                    {/* Zoom, fit, centre and the shortcut list live on the
                        canvas now, in CanvasTools — see the note there. */}
                    <LensLegend
                      lens={lens}
                      emptyNote={lensNote}
                      clusters={stats.clusters}
                      onToggleDir={toggleDir}
                      onFoldAll={() => updateCollapsed(new Set(allClusters))}
                      onUnfoldAll={() => updateCollapsed(new Set())}
                      collapsed={legendCollapsed}
                      onToggleCollapsed={() => setLegendCollapsed((on) => !on)}
                    />
                  </div>

                  {/* What you can do with a set of files, where the set is —
                      the actions existed only behind a right-click, which is
                      not somewhere anyone looks after dragging a rectangle. */}
                  {selectedPaths.size > 0 && (
                    <div className="bulk-bar" data-testid="bulk-bar">
                      <span className="bulk-count">
                        {plural(selectedPaths.size, 'file')} selected
                      </span>
                      <span className="bulk-sep" />
                      <button
                        className="btn primary"
                        title="Copy the paths plus what the graph knows about them — dependents, coverage, cycles — ready to paste into an agent"
                        onClick={() => copyPaths([...selectedPaths], false)}
                        data-testid="bulk-copy"
                      >
                        Copy for agent
                      </button>
                      <button
                        className="btn"
                        title="File these as one task on the board, with the same context attached"
                        onClick={() => taskFromSelection([...selectedPaths])}
                        data-testid="bulk-task"
                      >
                        New task
                      </button>
                      {[...selectedPaths].some((p) => unreviewed.includes(p)) && (
                        <button
                          className="btn warn"
                          title="Clear the change markers on these. The code is already on disk — this only stops flagging it."
                          onClick={() => approvePaths([...selectedPaths])}
                          data-testid="bulk-dismiss"
                        >
                          Dismiss markers
                        </button>
                      )}
                      <button
                        className="btn"
                        title="Open every selected file in a tab"
                        onClick={() => [...selectedPaths].slice(0, 12).forEach((p) => openFile(p))}
                        data-testid="bulk-open"
                      >
                        Open
                      </button>
                      <button
                        className="btn danger"
                        title="Delete these files. A local-history snapshot is taken first."
                        onClick={() => doDelete([...selectedPaths].map(idToEntry))}
                        data-testid="bulk-delete"
                      >
                        Delete
                      </button>
                      <span className="bulk-sep" />
                      <button
                        className="btn"
                        title="Clear the selection (Esc)"
                        onClick={() => {
                          setSelectedPaths(new Set());
                          setSelected(null);
                        }}
                        data-testid="bulk-clear"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
                {activeTab === 'board' && (
                  <BoardPanel
                    board={board}
                    selectedPaths={boardSelection}
                    onChange={saveBoard}
                    onSelectFile={(p) => {
                      selectSingle(p);
                      setActiveTab('graph');
                    }}
                    onOpenFile={openFile}
                    onModal={setModal}
                  />
                )}
                {activeTab === 'review' && (
                  <ReviewPanel
                    bursts={bursts}
                    insights={insights}
                    reviewInfo={reviewInfo}
                    lastGreen={lastGreen}
                    onSelectFile={selectSingle}
                    onOpenFile={openFile}
                    onOpenDiff={(path, hash) => openDiff(path, { hash })}
                    onApprove={approvePaths}
                    onRevertFile={revertFileTo}
                    onRevertAll={revertAllTo}
                    onWalkthrough={startWalkthrough}
                    onBackToGreen={backToGreen}
                    focusPath={reviewFocus}
                    onFocusHandled={() => setReviewFocus(null)}
                  />
                )}
                {activeTab === 'insights' && (
                  <InsightsPanel
                    insights={insights}
                    onSelectFile={(p) => {
                      selectSingle(p);
                    }}
                    onOpenFile={openFile}
                  />
                )}
                {tabs.map((t) => (
                  <div
                    key={t.key}
                    style={{ position: 'absolute', inset: 0, display: activeTab === t.key ? 'block' : 'none' }}
                  >
                    {t.kind === 'file' && previewKindFor(t.path) ? (
                      <DocumentPane
                        path={t.path}
                        kind={previewKindFor(t.path)!}
                        externalVersion={externalVersions[t.path] ?? 0}
                        onDirtyChange={onDirtyChange}
                        onOpenFile={openFile}
                      />
                    ) : t.kind === 'file' ? (
                      <EditorPane
                        path={t.path}
                        externalVersion={externalVersions[t.path] ?? 0}
                        revealLine={pendingLine[t.path]}
                        onDirtyChange={onDirtyChange}
                      />
                    ) : (
                      <DiffPane
                        path={t.path}
                        source={t.source!}
                        externalVersion={externalVersions[t.path] ?? 0}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {selection && (
              <>
                <Splitter
                  direction="horizontal"
                  onDrag={(x) => setDetailsWidth(Math.max(220, Math.min(560, window.innerWidth - x)))}
                />
                <div className="details-panel" style={{ width: detailsWidth }}>
                  {selection.type === 'file' && (
                    <DetailsPanel
                      nodeId={selection.path}
                      gitState={gitStatus?.files[selection.path]}
                      reviewInfo={reviewInfo}
                      changedAt={changedAt}
                      changedBy={changedBy}
                      churn={churn}
                      coverage={coverage[selection.path] ?? null}
                      insights={insights}
                      refreshKey={refreshKey}
                      isExpanded={expandedFiles.has(selection.path)}
                      onOpenFile={openFile}
                      onOpenDiff={openDiff}
                      onNewTask={taskFromSelection}
                      onSelect={(p) => {
                        setSelected(p);
                        graphRef.current?.focusNode(p);
                      }}
                      onApprove={approve}
                      onFocus={(p) => {
                        setFocusId(p);
                        setActiveTab('graph');
                      }}
                      onExpandSymbols={(p) => void expandFile(p)}
                      onCollapseSymbols={collapseFile}
                      onRestored={() => {
                        setRefreshKey((k) => k + 1);
                        toast('File reverted to snapshot', 'success');
                      }}
                    />
                  )}
                  {selection.type === 'dir' && (
                    <div data-testid="dir-details">
                      <h3>▣ {selection.dir}/</h3>
                      <div className="kv">
                        <span className="k">files</span>
                        <span>{selection.members.length}</span>
                        <span className="k">lines</span>
                        <span>{selection.members.reduce((a, n) => a + n.loc, 0)}</span>
                        <span className="k">in cycles</span>
                        <span>{selection.members.filter((n) => n.cycleId !== null).length}</span>
                        <span className="k">untested</span>
                        <span>
                          {selection.members.filter((n) => !n.isTest && n.testedBy === 0).length}
                        </span>
                      </div>
                      <div className="actions">
                        <button className="btn primary" onClick={() => toggleDir(selection.dir)}>
                          Expand directory
                        </button>
                      </div>
                    </div>
                  )}
                  {selection.type === 'symbol' && (
                    <div data-testid="symbol-details">
                      <h3 className="mono">
                        {selection.symbol}
                        <span className="muted"> · {selection.info?.kind ?? 'symbol'}</span>
                      </h3>
                      <div className="kv">
                        <span className="k">file</span>
                        <span className="mono">{selection.path}</span>
                        <span className="k">line</span>
                        <span>{selection.info?.line ?? '?'}</span>
                        <span className="k">length</span>
                        <span>{selection.info?.loc ?? '?'} lines</span>
                        <span className="k">exported</span>
                        <span>{selection.info?.exported ? 'yes' : 'no'}</span>
                      </div>
                      <div className="actions">
                        <button
                          className="btn primary"
                          onClick={() => openFile(selection.path, selection.info?.line)}
                        >
                          Open at line
                        </button>
                        <button className="btn" onClick={() => collapseFile(selection.path)}>
                          Collapse symbols
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {showTimeline && (
            <Timeline
              refreshKey={refreshKey}
              onOpenDiff={openDiff}
              onRestored={() => {
                setRefreshKey((k) => k + 1);
                toast('Tree restored from snapshot — a safety snapshot was taken first', 'success');
              }}
              onClose={() => setShowTimeline(false)}
            />
          )}

          <Splitter
            direction="vertical"
            onDrag={(y) => setTerminalHeight(Math.max(80, Math.min(window.innerHeight - 200, window.innerHeight - y - 22)))}
          />
          <TerminalPanel
            projectRoot={project.root}
            height={terminalHeight}
            agents={agentStatus}
            commands={commands}
            openAt={openTerminalAt}
            mcp={mcpInfo}
          />
        </div>
      </div>

      <div className="statusbar" data-testid="statusbar">
        <span className="item">{gitStatus?.isRepo ? `⎇ ${gitStatus.branch}` : 'no git repo'}</span>
        <span
          className="item"
          data-testid="stats"
          title={`Cards currently on the board, not the size of the project — a folded folder counts as one card. This repo holds ${insights ? insights.summary.files : stats.nodes} code files in total.`}
        >
          {stats.nodes} nodes · {stats.edges} edges
        </span>
        <span
          className="item"
          style={{ cursor: 'pointer' }}
          title="Files git reports as modified, added or untracked since the last commit. Click for Insights."
          onClick={() => setActiveTab('insights')}
        >
          {Object.keys(gitStatus?.files ?? {}).length} changed on disk
        </span>
        {unreviewed.length > 0 && (
          <span
            className="item"
            style={{ color: '#fab219', cursor: 'pointer' }}
            title="Files changed since you last approved, ordered by how much depends on them. Click to jump to the riskiest."
            onClick={reviewNext}
          >
            {unreviewed.length} to review
          </span>
        )}
        <span className="spacer" />
        {mcpInfo.port > 0 && (
          <span
            className="item"
            style={{ cursor: 'pointer', color: '#199e70' }}
            title="MCP server for agents — click to copy the project-scoped `claude mcp add` command. For Codex and opencode, use ◆ Connect agent above the terminal."
            data-testid="mcp-indicator"
            onClick={() => {
              void api.clipboardWrite(
                MCP_TARGETS[0].snippet(mcpUrl(mcpInfo.port, mcpInfo.slug)),
              );
              toast('MCP setup command copied — or use ◆ Connect agent for Codex and opencode', 'success');
            }}
          >
            ◆ MCP {mcpInfo.slug ? `/${mcpInfo.slug}` : `:${mcpInfo.port}`}
          </span>
        )}
        <span className="item mono muted">{project.root}</span>
      </div>

      <CommandPalette open={paletteOpen} items={paletteItems} onClose={() => setPaletteOpen(false)} />
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={() => setCtxMenu(null)} />
      )}
      {helpOpen && <HelpOverlay view={graphView} onClose={() => setHelpOpen(false)} />}
      {newProjectOpen && (
        <NewProjectDialog hasProject={project !== null} onClose={() => setNewProjectOpen(false)} />
      )}
      {modal && <Modal request={modal} onClose={() => setModal(null)} />}
      {/*
        One corner, two kinds of message: receipts on top, the queue below.

        Stepped left of the details panel while that is open. An alert waits
        for an answer, so unlike a toast it would otherwise sit on top of the
        panel's history and dependency links for as long as it took to notice —
        covering the very thing someone reviewing a risky change came to read.
      */}
      <div className="corner-stack" style={{ right: (selection ? detailsWidth : 0) + 16 }}>
        <Toasts />
        <RiskAlerts
          alerts={alerts}
          onReview={reviewAlert}
          onDismiss={dismissAlert}
          onDismissAll={dismissAllAlerts}
        />
      </div>
    </div>
  );
}


/** Routes the graph tab to the active representation, keeping one imperative handle. */
const ActiveGraphView = forwardRef<GraphViewHandle, CanvasProps & { kind: GraphViewKind }>(
  function ActiveGraphView({ kind, ...props }, ref) {
    if (kind === 'wheel') return <WheelView ref={ref} {...props} />;
    if (kind === 'districts') return <DistrictsView ref={ref} {...props} />;
    return <CanvasView ref={ref} {...props} />;
  },
);
