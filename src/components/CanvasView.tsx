import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { GitStatus, GraphEdge, GraphNode, SymbolGraph } from '../../shared/types';
import type { CoverageMap } from '../../shared/coverage';
import type { ReviewInfo } from '../api';
import { api } from '../api';
import { STATUS, makeClusterColors } from '../theme';
import { agentColor, type Lens } from '../graph/lenses';
import { conflictMarks, type Conflict } from '../../shared/conflicts';
import { noticesUnder, type Notice } from '../../shared/channel';
import { aggregateLens, buildLensContext, lensColor, lensValue, type LensContext } from '../graph/lensColor';
import {
  deriveRenderModel,
  folderLabel,
  parseSymbolNode,
  representingDir,
  type RenderNode,
} from '../graph/renderModel';
import { hierarchicalFlowLayout } from '../graph/flowLayout';
import { num, plural } from '../format';

export interface GraphViewHandle {
  relayout(): void;
  focusNode(id: string): void;
  zoom(direction: 1 | -1): void;
  fitView(): void;
  /** re-centre the content at the current zoom */
  centerView(): void;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  clusters: { name: string; color: string; count: number; collapsed: boolean }[];
}

export interface CanvasProps {
  graphVersion: number;
  /**
   * Which theme is on.
   *
   * Not read directly — the colours come from the live palette. It is here
   * because every colour in this view is memoised, and a memo with no reason
   * to recompute keeps the palette it was built with: switching to light
   * left the graph painted in the dark one until something else changed.
   */
  theme: string;
  fullNodes: ReadonlyMap<string, GraphNode>;
  fullEdges: ReadonlyMap<string, GraphEdge>;
  projectRoot: string;
  gitStatus: GitStatus | null;
  changedAt: Record<string, number>;
  changedBy: Record<string, string>;
  churn: Record<string, number>;
  coverage: CoverageMap;
  /** path -> reuse score from the metrics engine (null = too thin to score) */
  reuse: Record<string, number | null>;
  /** drag picks files instead of panning — the toolbar arrow */
  selectMode: boolean;
  reviewInfo: ReviewInfo | null;
  selected: string | null;
  selectedPaths: ReadonlySet<string>;
  searchQuery: string;
  lens: Lens;
  collapsedDirs: ReadonlySet<string>;
  expandedFiles: ReadonlySet<string>;
  symbolGraphs: ReadonlyMap<string, SymbolGraph>;
  recentChanges: { path: string; time: number; agent: string }[];
  /**
   * Where two agents got in each other's way.
   *
   * Drawn rather than listed, because both facts are already shapes on this
   * canvas: "two agents wrote this file" is the agent dot, and "one changed
   * something the other was building on" is the import edge between them. A
   * crossing you can see without hovering anything is the only version of this
   * that survives a forty-file night.
   */
  conflicts?: readonly Conflict[];
  /**
   * Files an agent has told the channel it is working on.
   *
   * The other agent marks on this canvas are all *retrospective* — who wrote
   * this, who wrote it twice. This one is the only forward-looking mark on the
   * graph: it says where work is about to happen, which is the moment a second
   * agent still has a choice about where to go. A list, not one holder,
   * because nothing here resolves — two agents may both have said it, and that
   * is the case worth drawing loudest.
   */
  held?: ReadonlyMap<string, Notice[]>;
  onSelect(id: string | null): void;
  onToggleSelect(id: string): void;
  onBoxSelect(ids: string[]): void;
  onNodeContextMenu(payload: { x: number; y: number; id: string | null }): void;
  onOpenFile(id: string, line?: number): void;
  onToggleDir(dir: string): void;
  onStats(stats: GraphStats): void;
  /** current zoom, as a percentage, for the toolbar readout */
  onZoom?(percent: number): void;
}

// layout units -> pixels; tuned so columns clear a card plus a gutter
const SX = 1.46;
const SY = 1.24;
const CARD_W = 164;
const CARD_H = 36;
const FOLDER_W = 178;
const FOLDER_H = 46;
const SYM_W = 116;
const SYM_H = 24;
/** the symbol grid: gap between chips, offset from the card, plate padding */
const SYM_GAP = 6;
const SYM_OFFSET = 18;
const PLATE_PAD = 10;
/** below this scale a card can't show detail — switch to the overview skin */
const FAR_ZOOM = 0.62;
/**
 * The floor for *automatic* framing. Comfortably above FAR_ZOOM so a card
 * opened onto is showing its name and badges, not the overview skin.
 */
const MIN_READABLE_ZOOM = 0.72;

interface Placed {
  node: RenderNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

function sizeOf(n: RenderNode): { w: number; h: number } {
  if (n.kind === 'dir') return { w: FOLDER_W, h: FOLDER_H };
  if (n.kind === 'symbol') return { w: SYM_W, h: SYM_H };
  if (n.kind === 'hub') return { w: CARD_W, h: CARD_H };
  return { w: CARD_W, h: CARD_H };
}

/**
 * "Somebody said they are in here."
 *
 * A filled square in the speaker's colour, which is the same colour its writes
 * get everywhere else in the app — so the mark on the card, the ring on the
 * burst and the chip in the roster are visibly one agent without anything
 * having to be read. Two agents having said it splits the square down the
 * middle, exactly as a contested file does: same shape of trouble, one step
 * earlier.
 */
function HeldMark({ notices, inside = false }: { notices: Notice[]; inside?: boolean }) {
  const names = [...new Map(notices.map((n) => [n.agentId, n])).values()];
  const clash = names.length > 1;
  const first = agentColor(names[0].agentId);
  return (
    <span
      className={`gb held${clash ? ' clash' : ''}`}
      style={{
        color: first,
        borderColor: clash ? undefined : first,
        ...(clash
          ? { background: `linear-gradient(90deg, ${first} 0 50%, ${agentColor(names[1].agentId)} 50% 100%)` }
          : {}),
      }}
      title={
        clash
          ? `${names.map((n) => n.agentName).join(' and ')} have BOTH said they are taking ${
              inside ? 'something in here' : 'this file'
            }. Nothing is blocked — whoever writes second wins.`
          : `${names[0].agentName} said in the channel it is working on ${
              inside ? 'a file in here' : 'this'
            }${names[0].text ? ` — ${names[0].text}` : ''}`
      }
    >
      ▣
    </span>
  );
}

function isUnreviewed(path: string, changedAt: Record<string, number>, review: ReviewInfo | null): boolean {
  const changed = changedAt[path];
  if (!changed) return false;
  const approvedAt = review?.review.approvedAt[path] ?? 0;
  const checkpointAt = review?.review.checkpointAt ?? 0;
  return changed > Math.max(approvedAt, checkpointAt);
}

export const CanvasView = forwardRef<GraphViewHandle, CanvasProps>(function CanvasView(props, ref) {
  const {
    graphVersion,
    theme,
    fullNodes,
    fullEdges,
    projectRoot,
    changedAt,
    changedBy,
    churn,
    coverage,
    reuse,
    selectMode,
    reviewInfo,
    selected,
    selectedPaths,
    searchQuery,
    lens,
    collapsedDirs,
    expandedFiles,
    symbolGraphs,
    recentChanges,
    conflicts,
    held,
    onSelect,
    onToggleSelect,
    onBoxSelect,
    onNodeContextMenu,
    onOpenFile,
    onToggleDir,
    onStats,
    onZoom,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const clusterColorRef = useRef(makeClusterColors());
  const viewRef = useRef({ x: 80, y: 80, k: 0.9 });
  const overridesRef = useRef<Record<string, { x: number; y: number }>>({});
  const [overridesVersion, setOverridesVersion] = useState(0);
  /** the card whose drag transform must be dropped once React has repositioned it */
  const clearTransformAfterCommit = useRef<HTMLElement | null>(null);
  const [selectRect, setSelectRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Landing a dragged card, after React has committed its new left/top and
  // before the browser paints.
  useLayoutEffect(() => {
    const el = clearTransformAfterCommit.current;
    if (!el) return;
    clearTransformAfterCommit.current = null;
    // the card already sits at the drop point in left/top, so dropping the
    // transform changes nothing on screen — and `dragging` is still applied,
    // so no transition can run
    el.style.transform = '';
    /*
     * The class comes off a frame later, and that delay is the whole fix.
     *
     * A transition compares the previous computed value against the new one
     * using the *new* style's transition-property. Clearing the transform and
     * re-enabling transitions in the same frame therefore animates the change
     * retroactively: the card jumps to the drop point and eases back by the
     * whole drag distance. Waiting one frame means transform is already none
     * on both sides of the comparison, so there is nothing to animate.
     */
    requestAnimationFrame(() => el.classList.remove('dragging'));
  }, [overridesVersion]);
  const knownIds = useRef(new Set<string>());
  const didInitialFit = useRef(false);
  const userMoved = useRef(false);
  const pathHl = useRef<{ nodes: Set<string>; edges: Set<string> } | null>(null);
  const [pathVersion, setPathVersion] = useState(0);
  const [size, setSize] = useState({ w: 1200, h: 620 });
  /**
   * The size the layout was computed against — not the live one.
   *
   * Band wrapping is a function of the viewport aspect, so while the layout
   * followed `size` every panel that opened re-wrapped the whole graph and
   * every card jumped. Selecting nodes opens the details panel, which is how a
   * box-select ended with the things you had just selected somewhere else.
   *
   * It re-wraps on a real resize — maximising the window, a big splitter drag —
   * and ignores the rest.
   */
  const [layoutSize, setLayoutSize] = useState({ w: 1200, h: 620 });

  useEffect(() => {
    setLayoutSize((prev) => {
      const dw = Math.abs(size.w - prev.w) / Math.max(prev.w, 1);
      const dh = Math.abs(size.h - prev.h) / Math.max(prev.h, 1);
      return dw > 0.3 || dh > 0.35 ? size : prev;
    });
  }, [size]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) setSize({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // load persisted drag overrides once per project
  useEffect(() => {
    clusterColorRef.current = makeClusterColors();
    overridesRef.current = {};
    knownIds.current = new Set();
    didInitialFit.current = false;
    void api.positionsLoad().then((saved) => {
      const out: Record<string, { x: number; y: number }> = {};
      for (const [key, p] of Object.entries(saved ?? {})) {
        if (key.startsWith('card:')) out[key.slice(5)] = p;
      }
      overridesRef.current = out;
      setOverridesVersion((v) => v + 1);
    });
  }, [projectRoot]);

  // ------------------------------------------------------------------
  // model + layout
  // ------------------------------------------------------------------
  /**
   * The computed layout, before anyone's dragging is taken into account.
   *
   * Deliberately independent of the drag overrides. When this was one memo,
   * dropping a card re-ran the whole flow layout, and anything that had
   * changed since the last one — a panel opening, a band wrapping differently
   * — landed at that moment, so the card you dropped arrived somewhere you did
   * not put it and everything else moved with it. Overrides can now only move
   * the cards they name.
   */
  const base = useMemo(() => {
    const derived = deriveRenderModel(
      fullNodes,
      [...fullEdges.values()],
      { collapsedDirs, expandedFiles },
      symbolGraphs,
    );
    const layoutInput = derived.nodes
      .filter((n) => n.kind !== 'symbol')
      .map((n) => ({ id: n.id, cluster: n.cluster === '(root)' ? '' : n.cluster }));
    const layoutEdges = derived.edges
      .filter((e) => e.kind !== 'intra')
      .map((e) => ({ source: e.source, target: e.target }));
    // wrap the flow into bands so a long dependency chain doesn't become an
    // unreadable 4000px strip on a 16:9 screen
    const wrapAspect = Math.max(1.2, (layoutSize.w / Math.max(layoutSize.h, 200)) * (SY / SX));
    return { derived, pos: hierarchicalFlowLayout(layoutInput, layoutEdges, wrapAspect) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphVersion, fullNodes, fullEdges, collapsedDirs, expandedFiles, symbolGraphs, layoutSize]);

  const model = useMemo(() => {
    const { derived, pos } = base;

    const placed = new Map<string, Placed>();
    for (const n of derived.nodes) {
      if (n.kind === 'symbol') continue;
      const p = overridesRef.current[n.id] ?? {
        x: (pos[n.id]?.x ?? 0) * SX,
        y: (pos[n.id]?.y ?? 0) * SY,
      };
      placed.set(n.id, { node: n, ...p, ...sizeOf(n) });
    }
    /*
     * Symbol chips sit in a tight grid beside their hub — a per-file view,
     * not a ring. They used to orbit the card at up to 230px, in a flow that
     * leaves ~26px between columns, so an expanded file's symbols landed on
     * top of (and under) its neighbours. The grid keeps them a glance from
     * the card, and the plate drawn under them (see `plates`) lifts the whole
     * group above the flow so nothing else shows through it.
     */
    const plates: { id: string; x: number; y: number; w: number; h: number }[] = [];
    for (const n of derived.nodes) {
      if (n.kind !== 'symbol' || !n.symbol) continue;
      const hub = placed.get(n.symbol.parent);
      const sg = symbolGraphs.get(n.symbol.parent);
      const idx = Math.max(sg?.symbols.findIndex((s) => s.name === n.symbol!.name) ?? 0, 0);
      const count = Math.max(sg?.symbols.length ?? 1, 1);
      const override = overridesRef.current[n.id];
      const cols = count > 6 ? 2 : 1;
      const rows = Math.ceil(count / cols);
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const stepX = SYM_W + SYM_GAP;
      const stepY = SYM_H + SYM_GAP;
      const base = hub
        ? {
            x: hub.x + CARD_W + SYM_OFFSET + col * stepX,
            // the column is centred on the card, so a short list sits level
            // with it and a long one grows evenly above and below
            y: hub.y + CARD_H / 2 - (rows * stepY - SYM_GAP) / 2 + row * stepY,
          }
        : { x: 0, y: 0 };
      placed.set(n.id, { node: n, ...(override ?? base), ...sizeOf(n) });
    }
    for (const n of derived.nodes) {
      if (n.kind !== 'hub') continue;
      const hub = placed.get(n.id);
      if (!hub) continue;
      const members = [...placed.values()].filter((p) => p.node.kind === 'symbol' && p.node.symbol?.parent === n.id);
      const xs = [hub, ...members];
      const minX = Math.min(...xs.map((p) => p.x));
      const minY = Math.min(...xs.map((p) => p.y));
      const maxX = Math.max(...xs.map((p) => p.x + p.w));
      const maxY = Math.max(...xs.map((p) => p.y + p.h));
      plates.push({ id: n.id, x: minX - PLATE_PAD, y: minY - PLATE_PAD, w: maxX - minX + PLATE_PAD * 2, h: maxY - minY + PLATE_PAD * 2 });
    }

    const edges = derived.edges
      .map((e) => {
        const a = placed.get(e.source);
        const b = placed.get(e.target);
        if (!a || !b) return null;
        return { ...e, a, b };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    // cluster captions above expanded groups of file cards
    const captions: { cluster: string; x: number; y: number }[] = [];
    const byCluster = new Map<string, Placed[]>();
    for (const p of placed.values()) {
      if (p.node.kind !== 'file') continue;
      const c = p.node.cluster || '(root)';
      if (!byCluster.has(c)) byCluster.set(c, []);
      byCluster.get(c)!.push(p);
    }
    for (const [cluster, members] of byCluster) {
      if (members.length < 2) continue;
      const minX = Math.min(...members.map((m) => m.x));
      const minY = Math.min(...members.map((m) => m.y));
      captions.push({ cluster, x: minX, y: minY - 26 });
    }
    return { placed, edges, captions, plates };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, overridesVersion, symbolGraphs]);

  const lensCtx = useMemo<LensContext>(() => {
    return buildLensContext(fullNodes.values(), {
      lens,
      churn,
      coverage,
      reuse,
      changedAt,
      readAt: reviewInfo?.review.readAt ?? {},
      clusterColor: (c) => clusterColorRef.current(c),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens, churn, coverage, reuse, changedAt, reviewInfo, graphVersion, theme]);

  // A collapsed folder takes the colour of its worst member under the active
  // lens, so switching to Risk/Hotspots is still meaningful while collapsed.
  const maxComplexity = useMemo(() => {
    let max = 1;
    for (const n of fullNodes.values()) max = Math.max(max, n.complexity);
    return max;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphVersion, fullNodes]);

  const dirColor = useMemo(() => {
    const members = new Map<string, GraphNode[]>();
    for (const n of fullNodes.values()) {
      const dir = representingDir(n.id, collapsedDirs);
      if (dir === null) continue;
      const list = members.get(dir);
      if (list) list.push(n);
      else members.set(dir, [n]);
    }
    const out = new Map<string, { value: number; color: string }>();
    for (const [dir, list] of members) out.set(dir, aggregateLens(list, lensCtx, maxComplexity));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lensCtx, graphVersion, fullNodes, maxComplexity, collapsedDirs]);

  // stats for the App overlay (legend etc.)
  useEffect(() => {
    const clusterCounts = new Map<string, number>();
    for (const n of fullNodes.values()) {
      const c = n.cluster || '(root)';
      clusterCounts.set(c, (clusterCounts.get(c) ?? 0) + 1);
    }
    onStats({
      nodes: model.placed.size,
      edges: model.edges.length,
      // Every folder gets a chip. Keeping only the eight largest quietly made
      // the rest impossible to fold from the legend — and once a folder is
      // unfolded its card is gone, so the chip is the only way back. "Fold all"
      // was reading the same truncated list, so it did not fold them either.
      clusters: [...clusterCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({
          name,
          count,
          color: clusterColorRef.current(name === '(root)' ? '' : name),
          collapsed: collapsedDirs.has(name),
        })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, collapsedDirs]);

  // ------------------------------------------------------------------
  // viewport (imperative CSS transform — this is what makes zoom instant)
  // ------------------------------------------------------------------
  const applyView = useCallback(() => {
    const v = viewRef.current;
    if (worldRef.current) {
      worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    }
    // semantic zoom: cards drop their detail once they are too small to read
    containerRef.current?.classList.toggle('zoom-far', v.k < FAR_ZOOM);
    onZoom?.(Math.round(v.k * 100));
  }, [onZoom]);

  /**
   * Frame the graph.
   *
   * `readable` is the difference between the two things "fit" can mean. The
   * ⊡ Fit button means *show me everything*, and will happily shrink a large
   * repo until the cards are unlabelled specks. Automatic framing — opening a
   * project, unfolding a directory — must not do that: a first screen you
   * cannot read is worse than one you have to pan. So it never zooms below the
   * point where a card still shows its filename, and anchors the viewport at
   * the top-left of the layout (which is where the foundations sit) instead of
   * centring a board that overflows in every direction.
   */
  /** Returns whether it actually framed — false when there was nothing to measure. */
  const fitView = useCallback(
    (readable = false): boolean => {
      const container = containerRef.current;
      if (!container || model.placed.size === 0) return false;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of model.placed.values()) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y - 26);
        maxX = Math.max(maxX, p.x + p.w);
        maxY = Math.max(maxY, p.y + p.h);
      }
      const rect = container.getBoundingClientRect();
      /*
       * Refuse to frame against a container that has not been measured.
       *
       * Every number below is a ratio against this rect, so a 0×0 one yields a
       * view computed from nothing. The graph tab is laid out long before this
       * runs and never hits it; a canvas mounted into a panel fits on the
       * frame it appears and can. Saying so explicitly — rather than quietly
       * producing a garbage view that the `didInitialFit` guard would then
       * make permanent — is what lets the measurement effect below take over.
       */
      if (rect.width < 2 || rect.height < 2) return false;
      /*
       * Measure the toolbar overlay rather than assuming its height.
       *
       * This was a hardcoded 74px, which was true of a one-row toolbar and
       * false of every other: the lens switcher wraps on a narrow window and
       * the folder chips take a row of their own, so the strip is routinely
       * taller than the allowance and the top rank of cards ends up sitting
       * under it. Reading the real height means framing stays clear of the
       * bar whatever the bar is currently doing.
       */
      const overlay = container.querySelector('.graph-overlay');
      const TOP = overlay ? Math.round(overlay.getBoundingClientRect().height) + 16 : 74;
      /*
       * The folder bar runs down the left, so it costs width the way the
       * toolbar costs height. Measured for the same reason: it is wider with a
       * long folder name in it and a narrow rail when collapsed, and framing
       * against a guess just moves the nodes that end up underneath it from
       * one edge to another.
       */
      const folders = container.querySelector('.legend');
      const LEFT = folders ? Math.round(folders.getBoundingClientRect().width) + 14 : 0;
      const usableH = Math.max(120, rect.height - TOP - 16);
      const usableW = Math.max(160, rect.width - LEFT - 32);
      const spanX = maxX - minX;
      const spanY = maxY - minY;
      const raw = Math.min(usableW / (spanX + 40), usableH / (spanY + 40));
      // a folded repo is only a handful of cards; let them grow into the space
      // rather than sitting small in the middle of an empty board
      const ceiling = model.placed.size <= 16 ? 1.9 : 1.5;
      const floor = readable ? MIN_READABLE_ZOOM : 0.34;
      const k = Math.min(ceiling, Math.max(floor, raw));
      const overflowsX = spanX * k > usableW;
      const overflowsY = spanY * k > usableH;
      viewRef.current = {
        k,
        x: overflowsX ? LEFT + 16 - minX * k : LEFT + (usableW - spanX * k) / 2 - minX * k,
        y: overflowsY ? TOP + 8 - minY * k : TOP + (usableH - spanY * k) / 2 - minY * k,
      };
      applyView();
      return true;
    },
    [model, applyView],
  );

  /**
   * Put the graph back in the middle at the zoom you are already on.
   *
   * Fit answers "show me everything" and changes the zoom to do it. After
   * following a chain of dependencies across a large board the zoom is usually
   * right and only the position is lost, so this moves nothing else.
   */
  const centerView = useCallback(() => {
    const container = containerRef.current;
    if (!container || model.placed.size === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of model.placed.values()) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w);
      maxY = Math.max(maxY, p.y + p.h);
    }
    const rect = container.getBoundingClientRect();
    const TOP = 74;
    const k = viewRef.current.k;
    userMoved.current = true;
    viewRef.current = {
      k,
      x: rect.width / 2 - ((minX + maxX) / 2) * k,
      y: TOP + (rect.height - TOP) / 2 - ((minY + maxY) / 2) * k,
    };
    applyView();
  }, [model, applyView]);

  const fitViewRef = useRef(fitView);
  fitViewRef.current = fitView;

  /*
   * Auto-frame until the user takes the wheel: expanding a cluster or resizing
   * the pane re-fits, but a manual pan/zoom is never overridden.
   *
   * Keyed on the computed layout, not on the placed cards. Dragging a card
   * changes where that card is and nothing else, and re-framing the whole view
   * underneath it moved it somewhere other than where it was dropped — the
   * card went right, the view followed the new bounds, and on screen it landed
   * to the left of where it started.
   */
  useEffect(() => {
    if (base.derived.nodes.length === 0) return;
    if (userMoved.current) {
      didInitialFit.current = true;
      return;
    }
    /*
     * The flag follows the outcome, not the attempt.
     *
     * It used to be set here, outside the frame, so a fit that never happened
     * still counted as done and nothing framed that canvas again. The graph
     * tab is always measured by this point so it never noticed; a canvas
     * mounted into a panel fits on the frame it appears, which is the case
     * this distinction exists for.
     */
    requestAnimationFrame(() => {
      if (fitViewRef.current(true)) didInitialFit.current = true;
    });
  }, [base]);

  /*
   * Fit once the pane has a size, for a canvas that mounted without one.
   *
   * The pair with the guard in `fitView`: that one declines to frame against
   * nothing, this one is what frames afterwards. Without it, declining would
   * simply mean never framing at all. It runs only when the fit above did not
   * take, so the graph tab never reaches it.
   */
  useEffect(() => {
    if (didInitialFit.current || userMoved.current) return;
    if (size.w < 2 || size.h < 2 || model.placed.size === 0) return;
    const frame = requestAnimationFrame(() => {
      fitViewRef.current(true);
      didInitialFit.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [size, model]);

  const zoomAt = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const mx = cx ?? rect.width / 2;
      const my = cy ?? rect.height / 2;
      const v = viewRef.current;
      userMoved.current = true;
      const k2 = Math.min(3, Math.max(0.08, v.k * factor));
      v.x = mx - (mx - v.x) * (k2 / v.k);
      v.y = my - (my - v.y) * (k2 / v.k);
      v.k = k2;
      applyView();
    },
    [applyView],
  );

  useImperativeHandle(ref, () => ({
    relayout() {
      // clear drag overrides -> deterministic flow layout, then refit
      overridesRef.current = {};
      userMoved.current = false;
      const cleaned: Record<string, { x: number; y: number }> = {};
      void api.positionsSave(cleaned);
      setOverridesVersion((v) => v + 1);
      // an explicit re-layout re-frames everything (rAF hands the callback a
      // timestamp, so this must not be passed by reference)
      requestAnimationFrame(() => fitView(false));
    },
    focusNode(id: string) {
      const container = containerRef.current;
      let p = model.placed.get(id);
      if (!p) {
        // the file is inside a folded folder — jump to the card standing in for it
        const dir = representingDir(id, collapsedDirs);
        if (dir) p = model.placed.get(`@dir:${dir}`);
      }
      if (!p || !container) return;
      /*
       * Jumping to a file is the user taking the wheel, exactly as a pan or a
       * zoom is.
       *
       * Without this the auto-frame above still owns the view, so the next
       * thing that changes the layout — an agent writing a file, a folder
       * unfolding — re-fits the whole graph and throws away the framing that
       * was just asked for. Searching for a file while an agent was working
       * put you back at the whole-repo view a second later, every time.
       */
      userMoved.current = true;
      const rect = container.getBoundingClientRect();
      const k = Math.max(viewRef.current.k, 1);
      viewRef.current = {
        k,
        x: rect.width / 2 - (p.x + p.w / 2) * k,
        y: rect.height / 2 - (p.y + p.h / 2) * k,
      };
      applyView();
    },
    zoom(direction: 1 | -1) {
      zoomAt(direction === 1 ? 1.35 : 1 / 1.35);
    },
    // the toolbar button and Ctrl+0 mean "show me everything", so no floor
    fitView: () => fitView(false),
    centerView,
  }));

  // ------------------------------------------------------------------
  // pointer interactions: pan, box select, card drag
  // ------------------------------------------------------------------
  const dragState = useRef<
    | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
    | { kind: 'box'; sx: number; sy: number }
    | { kind: 'card'; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }
    | null
  >(null);

  /**
   * DOM resolved once at mouse-down and reused for the whole drag. `source` /
   * `target` are the *fixed* end of each edge — null means that end is the
   * card being dragged, and moves with the pointer.
   */
  const dragEls = useRef<{
    card: HTMLElement;
    edges: { path: SVGPathElement; source: Placed | null; target: Placed | null }[];
  } | null>(null);

  /**
   * Take the board out of hit-testing for the rest of the gesture. Sweeping the
   * cursor across it otherwise fires mouseenter on every card crossed, and each
   * one re-walks every edge and card to repaint the hover highlight — the most
   * expensive thing a fast drag can trigger.
   *
   * Deliberately not called on mouse-down: see the note in the card branch.
   */
  const beginDragSkin = useCallback(() => {
    containerRef.current?.classList.add('dragging');
  }, []);

  /**
   * Set when a gesture actually dragged. The mouse-up at the end of a drag
   * still produces a click, and because the board is out of hit-testing by
   * then it lands on the canvas — which otherwise reads as "clicked empty
   * space" and throws the selection away.
   */
  const suppressClick = useRef(false);

  const onContainerMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const card = (e.target as HTMLElement).closest('.gcard') as HTMLElement | null;
    const rect = containerRef.current!.getBoundingClientRect();
    if (card) {
      const id = card.dataset.id!;
      const p = model.placed.get(id);
      if (p) {
        dragState.current = { kind: 'card', id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
        // Resolve the card and its edges once, here, rather than on every
        // mousemove: the edge selector scans every path in the SVG, and doing
        // that at mouse-report rate is what makes a fast drag feel heavy.
        const sel = CSS.escape(id);
        dragEls.current = {
          card,
          edges: [
            ...(worldRef.current?.querySelectorAll<SVGPathElement>(`path[data-s="${sel}"], path[data-t="${sel}"]`) ??
              []),
          ].map((path) => ({
            path,
            source: path.dataset.s === id ? null : (model.placed.get(path.dataset.s!) ?? null),
            target: path.dataset.t === id ? null : (model.placed.get(path.dataset.t!) ?? null),
          })),
        };
      }
      return;
    }
    /*
     * Which gesture a plain drag is.
     *
     * Box-select behind Ctrl is invisible to anyone who has not been told, so
     * the toolbar has a toggle that swaps the two: with it on, dragging picks
     * files and Ctrl pans. The pair is always available either way round, so
     * neither mode strands you without the other gesture.
     */
    const wantsBox = selectMode !== (e.ctrlKey || e.metaKey);
    if (wantsBox && !(e.target as HTMLElement).closest('button')) {
      dragState.current = { kind: 'box', sx: e.clientX - rect.left, sy: e.clientY - rect.top };
      return;
    }
    if ((e.target as HTMLElement).closest('button, .legend, .graph-overlay')) return;
    dragState.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    containerRef.current?.classList.add('panning');
  };

  useEffect(() => {
    // A mouse reports faster than the screen refreshes — a 1000Hz mouse fires
    // ~16 moves per frame. Doing the work per event means 15 of every 16
    // updates are overwritten before anything is painted, which is exactly the
    // shape of "dragging fast feels laggy". Coalesce to one update per frame.
    let raf = 0;
    let latest: MouseEvent | null = null;

    const flush = () => {
      raf = 0;
      const e = latest;
      const d = dragState.current;
      if (!e || !d) return;
      if (d.kind === 'pan') {
        beginDragSkin();
        userMoved.current = true;
        viewRef.current.x = d.vx + (e.clientX - d.sx);
        viewRef.current.y = d.vy + (e.clientY - d.sy);
        applyView();
      } else if (d.kind === 'box') {
        beginDragSkin();
        const rect = containerRef.current!.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setSelectRect({ x: Math.min(d.sx, x), y: Math.min(d.sy, y), w: Math.abs(x - d.sx), h: Math.abs(y - d.sy) });
      } else if (d.kind === 'card') {
        const k = viewRef.current.k;
        const dx = (e.clientX - d.sx) / k;
        const dy = (e.clientY - d.sy) / k;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        // only once the pointer has genuinely travelled: a click is a
        // mousedown and a mouseup on the same element, and taking the card out
        // of hit-testing in between turns every click into a click on the board
        if (!d.moved) return;
        beginDragSkin();
        dragEls.current?.card.classList.add('dragging');
        const els = dragEls.current;
        const p = model.placed.get(d.id);
        if (!els || !p) return;
        const nx = d.ox + dx;
        const ny = d.oy + dy;
        // translate rather than left/top: no layout, straight to compositing
        els.card.style.transform = `translate(${nx - p.x}px, ${ny - p.y}px)`;
        const dragged = { ...p, x: nx, y: ny };
        for (const edge of els.edges) {
          const s = edge.source ?? dragged;
          const t = edge.target ?? dragged;
          edge.path.setAttribute('d', edgePath(s, t));
        }
      }
    };

    const move = (e: MouseEvent) => {
      if (!dragState.current) return;
      latest = e;
      if (raf === 0) raf = requestAnimationFrame(flush);
    };

    const up = (e: MouseEvent) => {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      latest = null;
      const d = dragState.current;
      dragState.current = null;
      if (containerRef.current?.classList.contains('dragging')) suppressClick.current = true;
      containerRef.current?.classList.remove('dragging');
      /*
       * Landing a card is three changes that must all happen in one frame.
       *
       * A card carries a 110ms transform transition, switched off by its
       * `dragging` class. Undoing the drag here — dropping the class, then
       * clearing the transform — re-enabled that transition and then animated
       * the transform back to zero, so the card flew most of the way home
       * before React committed its new left/top and snapped it to where it was
       * actually dropped. That flight is the ricochet.
       *
       * So the card keeps both its class and its transform until React has
       * committed the new position, and a layout effect then clears the
       * transform *while transitions are still off* and only afterwards drops
       * the class. Nothing is painted in between, so there is nothing to see.
       */
      if (dragEls.current && d?.kind === 'card' && d.moved) {
        clearTransformAfterCommit.current = dragEls.current.card;
      } else if (dragEls.current) {
        dragEls.current.card.classList.remove('dragging');
        dragEls.current.card.style.transform = '';
      }
      dragEls.current = null;
      containerRef.current?.classList.remove('panning');
      if (!d) return;
      if (d.kind === 'box') {
        setSelectRect(null);
        const rect = containerRef.current!.getBoundingClientRect();
        const x2 = e.clientX - rect.left;
        const y2 = e.clientY - rect.top;
        const x1 = Math.min(d.sx, x2);
        const y1 = Math.min(d.sy, y2);
        const xb = Math.max(d.sx, x2);
        const yb = Math.max(d.sy, y2);
        if (xb - x1 < 6 && yb - y1 < 6) return;
        const v = viewRef.current;
        const hits: string[] = [];
        for (const p of model.placed.values()) {
          const cx = (p.x + p.w / 2) * v.k + v.x;
          const cy = (p.y + p.h / 2) * v.k + v.y;
          if (cx >= x1 && cx <= xb && cy >= y1 && cy <= yb) hits.push(p.node.id);
        }
        if (hits.length > 0) onBoxSelect(hits);
      } else if (d.kind === 'card' && d.moved) {
        const k = viewRef.current.k;
        overridesRef.current[d.id] = { x: d.ox + (e.clientX - d.sx) / k, y: d.oy + (e.clientY - d.sy) / k };
        const toSave: Record<string, { x: number; y: number }> = {};
        for (const [id, p] of Object.entries(overridesRef.current)) {
          toSave[`card:${id}`] = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
        }
        void api.positionsSave(toSave);
        setOverridesVersion((v) => v + 1);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [model, applyView, onBoxSelect]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX - rect.left, e.clientY - rect.top);
  };

  // ------------------------------------------------------------------
  // click semantics
  // ------------------------------------------------------------------
  const findPath = useCallback(
    (from: string, to: string) => {
      const adj = new Map<string, string[]>();
      for (const e of fullEdges.values()) {
        if (!adj.has(e.source)) adj.set(e.source, []);
        if (!adj.has(e.target)) adj.set(e.target, []);
        adj.get(e.source)!.push(e.target);
        adj.get(e.target)!.push(e.source);
      }
      const prev = new Map<string, string>();
      const queue = [from];
      const seen = new Set([from]);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur === to) break;
        for (const next of adj.get(cur) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            prev.set(next, cur);
            queue.push(next);
          }
        }
      }
      if (!seen.has(to)) {
        pathHl.current = null;
        setPathVersion((v) => v + 1);
        return;
      }
      const nodes: string[] = [to];
      let cur = to;
      while (cur !== from) {
        cur = prev.get(cur)!;
        nodes.push(cur);
      }
      const edges = new Set<string>();
      for (let i = 0; i + 1 < nodes.length; i++) {
        edges.add(`${nodes[i]}\n${nodes[i + 1]}`);
        edges.add(`${nodes[i + 1]}\n${nodes[i]}`);
      }
      pathHl.current = { nodes: new Set(nodes), edges };
      setPathVersion((v) => v + 1);
    },
    [fullEdges],
  );

  const onCardClick = (e: React.MouseEvent, n: RenderNode) => {
    e.stopPropagation();
    if (dragState.current) return;
    if (e.ctrlKey || e.metaKey) {
      onToggleSelect(n.id);
      return;
    }
    if (e.shiftKey && selected && selected !== n.id) {
      findPath(selected, n.id);
      return;
    }
    pathHl.current = null;
    setPathVersion((v) => v + 1);
    onSelect(n.id);
  };

  const onCardDoubleClick = (e: React.MouseEvent, n: RenderNode) => {
    e.stopPropagation();
    if (n.kind === 'dir') {
      onToggleDir(n.dir?.dir ?? n.cluster);
      return;
    }
    const sym = parseSymbolNode(n.id);
    if (sym) {
      onOpenFile(sym.path, n.symbol?.line);
      return;
    }
    onOpenFile(n.id);
  };

  // hover highlighting (imperative for zero re-renders)
  const hoverId = useRef<string | null>(null);
  const applyHover = useCallback(() => {
    const id = hoverId.current;
    const world = worldRef.current;
    if (!world || dragState.current) return;
    const related = new Set<string>();
    world.querySelectorAll('path.gedge').forEach((raw) => {
      const p = raw as SVGPathElement;
      const isOut = id !== null && p.dataset.s === id;
      const isIn = id !== null && p.dataset.t === id;
      p.classList.toggle('out', isOut);
      p.classList.toggle('in', isIn);
      p.classList.toggle('faded', id !== null && !isOut && !isIn);
      if (isOut) related.add(p.dataset.t!);
      if (isIn) related.add(p.dataset.s!);
    });
    world.querySelectorAll('.gcard').forEach((raw) => {
      const c = raw as HTMLElement;
      c.classList.toggle('faded', id !== null && c.dataset.id !== id && !related.has(c.dataset.id!));
    });
  }, []);

  // ------------------------------------------------------------------
  // render helpers
  // ------------------------------------------------------------------
  const query = searchQuery.trim().toLowerCase();

  const born = (id: string) => {
    if (knownIds.current.has(id)) return false;
    knownIds.current.add(id);
    return didInitialFit.current;
  };

  const now = Date.now();

  const { contested, collisions } = useMemo(() => conflictMarks(conflicts ?? []), [conflicts]);

  const trails = useMemo(() => {
    const cutoff = now - 4 * 60 * 1000;
    const byAgent = new Map<string, { x: number; y: number; time: number }[]>();
    for (const c of recentChanges) {
      if (c.time < cutoff || c.agent === 'you') continue;
      let p = model.placed.get(c.path);
      if (!p) {
        const node = fullNodes.get(c.path);
        if (node) p = model.placed.get(`@dir:${node.cluster}`);
      }
      if (!p) continue;
      if (!byAgent.has(c.agent)) byAgent.set(c.agent, []);
      byAgent.get(c.agent)!.push({ x: p.x + p.w / 2, y: p.y + p.h / 2, time: c.time });
    }
    return byAgent;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentChanges, model]);

  return (
    <div
      className={`canvas-view${selectMode ? ' picking' : ''}`}
      ref={containerRef}
      data-testid="graph-container"
      onMouseDown={onContainerMouseDown}
      onWheel={onWheel}
      onClick={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        if (!(e.target as HTMLElement).closest('.gcard') && !(e.target as HTMLElement).closest('button')) {
          pathHl.current = null;
          setPathVersion((v) => v + 1);
          onSelect(null);
        }
      }}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('.gcard')) fitView();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const card = (e.target as HTMLElement).closest('.gcard') as HTMLElement | null;
        onNodeContextMenu({ x: e.clientX, y: e.clientY, id: card?.dataset.id ?? null });
      }}
    >
      <div className="canvas-world" ref={worldRef}>
        <svg className="canvas-edges" data-pathv={pathVersion}>
          {model.edges.map((e) => {
            const key = `${e.source}\n${e.target}`;
            const onPath = pathHl.current?.edges.has(key);
            const collision = collisions.get(key);
            const cls = [
              'gedge',
              e.kind === 'intra' ? 'intra' : '',
              onPath ? 'onpath' : '',
              collision ? 'collision' : '',
              pathHl.current && !onPath ? 'faded' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <path
                key={key}
                className={cls}
                data-s={e.source}
                data-t={e.target}
                d={edgePath(e.a, e.b)}
                // width lives in a custom property so the hover state can
                // scale it — at rest these are structure, on hover they are
                // the answer
                style={{ '--w': `${Math.min(1.1, 0.5 + Math.log2(1 + e.weight) * 0.2)}px` } as React.CSSProperties}
              >
                {collision && <title>{collision}</title>}
              </path>
            );
          })}
          {[...trails.entries()].map(([agent, pts]) =>
            pts.length >= 2 ? (
              <polyline
                key={agent}
                className="gtrail"
                points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                style={{ stroke: agentColor(agent) }}
              />
            ) : null,
          )}
        </svg>

        {model.plates.map((pl) => (
          <div
            key={`plate:${pl.id}`}
            className="symbol-plate"
            style={{ left: pl.x, top: pl.y, width: pl.w, height: pl.h }}
            aria-hidden="true"
          />
        ))}
        {model.captions.map((c) => (
          <div key={c.cluster} className="cluster-caption" style={{ left: c.x, top: c.y, color: clusterColorRef.current(c.cluster === '(root)' ? '' : c.cluster) }}>
            {c.cluster.toUpperCase()}
          </div>
        ))}

        {[...model.placed.values()].map((p) => {
          const n = p.node;
          const file = n.file;
          const clusterHue = clusterColorRef.current(n.cluster === '(root)' ? '' : n.cluster);
          const color = file
            ? lensColor(file, lensCtx)
            : n.kind === 'dir' && lens !== 'clusters'
              ? (dirColor.get(n.dir?.dir ?? n.cluster)?.color ?? clusterHue)
              : clusterHue;
          // under a magnitude lens the colour also gets *area*: a 4px rail is
          // a small signal even when it is the brightest thing on screen
          const intensity =
            lens === 'clusters'
              ? 0
              : file
                ? lensValue(file, lensCtx, maxComplexity)
                : (dirColor.get(n.dir?.dir ?? n.cluster)?.value ?? 0);
          const unrev = n.kind !== 'dir' && isUnreviewed(n.id, changedAt, reviewInfo);
          const fresh = unrev && now - (changedAt[n.id] ?? 0) < 90_000;
          const agent = changedBy[n.id];
          const contestedParties = contested.get(n.id);
          /* a folder card stands in for what is inside it, notices included */
          const spoken = held
            ? n.kind === 'dir' && n.dir
              ? noticesUnder(held, n.dir.dir)
              : (held.get(n.id) ?? [])
            : [];
          const claim = spoken.length > 0;
          const miss = query !== '' && !n.id.toLowerCase().includes(query);
          const classes = [
            'gcard',
            claim ? 'claimed' : '',
            n.kind === 'dir' ? 'folder' : '',
            n.kind === 'symbol' ? 'symbol' : '',
            n.kind === 'hub' ? 'hub' : '',
            selected === n.id ? 'sel' : '',
            selectedPaths.has(n.id) && selected !== n.id ? 'msel' : '',
            unrev ? 'unrev' : '',
            fresh ? 'pulse' : '',
            miss || (pathHl.current && !pathHl.current.nodes.has(n.id)) ? 'dimmed' : '',
            born(n.id) ? 'born' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={n.id}
              className={classes}
              data-id={n.id}
              data-testid={`gcard-${n.id}`}
              title={
                file
                  ? `${n.id}\n${file.loc} loc · cx ${file.complexity} · ${file.inDegree} importers · ${file.outDegree} imports`
                  : n.id.replace('@dir:', '')
              }
              style={
                {
                  left: p.x,
                  top: p.y,
                  width: p.w,
                  height: p.h,
                  '--lens': color,
                  '--lens-intensity': intensity.toFixed(3),
                  ...(claim ? { '--agent': agentColor(spoken[0].agentId) } : {}),
                } as React.CSSProperties
              }
              onClick={(e) => onCardClick(e, n)}
              onDoubleClick={(e) => onCardDoubleClick(e, n)}
              onMouseEnter={() => {
                hoverId.current = n.id;
                applyHover();
              }}
              onMouseLeave={() => {
                hoverId.current = null;
                applyHover();
              }}
            >
              <span className="grail" style={{ background: color, flexBasis: 3 + intensity * 7, width: 3 + intensity * 7 }} />
              {n.kind === 'dir' && n.dir ? (
                <>
                  <span className="gname">
                    <b>▸ {folderLabel(n.dir.dir)}</b>
                    <span className="gsub">
                      {plural(n.dir.files, 'file')} · {num(n.dir.loc)} loc
                    </span>
                  </span>
                  <span className="gbadges">
                    {claim && <HeldMark notices={spoken} inside />}
                    {n.dir.untested > 0 && <span className="gb crit">{n.dir.untested}∅t</span>}
                    {n.dir.cycles > 0 && <span className="gb crit">∞</span>}
                  </span>
                </>
              ) : n.kind === 'symbol' && n.symbol ? (
                <span className="gname mono">
                  {n.symbol.symKind === 'class' ? '◆' : n.symbol.symKind === 'function' ? 'ƒ' : '·'} {n.label}
                </span>
              ) : file ? (
                <>
                  <span className="gname">{n.label}</span>
                  <span className="gbadges">
                    {/* who is *in* this file right now, ahead of every badge
                        that says what happened to it — the only mark here that
                        is about the next few minutes rather than the last few */}
                    {claim && <HeldMark notices={spoken} />}
                    {/*
                      One dot, two states. Normally it is who changed this
                      file; when two agents both wrote it the same dot splits
                      down the middle into both of their colours, because
                      "contested" is a fact *about the author*, not a separate
                      thing to badge. A card 36px tall cannot afford a second
                      mark for it, and does not need one.
                    */}
                    {contestedParties ? (
                      <span
                        className="gagent contested"
                        title={`written by ${contestedParties.map((a) => a.label).join(' and ')} — read the diff before keeping either`}
                        style={{
                          background: `linear-gradient(90deg, ${agentColor(contestedParties[0].id)} 0 50%, ${agentColor(
                            contestedParties[1].id,
                          )} 50% 100%)`,
                        }}
                      />
                    ) : (
                      agent &&
                      agent !== 'you' &&
                      unrev && (
                        <span className="gagent" title={`changed by ${agent}`} style={{ background: agentColor(agent) }} />
                      )
                    )}
                    {/* Every badge carries its own tooltip. They are two or three
                        characters on a 36px card, so without one "∅t" and "8⚑︎"
                        are shapes rather than facts. */}
                    {file.complexity >= 40 && (
                      <span
                        className="gb warn"
                        title={`Cyclomatic complexity ${file.complexity} — the number of branches through this file. Shown once it passes 40.`}
                      >
                        cx{file.complexity}
                      </span>
                    )}
                    {coverage[n.id] ? (
                      <span
                        className={`gb ${coverage[n.id].pct >= 70 ? 'good' : coverage[n.id].pct >= 40 ? 'warn' : 'crit'}`}
                        title={`${Math.round(coverage[n.id].pct)}% line coverage — ${coverage[n.id].hit} of ${coverage[n.id].found} lines run under the test suite`}
                      >
                        {Math.round(coverage[n.id].pct)}%
                      </span>
                    ) : !file.isTest && file.testedBy === 0 ? (
                      <span className="gb crit" title="No test file imports this one, and there is no coverage data for it">
                        ∅t
                      </span>
                    ) : null}
                    {file.todos > 0 && (
                      <span className="gb" title={`${plural(file.todos, 'TODO')} / FIXME / HACK comment left in this file`}>
                        {file.todos}⚑︎
                      </span>
                    )}
                    {file.cycleId !== null && (
                      <span className="gb crit" title="This file is part of an import cycle — edits here ripple unpredictably">
                        ∞
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <span className="gname">{n.label}</span>
              )}
            </div>
          );
        })}
      </div>
      {selectRect && (
        <div className="select-rect" style={{ left: selectRect.x, top: selectRect.y, width: selectRect.w, height: selectRect.h }} />
      )}
    </div>
  );
});

function edgePath(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): string {
  const forward = a.x + a.w <= b.x + 8;
  const x1 = forward ? a.x + a.w : a.x;
  const y1 = a.y + a.h / 2;
  const x2 = forward ? b.x : b.x + b.w;
  const y2 = b.y + b.h / 2;
  const dx = Math.max(46, Math.abs(x2 - x1) / 2);
  const c1 = forward ? x1 + dx : x1 - dx;
  const c2 = forward ? x2 - dx : x2 + dx;
  return `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`;
}
