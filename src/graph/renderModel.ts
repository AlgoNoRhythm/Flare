import type { GraphEdge, GraphNode, SymbolGraph } from '../../shared/types';

/**
 * Pure derivation of what the graph canvas shows from the full code graph plus
 * view state: collapsed top-level directories become aggregate meta-nodes,
 * expanded files explode into their symbols around a small hub.
 */

export interface ViewState {
  collapsedDirs: ReadonlySet<string>;
  expandedFiles: ReadonlySet<string>;
}

export interface DirAggregate {
  dir: string;
  /** top-level cluster its members belong to — folders keep their parent's hue */
  cluster: string;
  files: number;
  loc: number;
  complexity: number;
  /** worst (max) cycle membership / orphan counts for badge display */
  cycles: number;
  orphans: number;
  untested: number;
}

export interface RenderNode {
  id: string;
  kind: 'file' | 'dir' | 'symbol' | 'hub';
  label: string;
  cluster: string;
  /** size basis (loc for files/symbols, total loc for dirs) */
  loc: number;
  file?: GraphNode;
  dir?: DirAggregate;
  symbol?: { parent: string; name: string; symKind: string; exported: boolean; line: number };
}

export interface RenderEdge {
  source: string;
  target: string;
  weight: number;
  kind: 'import' | 'intra';
}

export const DIR_PREFIX = '@dir:';
export const SYM_SEP = '::';

export function dirNodeId(dir: string): string {
  return DIR_PREFIX + dir;
}

export function symbolNodeId(path: string, symbol: string): string {
  return path + SYM_SEP + symbol;
}

export function isDirNode(id: string): boolean {
  return id.startsWith(DIR_PREFIX);
}

export function parseSymbolNode(id: string): { path: string; symbol: string } | null {
  const idx = id.indexOf(SYM_SEP);
  if (idx === -1) return null;
  return { path: id.slice(0, idx), symbol: id.slice(idx + SYM_SEP.length) };
}

export interface DeriveResult {
  nodes: RenderNode[];
  edges: RenderEdge[];
}

/**
 * A folder holding more files than this unfolds into its sub-folders rather
 * than into files.
 *
 * A `src/` with 484 files under it has no useful state: folded it is a single
 * card with no edges at all (every dependency is internal to it), and unfolded
 * it is 500 cards at 34% zoom. The drill level is the missing middle.
 */
export const DRILL_ABOVE = 60;

/** Folding a folder that holds one file gains nothing — it stays a file card. */
const MIN_FOLDABLE = 2;

/**
 * The collapsed folder that stands in for a path, or null if it shows itself.
 *
 * The *shortest* match wins: folding `src` must swallow an `src/app` that was
 * folded earlier, and unfolding `src` then hands that drill state back.
 */
export function representingDir(path: string, collapsed: ReadonlySet<string>): string | null {
  let best: string | null = null;
  for (const dir of collapsed) {
    if (dir === '' || !path.startsWith(`${dir}/`)) continue;
    if (best === null || dir.length < best.length) best = dir;
  }
  return best;
}

/**
 * What a folder card is called: the last two segments of its path.
 *
 * A card is a fixed width, so `src/app/api/documents` truncates to
 * `src/app/api/docu…` — the head, which every sibling shares, at the cost of
 * the tail, which is the only part that tells them apart. The full path is
 * still on the card's tooltip.
 */
export function folderLabel(dir: string): string {
  return `${dir.split('/').slice(-2).join('/')}/`;
}

/** Immediate sub-folders of `dir`, each with the number of files beneath it. */
export function childFolders(paths: Iterable<string>, dir: string): Map<string, number> {
  const out = new Map<string, number>();
  const prefix = dir === '' ? '' : `${dir}/`;
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const idx = rest.indexOf('/');
    if (idx === -1) continue;
    const name = rest.slice(0, idx);
    out.set(name, (out.get(name) ?? 0) + 1);
  }
  return out;
}

function countUnder(paths: Iterable<string>, dir: string): number {
  const prefix = `${dir}/`;
  let n = 0;
  for (const p of paths) if (p.startsWith(prefix)) n++;
  return n;
}

/** Fold `dir` into one card, keeping any drill state inside it for later. */
export function foldDir(collapsed: ReadonlySet<string>, dir: string): Set<string> {
  const next = new Set(collapsed);
  next.add(dir);
  return next;
}

/**
 * Open `dir` one level: into its sub-folders if it is too big to read as
 * files, otherwise into the files themselves. Re-opening a folder that was
 * drilled before restores where you had got to rather than starting over.
 */
export function unfoldDir(
  collapsed: ReadonlySet<string>,
  dir: string,
  paths: Iterable<string>,
): Set<string> {
  const next = new Set(collapsed);
  next.delete(dir);
  const all = [...paths];
  for (const d of next) if (d.startsWith(`${dir}/`)) return next;

  let target = dir;
  for (let depth = 0; depth < 8; depth++) {
    const total = countUnder(all, target);
    if (total <= DRILL_ABOVE) return next;
    const foldable = [...childFolders(all, target)].filter(([, n]) => n >= MIN_FOLDABLE);
    if (foldable.length === 0) return next;
    // one child holding the entire folder is not a level worth a click
    if (foldable.length === 1 && foldable[0][1] === total) {
      target = `${target}/${foldable[0][0]}`;
      continue;
    }
    for (const [name] of foldable) next.add(`${target}/${name}`);
    return next;
  }
  return next;
}

/** How many sub-folder cards unfolding `dir` would produce (0 = files). */
export function drillCount(
  collapsed: ReadonlySet<string>,
  dir: string,
  paths: Iterable<string>,
): number {
  const before = new Set(collapsed);
  before.delete(dir);
  let added = 0;
  for (const d of unfoldDir(collapsed, dir, paths)) if (!before.has(d)) added++;
  return added;
}

export function deriveRenderModel(
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
  view: ViewState,
  symbolGraphs: ReadonlyMap<string, SymbolGraph>,
): DeriveResult {
  const outNodes: RenderNode[] = [];
  const dirAggregates = new Map<string, DirAggregate>();

  // one pass, so a deep collapse set does not cost a scan per node and per edge
  const repDir = new Map<string, string | null>();
  for (const path of nodes.keys()) repDir.set(path, representingDir(path, view.collapsedDirs));

  const repOf = (path: string): string => {
    const dir = repDir.get(path);
    return dir ? dirNodeId(dir) : path;
  };

  for (const node of nodes.values()) {
    const collapsedIn = repDir.get(node.id) ?? null;
    if (collapsedIn !== null) {
      let agg = dirAggregates.get(collapsedIn);
      if (!agg) {
        agg = {
          dir: collapsedIn,
          cluster: node.cluster,
          files: 0,
          loc: 0,
          complexity: 0,
          cycles: 0,
          orphans: 0,
          untested: 0,
        };
        dirAggregates.set(collapsedIn, agg);
      }
      agg.files++;
      agg.loc += node.loc;
      agg.complexity += node.complexity;
      if (node.cycleId !== null) agg.cycles++;
      if (node.orphan) agg.orphans++;
      if (!node.isTest && node.testedBy === 0) agg.untested++;
      continue;
    }
    if (view.expandedFiles.has(node.id) && symbolGraphs.has(node.id)) {
      const sg = symbolGraphs.get(node.id)!;
      outNodes.push({
        id: node.id,
        kind: 'hub',
        label: node.id.split('/').pop() ?? node.id,
        cluster: node.cluster,
        loc: Math.max(4, Math.floor(node.loc / 8)),
        file: node,
      });
      for (const sym of sg.symbols) {
        outNodes.push({
          id: symbolNodeId(node.id, sym.name),
          kind: 'symbol',
          label: sym.name,
          cluster: node.cluster,
          loc: sym.loc,
          symbol: {
            parent: node.id,
            name: sym.name,
            symKind: sym.kind,
            exported: sym.exported,
            line: sym.line,
          },
        });
      }
      continue;
    }
    outNodes.push({
      id: node.id,
      kind: 'file',
      label: node.id.split('/').pop() ?? node.id,
      cluster: node.cluster,
      loc: node.loc,
      file: node,
    });
  }

  for (const agg of dirAggregates.values()) {
    outNodes.push({
      id: dirNodeId(agg.dir),
      kind: 'dir',
      label: `${agg.dir} (${agg.files})`,
      // sub-folder cards band and colour with the cluster they came out of, so
      // drilling into src/ does not repaint half the canvas
      cluster: agg.cluster || agg.dir,
      loc: agg.loc,
      dir: agg,
    });
  }

  // ---- edges ----
  const merged = new Map<string, RenderEdge>();
  const addEdge = (source: string, target: string, weight: number, kind: RenderEdge['kind']) => {
    if (source === target) return;
    const key = `${source}\n${target}`;
    const existing = merged.get(key);
    if (existing) existing.weight += weight;
    else merged.set(key, { source, target, weight, kind });
  };

  for (const e of edges) {
    const sourceRep = repOf(e.source);
    const targetExpanded = view.expandedFiles.has(e.target) && symbolGraphs.has(e.target);
    if (targetExpanded && !isDirNode(sourceRep)) {
      // route inbound edges to the specific symbols when known
      const sg = symbolGraphs.get(e.target)!;
      const symbolHits = sg.inbound.filter((i) => i.importer === e.source);
      if (symbolHits.length > 0) {
        for (const hit of symbolHits) {
          addEdge(sourceRep, symbolNodeId(e.target, hit.symbol), hit.weight, 'import');
        }
        continue;
      }
    }
    addEdge(sourceRep, repOf(e.target), e.weight, 'import');
  }

  for (const path of view.expandedFiles) {
    const sg = symbolGraphs.get(path);
    if (!sg || !nodes.has(path)) continue;
    // hub anchors its symbols
    for (const sym of sg.symbols) {
      addEdge(path, symbolNodeId(path, sym.name), 1, 'intra');
    }
    for (const e of sg.intraEdges) {
      addEdge(symbolNodeId(path, e.from), symbolNodeId(path, e.to), e.weight, 'intra');
    }
  }

  // drop edges whose endpoints vanished (e.g. symbol data stale after removal)
  const ids = new Set(outNodes.map((n) => n.id));
  const outEdges = [...merged.values()].filter((e) => ids.has(e.source) && ids.has(e.target));

  return { nodes: outNodes, edges: outEdges };
}
