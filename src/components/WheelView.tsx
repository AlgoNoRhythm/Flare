import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { STATUS, makeClusterColors } from '../theme';
import { agentColor } from '../graph/lenses';
import { conflictMarks } from '../../shared/conflicts';
import { buildLensContext, lensColor, type LensContext } from '../graph/lensColor';
import { deriveRenderModel, folderLabel, parseSymbolNode, type RenderNode } from '../graph/renderModel';
import type { CanvasProps, GraphViewHandle } from './CanvasView';
import type { ReviewInfo } from '../api';

/**
 * Radial view: every node sits on one ring ordered by directory, dependencies
 * are drawn as bundled chords across the middle. Reading a repo here is about
 * *direction* — what a node pulls in (blue, outward) versus what pulls on it
 * (amber, inward) — so hovering and pinning are the primary verbs.
 */

const LABEL_GAP = 7;
const CLUSTER_GAP_SLOTS = 1.6;

/**
 * Width of the index rail, and the room the wheel gives up for it.
 *
 * The ring is the only view here that cannot be read by name. Every node is a
 * dot at an angle, and finding `resolver.ts` among six hundred of them means
 * spinning the wheel and reading labels at whatever rotation they land at.
 * The rail is that same ring unrolled into a column you can scroll: same
 * order, same colours, same grouping — so scrolling down the list is walking
 * clockwise round the wheel, and the two are obviously one thing rather than
 * a picture with a menu beside it.
 */
const INDEX_W = 212;

interface Leaf {
  node: RenderNode;
  angle: number;
  x: number;
  y: number;
  r: number;
  cluster: string;
}

function isUnreviewed(path: string, changedAt: Record<string, number>, review: ReviewInfo | null): boolean {
  const changed = changedAt[path];
  if (!changed) return false;
  return changed > Math.max(review?.review.approvedAt[path] ?? 0, review?.review.checkpointAt ?? 0);
}

function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number, reverse = false): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return reverse
    ? `M ${x1} ${y1} A ${r} ${r} 0 ${large} 0 ${x0} ${y0}`
    : `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

/** ~width of a leaf label in px at the wheel's label size. */
function labelWidth(text: string): number {
  return Math.min(118, text.length * 5.1 + 10);
}

export const WheelView = forwardRef<GraphViewHandle, CanvasProps>(function WheelView(props, ref) {
  const {
    graphVersion,
    fullNodes,
    fullEdges,
    projectRoot,
    changedAt,
    changedBy,
    churn,
    coverage,
    reviewInfo,
    selected,
    selectedPaths,
    searchQuery,
    lens,
    collapsedDirs,
    expandedFiles,
    symbolGraphs,
    conflicts,
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
  const zoomRef = useRef<SVGGElement | null>(null);
  const spinRef = useRef<SVGGElement | null>(null);
  const clusterColorRef = useRef(makeClusterColors());
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 900, h: 600 });
  const [rot, setRot] = useState(-Math.PI / 2);
  const [pinned, setPinned] = useState<string | null>(null);
  const [selectRect, setSelectRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  /** the index rail, open by default — it is how you find a file by name here */
  const [indexOpen, setIndexOpen] = useState(true);
  const indexBodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    clusterColorRef.current = makeClusterColors();
  }, [projectRoot]);

  // ------------------------------------------------------------------
  // measure
  // ------------------------------------------------------------------
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

  // ------------------------------------------------------------------
  // model
  // ------------------------------------------------------------------
  const model = useMemo(() => {
    const derived = deriveRenderModel(
      fullNodes,
      [...fullEdges.values()],
      { collapsedDirs, expandedFiles },
      symbolGraphs,
    );
    // the toolbar overlay covers the top strip — push the wheel below it and
    // reserve exactly as much room as the longest leaf label needs
    const TOP = 56;
    // the rail is reserved rather than overlaid: a wheel centred under a panel
    // has its left third permanently behind it, and spinning to read a label
    // that never comes out from under the rail is a trap
    const LEFT = indexOpen ? INDEX_W : 0;
    const cx = LEFT + (size.w - LEFT) / 2;
    const cy = TOP + (size.h - TOP) / 2;
    const avail = Math.min(size.w - LEFT, size.h - TOP) / 2 - 14;
    // the 85th percentile, not the max — one very long filename shouldn't
    // shrink the whole wheel
    const widths = derived.nodes
      .map((n) => labelWidth(n.kind === 'dir' ? folderLabel(n.dir?.dir ?? n.cluster) : n.label))
      .sort((a, b) => a - b);
    const labelRoom = Math.min(104, Math.max(38, widths[Math.floor(widths.length * 0.85)] ?? 60));
    const R = Math.max(80, avail - labelRoom - 26);
    const bandR = R + labelRoom + 15;

    // group by cluster, deterministic order
    const groups = new Map<string, RenderNode[]>();
    for (const n of derived.nodes) {
      const c = n.cluster || '(root)';
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c)!.push(n);
    }
    const orderedClusters = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    for (const list of groups.values()) list.sort((a, b) => a.id.localeCompare(b.id));

    const totalLeaves = derived.nodes.length;
    const slots = totalLeaves + orderedClusters.length * CLUSTER_GAP_SLOTS;
    const step = slots > 0 ? (Math.PI * 2) / slots : 0;

    const leaves = new Map<string, Leaf>();
    const arcs: { cluster: string; a0: number; a1: number; mid: number; count: number; collapsed: boolean }[] = [];
    const maxLoc = Math.max(1, ...derived.nodes.map((n) => n.loc));
    // on a crowded ring the dots have to shrink to the space between slots,
    // otherwise 600 files fuse into one solid band
    const dotMax = Math.max(1.4, Math.min(8, step * R * 0.46));
    let cursor = rot;
    for (const cluster of orderedClusters) {
      const list = groups.get(cluster)!;
      const a0 = cursor;
      for (const node of list) {
        const angle = cursor;
        const size1 =
          node.kind === 'dir' ? dotMax : dotMax * (0.42 + 0.58 * Math.sqrt(node.loc / maxLoc));
        const [x, y] = polar(cx, cy, R, angle);
        leaves.set(node.id, { node, angle, x, y, r: size1, cluster });
        cursor += step;
      }
      const a1 = cursor - step;
      arcs.push({
        cluster,
        a0: a0 - step * 0.4,
        a1: a1 + step * 0.4,
        mid: (a0 + a1) / 2,
        count: list.length,
        collapsed: collapsedDirs.has(cluster),
      });
      cursor += step * CLUSTER_GAP_SLOTS;
    }

    const edges = derived.edges
      .map((e) => {
        const a = leaves.get(e.source);
        const b = leaves.get(e.target);
        if (!a || !b) return null;
        let d = Math.abs(a.angle - b.angle) % (Math.PI * 2);
        if (d > Math.PI) d = Math.PI * 2 - d;
        const ctrlR = R * (0.88 - 0.62 * (d / Math.PI));
        const [c1x, c1y] = polar(cx, cy, ctrlR, a.angle);
        const [c2x, c2y] = polar(cx, cy, ctrlR, b.angle);
        return {
          ...e,
          d: `M ${a.x} ${a.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${b.x} ${b.y}`,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    // adjacency for direction-aware highlighting
    const out = new Map<string, Set<string>>();
    const inc = new Map<string, Set<string>>();
    for (const e of derived.edges) {
      if (!out.has(e.source)) out.set(e.source, new Set());
      if (!inc.has(e.target)) inc.set(e.target, new Set());
      out.get(e.source)!.add(e.target);
      inc.get(e.target)!.add(e.source);
    }

    return { leaves, arcs, edges, cx, cy, R, bandR, out, inc, count: derived.nodes.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphVersion, fullNodes, fullEdges, collapsedDirs, expandedFiles, symbolGraphs, size, rot, indexOpen]);

  /**
   * The ring, unrolled.
   *
   * Read straight off `model.leaves`, which is a Map built in ring order — so
   * this cannot drift out of step with the wheel by construction, which is the
   * one property that makes the rail worth having. Grouped the way the file
   * tree groups, by directory, with the same headers the cluster bands carry.
   */
  const indexGroups = useMemo(() => {
    const groups: { cluster: string; leaves: Leaf[] }[] = [];
    for (const leaf of model.leaves.values()) {
      const last = groups[groups.length - 1];
      if (last && last.cluster === leaf.cluster) last.leaves.push(leaf);
      else groups.push({ cluster: leaf.cluster, leaves: [leaf] });
    }
    return groups;
  }, [model]);

  const lensCtx = useMemo<LensContext>(() => {
    return buildLensContext(fullNodes.values(), {
      lens,
      churn,
      coverage,
      reuse: props.reuse,
      changedAt,
      readAt: reviewInfo?.review.readAt ?? {},
      clusterColor: (c) => clusterColorRef.current(c),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens, churn, coverage, changedAt, reviewInfo, graphVersion, props.theme]);

  useEffect(() => {
    const counts = new Map<string, number>();
    for (const n of fullNodes.values()) {
      const c = n.cluster || '(root)';
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    onStats({
      nodes: model.leaves.size,
      edges: model.edges.length,
      clusters: [...counts.entries()]
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
  // viewport
  // ------------------------------------------------------------------
  const applyView = useCallback(() => {
    const v = viewRef.current;
    zoomRef.current?.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.k})`);
    onZoom?.(Math.round(v.k * 100));
  }, [onZoom]);

  const zoomAt = useCallback(
    (factor: number, mx?: number, my?: number) => {
      const v = viewRef.current;
      const px = mx ?? size.w / 2;
      const py = my ?? size.h / 2;
      const k2 = Math.min(6, Math.max(0.3, v.k * factor));
      v.x = px - (px - v.x) * (k2 / v.k);
      v.y = py - (py - v.y) * (k2 / v.k);
      v.k = k2;
      applyView();
    },
    [applyView, size],
  );

  const fitView = useCallback(() => {
    viewRef.current = { x: 0, y: 0, k: 1 };
    applyView();
  }, [applyView]);

  useImperativeHandle(ref, () => ({
    relayout() {
      setRot(-Math.PI / 2);
      setPinned(null);
      fitView();
    },
    focusNode(id: string) {
      // spin the wheel so the node lands at the top, then pin its dependencies
      const leaf = model.leaves.get(id);
      if (!leaf) return;
      setRot((r) => r + (-Math.PI / 2 - leaf.angle));
      setPinned(id);
    },
    zoom(direction: 1 | -1) {
      zoomAt(direction === 1 ? 1.3 : 1 / 1.3);
    },
    fitView,
    // the wheel is drawn around the middle already, so centring is a pan reset
    centerView() {
      viewRef.current = { ...viewRef.current, x: 0, y: 0 };
      applyView();
    },
  }));

  // ------------------------------------------------------------------
  // highlight (imperative — no re-render on hover)
  // ------------------------------------------------------------------
  const hoverRef = useRef<string | null>(null);
  const hoverClusterRef = useRef<string | null>(null);
  const dense = model.leaves.size > 90;

  const applyHighlight = useCallback(() => {
    const root = spinRef.current;
    if (!root) return;
    // a pin wins over hover: pin it, then read the labels at your leisure
    const id = pinned ?? hoverRef.current;
    const cluster = id === null ? hoverClusterRef.current : null;
    const outs = id ? (model.out.get(id) ?? new Set<string>()) : new Set<string>();
    const ins = id ? (model.inc.get(id) ?? new Set<string>()) : new Set<string>();
    const inCluster = (nid: string) => model.leaves.get(nid)?.cluster === cluster;

    root.querySelectorAll('path.wedge').forEach((raw) => {
      const p = raw as SVGPathElement;
      const isOut = id !== null && p.dataset.s === id;
      const isIn = id !== null && p.dataset.t === id;
      const touchesCluster = cluster !== null && (inCluster(p.dataset.s!) || inCluster(p.dataset.t!));
      p.classList.toggle('out', isOut);
      p.classList.toggle('in', isIn);
      p.classList.toggle('faded', (id !== null && !isOut && !isIn) || (cluster !== null && !touchesCluster));
    });
    root.querySelectorAll('g.wnode').forEach((raw) => {
      const g = raw as SVGGElement;
      const nid = g.dataset.id!;
      const isSelf = nid === id;
      const isOut = outs.has(nid);
      const isIn = ins.has(nid);
      const inC = cluster !== null && inCluster(nid);
      g.classList.toggle('hi', isSelf);
      g.classList.toggle('outn', isOut);
      g.classList.toggle('inn', isIn);
      g.classList.toggle('faded', (id !== null && !isSelf && !isOut && !isIn) || (cluster !== null && !inC));
      g.classList.toggle(
        'labeled',
        id !== null ? isSelf || isOut || isIn : cluster !== null ? inC : !dense,
      );
    });

    const info = root.ownerSVGElement?.parentElement?.querySelector('.wheel-hub-detail');
    if (info) {
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
      info.textContent =
        id !== null
          ? `${id.split('/').pop()} — ${plural(outs.size, 'import')} · ${plural(ins.size, 'importer')}`
          : cluster !== null
            ? `${cluster}/ — ${plural(model.arcs.find((a) => a.cluster === cluster)?.count ?? 0, 'node')}`
            : `${model.count} nodes · ${model.edges.length} links`;
    }
    const hint = root.ownerSVGElement?.parentElement?.querySelector('.wheel-hub-hint');
    if (hint) {
      hint.textContent = pinned
        ? 'pinned — click empty space to release'
        : 'drag to spin · alt+wheel to rotate';
    }
  }, [model, pinned, dense]);

  useEffect(() => {
    applyHighlight();
  }, [applyHighlight]);

  // ------------------------------------------------------------------
  // pointer: rotate-drag, ctrl box select, wheel zoom, shift-drag pan
  // ------------------------------------------------------------------
  const drag = useRef<
    | { kind: 'spin'; startAngle: number; delta: number }
    | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
    | { kind: 'box'; sx: number; sy: number }
    | null
  >(null);

  const angleAt = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current!.getBoundingClientRect();
      const v = viewRef.current;
      const x = (clientX - rect.left - v.x) / v.k - model.cx;
      const y = (clientY - rect.top - v.y) / v.k - model.cy;
      return Math.atan2(y, x);
    },
    [model],
  );

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // a press that starts on a node is a click, never a spin
    if ((e.target as Element).closest('button, .legend, .graph-overlay, .wnode')) return;
    const rect = containerRef.current!.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      drag.current = { kind: 'box', sx: e.clientX - rect.left, sy: e.clientY - rect.top };
      return;
    }
    if (e.shiftKey) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
      containerRef.current?.classList.add('panning');
      return;
    }
    drag.current = { kind: 'spin', startAngle: angleAt(e.clientX, e.clientY), delta: 0 };
    containerRef.current?.classList.add('spinning');
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.kind === 'spin') {
        d.delta = angleAt(e.clientX, e.clientY) - d.startAngle;
        spinRef.current?.setAttribute(
          'transform',
          `rotate(${(d.delta * 180) / Math.PI} ${model.cx} ${model.cy})`,
        );
      } else if (d.kind === 'pan') {
        viewRef.current.x = d.vx + (e.clientX - d.sx);
        viewRef.current.y = d.vy + (e.clientY - d.sy);
        applyView();
      } else {
        const rect = containerRef.current!.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setSelectRect({ x: Math.min(d.sx, x), y: Math.min(d.sy, y), w: Math.abs(x - d.sx), h: Math.abs(y - d.sy) });
      }
    };
    const up = (e: MouseEvent) => {
      const d = drag.current;
      drag.current = null;
      containerRef.current?.classList.remove('panning', 'spinning');
      if (!d) return;
      if (d.kind === 'spin') {
        spinRef.current?.removeAttribute('transform');
        if (Math.abs(d.delta) > 0.002) setRot((r) => r + d.delta);
      } else if (d.kind === 'box') {
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
        for (const leaf of model.leaves.values()) {
          const sx = leaf.x * v.k + v.x;
          const sy = leaf.y * v.k + v.y;
          if (sx >= x1 && sx <= xb && sy >= y1 && sy <= yb) hits.push(leaf.node.id);
        }
        if (hits.length > 0) onBoxSelect(hits);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [model, angleAt, applyView, onBoxSelect]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    if (e.altKey) {
      setRot((r) => r + e.deltaY * 0.0016);
      return;
    }
    zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX - rect.left, e.clientY - rect.top);
  };

  // ------------------------------------------------------------------
  // clicks
  // ------------------------------------------------------------------
  const onNodeClick = (e: React.MouseEvent, n: RenderNode) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      onToggleSelect(n.id);
      return;
    }
    setPinned((p) => (p === n.id ? null : n.id));
    onSelect(n.id);
  };

  /**
   * A row in the rail is the node it names.
   *
   * It does one thing the node itself does not: it spins the wheel so the node
   * lands at the top. Clicking a name in a list and having something light up
   * behind your cursor, off at four o'clock, is not selecting it on the wheel
   * — bringing it round to where you are looking is.
   */
  const onIndexClick = (e: React.MouseEvent, leaf: Leaf) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      onToggleSelect(leaf.node.id);
      return;
    }
    setRot((r) => r + (-Math.PI / 2 - leaf.angle));
    setPinned(leaf.node.id);
    onSelect(leaf.node.id);
  };

  /*
   * Selecting on the wheel scrolls the rail to match.
   *
   * Without this the two halves agree only while you drive from the list —
   * click a dot on the ring and the name of what you just picked is somewhere
   * up in four hundred rows you would have to hunt through.
   */
  useEffect(() => {
    if (!indexOpen || !selected) return;
    const body = indexBodyRef.current;
    if (!body) return;
    const row = body.querySelector(`[data-wid="${CSS.escape(selected)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selected, indexOpen, indexGroups]);

  const onNodeDoubleClick = (e: React.MouseEvent, n: RenderNode) => {
    e.stopPropagation();
    if (n.kind === 'dir') {
      onToggleDir(n.dir?.dir ?? n.cluster);
      return;
    }
    const sym = parseSymbolNode(n.id);
    onOpenFile(sym ? sym.path : n.id, n.symbol?.line);
  };

  const query = searchQuery.trim().toLowerCase();
  const now = Date.now();
  const { contested } = conflictMarks(conflicts ?? []);

  return (
    <div
      className="wheel-view"
      ref={containerRef}
      data-testid="graph-container"
      onMouseDown={onMouseDown}
      onWheel={onWheel}
      onClick={(e) => {
        if (!(e.target as Element).closest('.wnode, button')) {
          setPinned(null);
          onSelect(null);
        }
      }}
      onDoubleClick={(e) => {
        if (!(e.target as Element).closest('.wnode')) fitView();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const g = (e.target as Element).closest('.wnode') as SVGGElement | null;
        onNodeContextMenu({ x: e.clientX, y: e.clientY, id: g?.dataset.id ?? null });
      }}
    >
      {/*
        The index rail. Stops its own scroll and drag from reaching the wheel
        behind it — a flick of the wheel over a list is a scroll, not a zoom.
      */}
      <div
        className={`wheel-index${indexOpen ? '' : ' collapsed'}`}
        data-testid="wheel-index"
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button
          className="wheel-index-toggle"
          data-testid="wheel-index-toggle"
          title={indexOpen ? 'Hide the file list and give the room to the wheel' : 'Show the file list'}
          aria-expanded={indexOpen}
          onClick={(e) => {
            e.stopPropagation();
            setIndexOpen((v) => !v);
          }}
        >
          {indexOpen ? `‹ ${model.count} files` : '›'}
        </button>
        {indexOpen && (
          <div className="wheel-index-body" ref={indexBodyRef}>
            {indexGroups.map((group) => (
              <div className="wheel-index-group" key={group.cluster}>
                <div
                  className={`wheel-index-dir${collapsedDirs.has(group.cluster) ? ' folded' : ''}`}
                  data-testid={`wheel-index-dir-${group.cluster}`}
                  title={`${group.cluster} — click to ${collapsedDirs.has(group.cluster) ? 'expand' : 'collapse'} on the wheel`}
                  onClick={() => group.cluster !== '(root)' && onToggleDir(group.cluster)}
                  onMouseEnter={() => {
                    hoverClusterRef.current = group.cluster;
                    applyHighlight();
                  }}
                  onMouseLeave={() => {
                    hoverClusterRef.current = null;
                    applyHighlight();
                  }}
                >
                  <span
                    className="wheel-index-swatch"
                    style={{
                      background: clusterColorRef.current(group.cluster === '(root)' ? '' : group.cluster),
                    }}
                  />
                  <span className="wheel-index-dirname">
                    {group.cluster === '(root)' ? '/' : group.cluster}
                  </span>
                  <span className="wheel-index-count">{group.leaves.length}</span>
                </div>
                {group.leaves.map((leaf) => {
                  const n = leaf.node;
                  const label = n.kind === 'dir' ? folderLabel(n.dir?.dir ?? n.cluster) : n.label;
                  const color = n.file
                    ? lensColor(n.file, lensCtx)
                    : clusterColorRef.current(n.cluster === '(root)' ? '' : n.cluster);
                  const cls = [
                    'wheel-index-row',
                    n.kind === 'dir' ? 'dir' : '',
                    selected === n.id ? 'selected' : '',
                    selectedPaths.has(n.id) ? 'multi-selected' : '',
                    pinned === n.id ? 'pinned' : '',
                    query !== '' && !n.id.toLowerCase().includes(query) ? 'miss' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <div
                      key={n.id}
                      className={cls}
                      data-wid={n.id}
                      data-testid={`wheel-index-row-${n.id}`}
                      title={n.id}
                      onClick={(e) => onIndexClick(e, leaf)}
                      onDoubleClick={(e) => onNodeDoubleClick(e, n)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onNodeContextMenu({ x: e.clientX, y: e.clientY, id: n.id });
                      }}
                      onMouseEnter={() => {
                        hoverRef.current = n.id;
                        applyHighlight();
                      }}
                      onMouseLeave={() => {
                        hoverRef.current = null;
                        applyHighlight();
                      }}
                    >
                      <span className="wheel-index-swatch" style={{ background: color }} />
                      <span className="wheel-index-name">{label}</span>
                      {isUnreviewed(n.id, changedAt, reviewInfo) && (
                        <span className="wheel-index-unrev" title="changed since you last reviewed it" />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <svg className="wheel-svg" width={size.w} height={size.h}>
        <defs>
          {/* the corona: light leaving the core, dying out before the rim so it
              never competes with the colours that carry data */}
          <radialGradient id="wheel-corona">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
            <stop offset="38%" stopColor="var(--accent)" stopOpacity="0.085" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="wheel-core">
            <stop offset="0%" stopColor="var(--n13)" stopOpacity="0.5" />
            <stop offset="45%" stopColor="var(--warn)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--warn)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g ref={zoomRef}>
          <g ref={spinRef}>
            <circle
              className="wheel-corona"
              cx={model.cx}
              cy={model.cy}
              r={model.R * 1.02}
              fill="url(#wheel-corona)"
            />
            {/* rays, drawn behind everything and spinning with the wheel, so
                the thing reads as a source of light rather than a dial */}
            <g className="wheel-rays">
              {Array.from({ length: 36 }, (_, i) => {
                const a = (i / 36) * Math.PI * 2;
                const inner = model.R * 0.3;
                const outer = model.R * (i % 3 === 0 ? 1.0 : 0.82);
                return (
                  <line
                    key={i}
                    x1={model.cx + Math.cos(a) * inner}
                    y1={model.cy + Math.sin(a) * inner}
                    x2={model.cx + Math.cos(a) * outer}
                    y2={model.cy + Math.sin(a) * outer}
                  />
                );
              })}
            </g>
            <circle
              className="wheel-core"
              cx={model.cx}
              cy={model.cy}
              r={model.R * 0.3}
              fill="url(#wheel-core)"
            />
            <circle className="wheel-rim" cx={model.cx} cy={model.cy} r={model.R} />
            <circle className="wheel-rim inner" cx={model.cx} cy={model.cy} r={model.R * 0.26} />

            <g className="wedges">
              {model.edges.map((e) => (
                <path
                  key={`${e.source}\n${e.target}`}
                  className={`wedge${e.kind === 'intra' ? ' intra' : ''}`}
                  data-s={e.source}
                  data-t={e.target}
                  d={e.d}
                  style={{ '--w': `${Math.min(0.9, 0.4 + Math.log2(1 + e.weight) * 0.18)}px` } as React.CSSProperties}
                />
              ))}
            </g>

            {model.arcs.map((a, i) => {
              const color = clusterColorRef.current(a.cluster === '(root)' ? '' : a.cluster);
              const mid = ((a.mid % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
              // below the centre the arc has to be walked backwards or the
              // label comes out upside down
              const reverse = mid > 0 && mid < Math.PI;
              const label = `${a.cluster === '(root)' ? '/' : a.cluster}${a.collapsed ? ' ▣' : ''}`;
              const arcLen = (a.a1 - a.a0) * model.bandR;
              const pathId = `warc-${i}`;
              return (
                <g
                  key={a.cluster}
                  className={`warc${a.collapsed ? ' collapsed' : ''}`}
                  data-testid={`arc-${a.cluster}`}
                  onMouseEnter={() => {
                    hoverClusterRef.current = a.cluster;
                    applyHighlight();
                  }}
                  onMouseLeave={() => {
                    hoverClusterRef.current = null;
                    applyHighlight();
                  }}
                >
                  <path
                    id={pathId}
                    d={arcPath(model.cx, model.cy, model.bandR, a.a0, a.a1, reverse)}
                    stroke={color}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (a.cluster !== '(root)') onToggleDir(a.cluster);
                    }}
                  >
                    <title>{`${a.cluster} — ${a.count} nodes (click to ${a.collapsed ? 'expand' : 'collapse'})`}</title>
                  </path>
                  {arcLen > label.length * 7 + 10 && (
                    <text className="warc-label" fill={color} dy={-7}>
                      <textPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
                        {label}
                      </textPath>
                    </text>
                  )}
                </g>
              );
            })}

            <g className="wnodes">
              {[...model.leaves.values()].map((leaf) => {
                const n = leaf.node;
                const file = n.file;
                const color = file
                  ? lensColor(file, lensCtx)
                  : clusterColorRef.current(n.cluster === '(root)' ? '' : n.cluster);
                const unrev = n.kind !== 'dir' && isUnreviewed(n.id, changedAt, reviewInfo);
                const agent = changedBy[n.id];
                const miss = query !== '' && !n.id.toLowerCase().includes(query);
                const deg = ((leaf.angle * 180) / Math.PI + 360) % 360;
                const flip = deg > 90 && deg < 270;
                const cls = [
                  'wnode',
                  n.kind === 'dir' ? 'dir' : '',
                  n.kind === 'symbol' ? 'sym' : '',
                  selected === n.id ? 'sel' : '',
                  selectedPaths.has(n.id) && selected !== n.id ? 'msel' : '',
                  unrev ? 'unrev' : '',
                  pinned === n.id ? 'pin' : '',
                  miss ? 'dimmed' : '',
                  dense ? '' : 'labeled',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <g
                    key={n.id}
                    className={cls}
                    data-id={n.id}
                    data-testid={`wnode-${n.id}`}
                    onClick={(e) => onNodeClick(e, n)}
                    onDoubleClick={(e) => onNodeDoubleClick(e, n)}
                    onMouseEnter={() => {
                      hoverRef.current = n.id;
                      applyHighlight();
                    }}
                    onMouseLeave={() => {
                      hoverRef.current = null;
                      applyHighlight();
                    }}
                  >
                    <circle className="hit" cx={leaf.x} cy={leaf.y} r={Math.max(leaf.r + 6, 10)} />
                    {n.kind === 'dir' ? (
                      <rect
                        className="dot"
                        x={leaf.x - leaf.r}
                        y={leaf.y - leaf.r}
                        width={leaf.r * 2}
                        height={leaf.r * 2}
                        rx={2.5}
                        fill={color}
                        transform={`rotate(${deg + 45} ${leaf.x} ${leaf.y})`}
                      />
                    ) : (
                      <circle className="dot" cx={leaf.x} cy={leaf.y} r={leaf.r} fill={color} />
                    )}
                    {/*
                      The ring says who changed this file. When two agents both
                      did, it is drawn as two arcs — literally two-tone — which
                      is the one place in the app where that reads at a glance
                      across the whole repo at once: a disc with several
                      half-and-half rings on it is a night that needs looking at.
                    */}
                    {unrev &&
                      (contested.get(n.id) ? (
                        <g className="contested-ring">
                          <title>
                            {`written by ${contested.get(n.id)!.map((a) => a.label).join(' and ')}`}
                          </title>
                          <path
                            className="ring"
                            d={`M ${leaf.x - leaf.r - 3.5} ${leaf.y} A ${leaf.r + 3.5} ${leaf.r + 3.5} 0 0 1 ${leaf.x + leaf.r + 3.5} ${leaf.y}`}
                            fill="none"
                            stroke={agentColor(contested.get(n.id)![0].id)}
                          />
                          <path
                            className="ring"
                            d={`M ${leaf.x + leaf.r + 3.5} ${leaf.y} A ${leaf.r + 3.5} ${leaf.r + 3.5} 0 0 1 ${leaf.x - leaf.r - 3.5} ${leaf.y}`}
                            fill="none"
                            stroke={agentColor(contested.get(n.id)![1].id)}
                          />
                        </g>
                      ) : (
                        <circle
                          className="ring"
                          cx={leaf.x}
                          cy={leaf.y}
                          r={leaf.r + 3.5}
                          stroke={agent && agent !== 'you' ? agentColor(agent) : STATUS.warning}
                        />
                      ))}
                    {unrev && now - (changedAt[n.id] ?? 0) < 90_000 && (
                      <circle className="pulsering" cx={leaf.x} cy={leaf.y} r={leaf.r + 3.5} />
                    )}
                    <text
                      className="wlabel"
                      transform={`translate(${leaf.x} ${leaf.y}) rotate(${flip ? deg + 180 : deg})`}
                      textAnchor={flip ? 'end' : 'start'}
                      dx={flip ? -(leaf.r + LABEL_GAP) : leaf.r + LABEL_GAP}
                      dy={3}
                    >
                      {n.kind === 'dir' ? folderLabel(n.dir?.dir ?? n.cluster) : n.label}
                    </text>
                  </g>
                );
              })}
            </g>
          </g>
        </g>
      </svg>

      <div className="wheel-hub" style={{ left: model.cx, top: model.cy }}>
        <div className="wheel-hub-title">{projectRoot.split(/[\\/]/).pop()}</div>
        <div className="wheel-hub-detail">
          {model.count} nodes · {model.edges.length} links
        </div>
        <div className="wheel-hub-hint">drag to spin · alt+wheel to rotate</div>
      </div>

      {selectRect && (
        <div
          className="select-rect"
          style={{ left: selectRect.x, top: selectRect.y, width: selectRect.w, height: selectRect.h }}
        />
      )}
    </div>
  );
});
