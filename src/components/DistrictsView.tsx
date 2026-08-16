import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { STATUS, makeClusterColors, mixHex, panel, surface } from '../theme';
import { agentColor } from '../graph/lenses';
import { conflictMarks } from '../../shared/conflicts';
import { buildLensContext, lensColor, lensValue, type LensContext } from '../graph/lensColor';
import type { CanvasProps, GraphViewHandle } from './CanvasView';
import type { ReviewInfo } from '../api';
import type { GraphNode } from '../../shared/types';
import { num, plural } from '../format';

/**
 * Treemap ("districts"): every file gets area proportional to its lines, packed
 * inside its directory. Answers "how big is this repo and where does the mass
 * sit" at a glance — the one question a node-link view is bad at.
 */

interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Item {
  id: string;
  value: number;
}

/** Squarified treemap (Bruls et al.) — keeps tiles close to square. */
function squarify(items: Item[], rx: number, ry: number, rw: number, rh: number): Rect[] {
  const out: Rect[] = [];
  const remaining = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  let sum = remaining.reduce((a, i) => a + i.value, 0);
  if (sum <= 0) return out;
  let x = rx;
  let y = ry;
  let w = rw;
  let h = rh;

  while (remaining.length > 0 && w > 0.5 && h > 0.5) {
    const short = Math.min(w, h);
    const area = w * h;
    const row: Item[] = [];
    let rowSum = 0;
    let bestRatio = Infinity;

    while (remaining.length > 0) {
      const cand = remaining[0];
      const newSum = rowSum + cand.value;
      const rowLen = ((newSum / sum) * area) / short;
      let worst = 0;
      for (const it of [...row, cand]) {
        const side = (it.value / newSum) * short;
        if (side <= 0 || rowLen <= 0) continue;
        worst = Math.max(worst, Math.max(rowLen / side, side / rowLen));
      }
      if (worst <= bestRatio) {
        bestRatio = worst;
        row.push(cand);
        rowSum = newSum;
        remaining.shift();
      } else break;
    }

    const rowLen = ((rowSum / sum) * area) / short;
    let off = 0;
    for (const it of row) {
      const side = (it.value / rowSum) * short;
      if (w >= h) out.push({ id: it.id, x, y: y + off, w: rowLen, h: side });
      else out.push({ id: it.id, x: x + off, y, w: side, h: rowLen });
      off += side;
    }
    if (w >= h) {
      x += rowLen;
      w -= rowLen;
    } else {
      y += rowLen;
      h -= rowLen;
    }
    sum -= rowSum;
  }
  return out;
}

function isUnreviewed(path: string, changedAt: Record<string, number>, review: ReviewInfo | null): boolean {
  const changed = changedAt[path];
  if (!changed) return false;
  return changed > Math.max(review?.review.approvedAt[path] ?? 0, review?.review.checkpointAt ?? 0);
}

export const DistrictsView = forwardRef<GraphViewHandle, CanvasProps>(function DistrictsView(props, ref) {
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
  const worldRef = useRef<HTMLDivElement | null>(null);
  const clusterColorRef = useRef(makeClusterColors());
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 900, h: 600 });
  const [selectRect, setSelectRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useEffect(() => {
    clusterColorRef.current = makeClusterColors();
  }, [projectRoot]);

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

  const model = useMemo(() => {
    const groups = new Map<string, GraphNode[]>();
    for (const n of fullNodes.values()) {
      const c = n.cluster || '(root)';
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c)!.push(n);
    }
    const pad = 10;
    const TOP = 76; // clear the two-row toolbar overlay
    const districts = squarify(
      [...groups.entries()].map(([id, members]) => ({
        id,
        value: Math.max(1, members.reduce((a, n) => a + Math.max(n.loc, 6), 0)),
      })),
      pad,
      TOP,
      Math.max(40, size.w - pad * 2),
      Math.max(40, size.h - TOP - pad),
    );

    const tiles: (Rect & { node: GraphNode })[] = [];
    const blocks: (Rect & { cluster: string; count: number; loc: number; collapsed: boolean })[] = [];
    for (const d of districts) {
      const members = groups.get(d.id)!;
      const collapsed = collapsedDirs.has(d.id);
      blocks.push({
        ...d,
        cluster: d.id,
        count: members.length,
        loc: members.reduce((a, n) => a + n.loc, 0),
        collapsed,
      });
      if (collapsed) continue;
      const inner = squarify(
        members.map((n) => ({ id: n.id, value: Math.max(n.loc, 6) })),
        d.x + 3,
        d.y + 17,
        Math.max(2, d.w - 6),
        Math.max(2, d.h - 20),
      );
      const byId = new Map(members.map((n) => [n.id, n]));
      for (const t of inner) tiles.push({ ...t, node: byId.get(t.id)! });
    }

    const deps = new Map<string, Set<string>>();
    for (const e of fullEdges.values()) {
      if (!deps.has(e.source)) deps.set(e.source, new Set());
      if (!deps.has(e.target)) deps.set(e.target, new Set());
      deps.get(e.source)!.add(e.target);
      deps.get(e.target)!.add(e.source);
    }
    return { blocks, tiles, deps };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphVersion, fullNodes, fullEdges, collapsedDirs, size]);

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

  const maxCx = useMemo(() => {
    let m = 1;
    for (const n of fullNodes.values()) m = Math.max(m, n.complexity);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphVersion, fullNodes]);

  useEffect(() => {
    onStats({
      nodes: model.tiles.length + model.blocks.filter((b) => b.collapsed).length,
      edges: fullEdges.size,
      clusters: model.blocks
        .slice()
        .sort((a, b) => b.count - a.count)
        .map((b) => ({
          name: b.cluster,
          count: b.count,
          color: clusterColorRef.current(b.cluster === '(root)' ? '' : b.cluster),
          collapsed: b.collapsed,
        })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const applyView = useCallback(() => {
    const v = viewRef.current;
    if (worldRef.current) worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    onZoom?.(Math.round(v.k * 100));
  }, [onZoom]);

  const fitView = useCallback(() => {
    viewRef.current = { x: 0, y: 0, k: 1 };
    applyView();
  }, [applyView]);

  const zoomAt = useCallback(
    (factor: number, mx?: number, my?: number) => {
      const v = viewRef.current;
      const px = mx ?? size.w / 2;
      const py = my ?? size.h / 2;
      const k2 = Math.min(8, Math.max(1, v.k * factor));
      v.x = px - (px - v.x) * (k2 / v.k);
      v.y = py - (py - v.y) * (k2 / v.k);
      v.k = k2;
      if (k2 === 1) {
        v.x = 0;
        v.y = 0;
      }
      applyView();
    },
    [applyView, size],
  );

  useImperativeHandle(ref, () => ({
    relayout: fitView,
    focusNode() {
      /* treemap position is fixed by size — selection is the affordance */
    },
    zoom(direction: 1 | -1) {
      zoomAt(direction === 1 ? 1.3 : 1 / 1.3);
    },
    fitView,
    // the treemap fills the pane by construction — centring is a pan reset
    centerView() {
      viewRef.current = { ...viewRef.current, x: 0, y: 0 };
      applyView();
    },
  }));

  const drag = useRef<{ kind: 'pan' | 'box'; sx: number; sy: number; vx: number; vy: number } | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, .legend, .graph-overlay')) return;
    const rect = containerRef.current!.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      drag.current = { kind: 'box', sx: e.clientX - rect.left, sy: e.clientY - rect.top, vx: 0, vy: 0 };
      return;
    }
    if (viewRef.current.k > 1) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
      containerRef.current?.classList.add('panning');
    }
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.kind === 'pan') {
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
      containerRef.current?.classList.remove('panning');
      if (!d || d.kind !== 'box') return;
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
      const hits = model.tiles
        .filter((t) => {
          const cx = (t.x + t.w / 2) * v.k + v.x;
          const cy = (t.y + t.h / 2) * v.k + v.y;
          return cx >= x1 && cx <= xb && cy >= y1 && cy <= yb;
        })
        .map((t) => t.id);
      if (hits.length > 0) onBoxSelect(hits);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [model, applyView, onBoxSelect]);

  const query = searchQuery.trim().toLowerCase();
  const related = selected ? (model.deps.get(selected) ?? new Set<string>()) : null;
  const now = Date.now();
  const { contested } = conflictMarks(conflicts ?? []);

  return (
    <div
      className="districts-view"
      ref={containerRef}
      data-testid="graph-container"
      onMouseDown={onMouseDown}
      onWheel={(e) => {
        e.preventDefault();
        const rect = containerRef.current!.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX - rect.left, e.clientY - rect.top);
      }}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('.dtile, .dblock-head, button')) onSelect(null);
      }}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('.dtile, .dblock-head')) fitView();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const tile = (e.target as HTMLElement).closest('.dtile') as HTMLElement | null;
        onNodeContextMenu({ x: e.clientX, y: e.clientY, id: tile?.dataset.id ?? null });
      }}
    >
      <div className="districts-world" ref={worldRef}>
        {model.blocks.map((b) => (
          <div
            key={b.cluster}
            className={`dblock${b.collapsed ? ' collapsed' : ''}`}
            style={{
              left: b.x,
              top: b.y,
              width: b.w,
              height: b.h,
              borderColor: mixHex(clusterColorRef.current(b.cluster === '(root)' ? '' : b.cluster), panel(), 0.45),
              background: b.collapsed
                ? mixHex(clusterColorRef.current(b.cluster === '(root)' ? '' : b.cluster), panel(), 0.6)
                : undefined,
            }}
          >
            <div
              className="dblock-head"
              style={{ color: clusterColorRef.current(b.cluster === '(root)' ? '' : b.cluster) }}
              onClick={(e) => {
                e.stopPropagation();
                if (b.cluster !== '(root)') onToggleDir(b.cluster);
              }}
              title={`${b.cluster} — ${b.count} files, ${num(b.loc)} loc (click to ${b.collapsed ? 'expand' : 'collapse'})`}
              data-testid={`dblock-${b.cluster}`}
            >
              <span className="dblock-name">
                {b.collapsed ? '▣ ' : '▾ '}
                {b.cluster}
              </span>
              <span className="dblock-meta">
                {b.count} · {num(b.loc)} loc
              </span>
            </div>
            {b.collapsed && b.h > 46 && (
              <div className="dblock-collapsed-note">
                {plural(b.count, 'file')} · {num(b.loc)} loc
                <br />
                click the header to expand
              </div>
            )}
          </div>
        ))}

        {model.tiles.map((t) => {
          const n = t.node;
          const base = lensColor(n, lensCtx);
          const intensity = 0.26 + lensValue(n, lensCtx, maxCx) * 0.7;
          const unrev = isUnreviewed(n.id, changedAt, reviewInfo);
          const agent = changedBy[n.id];
          const miss = query !== '' && !n.id.toLowerCase().includes(query);
          const cls = [
            'dtile',
            selected === n.id ? 'sel' : '',
            selectedPaths.has(n.id) && selected !== n.id ? 'msel' : '',
            related?.has(n.id) ? 'rel' : '',
            unrev ? 'unrev' : '',
            unrev && now - (changedAt[n.id] ?? 0) < 90_000 ? 'pulse' : '',
            miss || (related && !related.has(n.id) && selected !== n.id) ? 'dimmed' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const showLabel = t.w > 44 && t.h > 15;
          return (
            <div
              key={n.id}
              className={cls}
              data-id={n.id}
              data-testid={`dtile-${n.id}`}
              style={{
                left: t.x,
                top: t.y,
                width: Math.max(1, t.w - 2),
                height: Math.max(1, t.h - 2),
                background: mixHex(surface(), base, intensity),
              }}
              title={`${n.id}\n${n.loc} loc · cx ${n.complexity}${coverage[n.id] ? ` · ${Math.round(coverage[n.id].pct)}% covered` : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (e.ctrlKey || e.metaKey) onToggleSelect(n.id);
                else onSelect(n.id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onOpenFile(n.id);
              }}
            >
              {showLabel && <span className="dtile-label">{n.id.split('/').pop()}</span>}
              {/* same flag, split when two agents both wrote the tile */}
              {unrev && (
                <span
                  className="dtile-flag"
                  title={
                    contested.get(n.id)
                      ? `written by ${contested.get(n.id)!.map((a) => a.label).join(' and ')}`
                      : undefined
                  }
                  style={{
                    background: contested.get(n.id)
                      ? `linear-gradient(90deg, ${agentColor(contested.get(n.id)![0].id)} 0 50%, ${agentColor(
                          contested.get(n.id)![1].id,
                        )} 50% 100%)`
                      : agent && agent !== 'you'
                        ? agentColor(agent)
                        : STATUS.warning,
                  }}
                />
              )}
            </div>
          );
        })}
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
