import { findCycles } from '../../shared/graph';

/**
 * Ordered left-to-right dependency layout ("flow"): foundational modules on
 * the left, entry points on the right. Layering uses longest-path depth over
 * the SCC-condensed graph (cycles collapse into one layer unit), and a few
 * barycenter sweeps order each column to reduce edge crossings. Deterministic
 * — same graph, same picture.
 */

export interface FlowNode {
  id: string;
  cluster: string;
}

export interface FlowEdge {
  source: string;
  target: string;
}

export const COL_SPACING = 130;
export const ROW_SPACING = 42;

/**
 * Packs an ordered list of column widths into bands so the whole block ends up
 * near `aspect` (width/height) instead of one endless strip. Reading order is
 * preserved: left to right, then wrap down — like text.
 */
function bandify(widths: number[], heights: number[], aspect: number | undefined): number[][] {
  const all = widths.map((_, i) => i);
  // small graphs read better as one uninterrupted flow — only wrap once there
  // are enough columns for the strip to actually become a problem
  if (!aspect || widths.length < 5) return [all];
  const totalW = widths.reduce((a, b) => a + b, 0);
  const maxH = Math.max(...heights, 1);
  if (totalW / maxH <= aspect) return [all];
  const bandCount = Math.max(2, Math.round(Math.sqrt(totalW / (maxH * aspect))));
  const target = totalW / bandCount;
  const bands: number[][] = [];
  let current: number[] = [];
  let width = 0;
  for (let i = 0; i < widths.length; i++) {
    if (current.length > 0 && width + widths[i] / 2 > target) {
      bands.push(current);
      current = [];
      width = 0;
    }
    current.push(i);
    width += widths[i];
  }
  if (current.length > 0) bands.push(current);
  return bands;
}

export function flowLayout(
  nodes: FlowNode[],
  edges: FlowEdge[],
  wrapAspect?: number,
): Record<string, { x: number; y: number }> {
  if (nodes.length === 0) return {};
  const ids = new Set(nodes.map((n) => n.id));
  const validEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);

  // --- condense cycles ---
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of validEdges) adjacency.get(e.source)!.push(e.target);
  const cycleIds = findCycles(adjacency);
  const unitOf = (id: string): string =>
    cycleIds.has(id) ? `#scc${cycleIds.get(id)}` : id;

  const unitMembers = new Map<string, string[]>();
  for (const n of nodes) {
    const u = unitOf(n.id);
    if (!unitMembers.has(u)) unitMembers.set(u, []);
    unitMembers.get(u)!.push(n.id);
  }
  const unitEdges = new Map<string, Set<string>>();
  for (const u of unitMembers.keys()) unitEdges.set(u, new Set());
  for (const e of validEdges) {
    const us = unitOf(e.source);
    const ut = unitOf(e.target);
    if (us !== ut) unitEdges.get(us)!.add(ut);
  }

  // --- longest-path depth: depth(u) = 1 + max(depth of imports), iterative ---
  const depth = new Map<string, number>();
  const stack = [...unitMembers.keys()];
  while (stack.length > 0) {
    const u = stack[stack.length - 1];
    if (depth.has(u)) {
      stack.pop();
      continue;
    }
    let ready = true;
    let d = 0;
    for (const dep of unitEdges.get(u) ?? []) {
      const dd = depth.get(dep);
      if (dd === undefined) {
        stack.push(dep);
        ready = false;
      } else {
        d = Math.max(d, dd + 1);
      }
    }
    if (ready) {
      depth.set(u, d);
      stack.pop();
    }
  }

  // --- columns ---
  const clusterOf = new Map(nodes.map((n) => [n.id, n.cluster]));
  const columns = new Map<number, string[]>();
  for (const u of unitMembers.keys()) {
    const d = depth.get(u) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(u);
  }
  const sortedDepths = [...columns.keys()].sort((a, b) => a - b);

  // initial in-column order: group by cluster for spatial coherence
  const unitCluster = (u: string) => clusterOf.get(unitMembers.get(u)![0]) ?? '';
  for (const d of sortedDepths) {
    columns.get(d)!.sort((a, b) => unitCluster(a).localeCompare(unitCluster(b)) || a.localeCompare(b));
  }

  // --- barycenter sweeps to reduce crossings ---
  const orderIndex = new Map<string, number>();
  const setOrders = () => {
    for (const d of sortedDepths) {
      columns.get(d)!.forEach((u, i) => orderIndex.set(u, i));
    }
  };
  setOrders();
  const inbound = new Map<string, string[]>(); // unit -> units importing it
  for (const [us, targets] of unitEdges) {
    for (const ut of targets) {
      if (!inbound.has(ut)) inbound.set(ut, []);
      inbound.get(ut)!.push(us);
    }
  }
  for (let sweep = 0; sweep < 4; sweep++) {
    const forward = sweep % 2 === 0;
    for (const d of forward ? sortedDepths : [...sortedDepths].reverse()) {
      const col = columns.get(d)!;
      const bary = (u: string): number => {
        const refs = forward ? [...(unitEdges.get(u) ?? [])] : (inbound.get(u) ?? []);
        const positions = refs
          .map((r) => orderIndex.get(r))
          .filter((v): v is number => v !== undefined);
        if (positions.length === 0) return orderIndex.get(u) ?? 0;
        return positions.reduce((a, b) => a + b, 0) / positions.length;
      };
      col.sort((a, b) => {
        const diff = bary(a) - bary(b);
        if (Math.abs(diff) > 1e-9) return diff;
        return unitCluster(a).localeCompare(unitCluster(b)) || a.localeCompare(b);
      });
      col.forEach((u, i) => orderIndex.set(u, i));
    }
  }

  // --- assign coordinates (units -> member nodes stacked) ---
  const rowCounts = sortedDepths.map((d) => {
    let total = 0;
    for (const u of columns.get(d)!) total += unitMembers.get(u)!.length;
    return total;
  });
  const bands = bandify(
    sortedDepths.map(() => COL_SPACING),
    rowCounts.map((r) => r * ROW_SPACING),
    wrapAspect,
  );

  const positions: Record<string, { x: number; y: number }> = {};
  const BAND_GAP = ROW_SPACING * 2.4;
  let yBase = 0;
  for (const band of bands) {
    const bandRows = Math.max(...band.map((i) => rowCounts[i]));
    for (const i of band) {
      const col = columns.get(sortedDepths[i])!;
      const x = (i - band[0]) * COL_SPACING;
      let row = -(rowCounts[i] - 1) / 2;
      for (const u of col) {
        for (const id of unitMembers.get(u)!.sort()) {
          positions[id] = { x, y: yBase + row * ROW_SPACING };
          row += 1;
        }
      }
    }
    yBase += (bandRows - 1) * ROW_SPACING + BAND_GAP;
  }
  return positions;
}

/**
 * Two-level ordered layout: clusters become blocks arranged left-to-right by
 * inter-cluster dependency depth (stacked vertically within a depth), and each
 * cluster's members get a compact internal flow inside their block. Keeps
 * cluster locality (no spaghetti across the whole canvas) while staying
 * deterministic and ordered.
 */
export function hierarchicalFlowLayout(
  nodes: FlowNode[],
  edges: FlowEdge[],
  wrapAspect?: number,
): Record<string, { x: number; y: number }> {
  if (nodes.length === 0) return {};
  const clusterOf = new Map(nodes.map((n) => [n.id, n.cluster || '(root)']));
  const clusters = new Map<string, FlowNode[]>();
  for (const n of nodes) {
    const c = clusterOf.get(n.id)!;
    if (!clusters.has(c)) clusters.set(c, []);
    clusters.get(c)!.push(n);
  }

  // cluster-level digraph
  const clusterEdgeSet = new Map<string, { source: string; target: string }>();
  const internalEdges = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    const cs = clusterOf.get(e.source);
    const ct = clusterOf.get(e.target);
    if (!cs || !ct) continue;
    if (cs === ct) {
      if (!internalEdges.has(cs)) internalEdges.set(cs, []);
      internalEdges.get(cs)!.push(e);
    } else {
      clusterEdgeSet.set(`${cs}\n${ct}`, { source: cs, target: ct });
    }
  }
  const clusterLayout = flowLayout(
    [...clusters.keys()].map((c) => ({ id: c, cluster: '' })),
    [...clusterEdgeSet.values()],
  );

  // local layout + bounding box per cluster
  // 1:1 — the renderer sizes its cards off COL_SPACING/ROW_SPACING, so
  // shrinking the local grid here would make neighbouring cards overlap
  const LOCAL_SCALE = 1;
  const locals = new Map<
    string,
    { pos: Record<string, { x: number; y: number }>; w: number; h: number }
  >();
  for (const [c, members] of clusters) {
    const local = flowLayout(
      members.map((m) => ({ id: m.id, cluster: '' })),
      internalEdges.get(c) ?? [],
      wrapAspect,
    );
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of Object.values(local)) {
      p.x *= LOCAL_SCALE;
      p.y *= LOCAL_SCALE;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    // recentre local coordinates on the cluster origin
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    for (const p of Object.values(local)) {
      p.x -= cx;
      p.y -= cy;
    }
    locals.set(c, { pos: local, w: Math.max(maxX - minX, 40), h: Math.max(maxY - minY, 40) });
  }

  // arrange cluster blocks: columns by depth, stacked vertically inside
  const H_GAP = 150;
  const V_GAP = 95;
  const byDepth = new Map<number, string[]>();
  for (const c of clusters.keys()) {
    const depth = Math.round((clusterLayout[c]?.x ?? 0) / COL_SPACING);
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth)!.push(c);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const blockColumns = depths.map((d) =>
    byDepth.get(d)!.sort((a, b) => (clusterLayout[a]?.y ?? 0) - (clusterLayout[b]?.y ?? 0)),
  );
  const colWidths = blockColumns.map((list) => Math.max(...list.map((c) => locals.get(c)!.w)) + H_GAP);
  const colHeights = blockColumns.map(
    (list) => list.reduce((acc, c) => acc + locals.get(c)!.h, 0) + V_GAP * (list.length - 1),
  );

  const positions: Record<string, { x: number; y: number }> = {};
  const bands = bandify(colWidths, colHeights, wrapAspect);
  let yBase = 0;
  for (let b = 0; b < bands.length; b++) {
    const band = bands[b];
    const bandHeight = Math.max(...band.map((i) => colHeights[i]));
    let xCursor = 0;
    for (const i of band) {
      let yCursor = yBase - colHeights[i] / 2;
      for (const c of blockColumns[i]) {
        const { pos, h } = locals.get(c)!;
        const centerX = xCursor + (colWidths[i] - H_GAP) / 2;
        const centerY = yCursor + h / 2;
        for (const [id, p] of Object.entries(pos)) {
          positions[id] = { x: centerX + p.x, y: centerY + p.y };
        }
        yCursor += h + V_GAP;
      }
      xCursor += colWidths[i];
    }
    const next = bands[b + 1];
    if (next) {
      yBase += bandHeight / 2 + V_GAP * 1.8 + Math.max(...next.map((i) => colHeights[i])) / 2;
    }
  }
  return positions;
}
