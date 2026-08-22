import type { CodeGraph, GraphEdge, GraphNode, GraphPatch, ParsedFile } from './types';
import { basename, topDir } from './paths';
import { resolveImport, type ResolverOptions } from './resolver';

const ENTRY_BASENAMES = new Set([
  'main', 'index', 'app', 'server', 'cli', 'setup', 'manage', 'conftest',
  '__init__', '__main__', 'preload', 'background', 'worker', 'extension',
]);

export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|e2e|specs?)\//.test(path) ||
    /\.(test|spec)\.[\w]+$/.test(path) ||
    /(^|\/)test_[^/]+\.py$/.test(path) ||
    /_test\.py$/.test(path)
  );
}

function isEntryLike(path: string): boolean {
  const base = basename(path).replace(/\.[^.]+$/, '');
  return ENTRY_BASENAMES.has(base.toLowerCase());
}

/**
 * Holds parsed files and derives the code graph. Edge resolution is recomputed
 * wholesale on every change batch (cheap in-memory work) and diffed into a
 * GraphPatch so the renderer can animate incrementally.
 */
export class GraphBuilder {
  private files = new Map<string, ParsedFile>();
  private index = new Set<string>();
  private opts: ResolverOptions;
  private lastNodes = new Map<string, GraphNode>();
  /** edge key "source\ntarget" -> weight */
  private lastEdges = new Map<string, number>();

  constructor(opts: ResolverOptions = {}) {
    this.opts = opts;
  }

  setResolverOptions(opts: ResolverOptions): void {
    this.opts = opts;
  }

  getFile(path: string): ParsedFile | undefined {
    return this.files.get(path);
  }

  /** All files whose imports resolve to `target`, with per-binding ref counts. */
  importersOf(target: string): { importer: string; bindings: Record<string, number> }[] {
    const out: { importer: string; bindings: Record<string, number> }[] = [];
    for (const f of this.files.values()) {
      if (f.path === target) continue;
      const merged: Record<string, number> = {};
      let hits = false;
      for (const decl of f.imports) {
        const resolved = resolveImport(f.path, decl.spec, this.index, this.opts);
        if (resolved === target) {
          hits = true;
          for (const [name, refs] of Object.entries(decl.bindings)) {
            merged[name] = Math.max(merged[name] ?? 0, refs);
          }
        }
      }
      if (hits) out.push({ importer: f.path, bindings: merged });
    }
    return out;
  }

  /** Replace all files (initial scan). */
  setAll(parsed: ParsedFile[]): CodeGraph {
    this.files.clear();
    this.index.clear();
    for (const f of parsed) {
      this.files.set(f.path, f);
      this.index.add(f.path);
    }
    const { nodes, edges } = this.compute();
    this.lastNodes = new Map(nodes.map((n) => [n.id, n]));
    this.lastEdges = new Map(edges.map((e) => [edgeKey(e), e.weight]));
    return { nodes, edges, generatedAt: Date.now() };
  }

  /** Apply an incremental change batch and return the patch vs. previous state. */
  apply(changed: ParsedFile[], removed: string[]): GraphPatch {
    for (const path of removed) {
      this.files.delete(path);
      this.index.delete(path);
    }
    for (const f of changed) {
      this.files.set(f.path, f);
      this.index.add(f.path);
    }
    const { nodes, edges } = this.compute();
    const newNodes = new Map(nodes.map((n) => [n.id, n]));
    const newEdges = new Map(edges.map((e) => [edgeKey(e), e.weight]));

    const patch: GraphPatch = {
      addedNodes: [],
      updatedNodes: [],
      removedNodeIds: [],
      addedEdges: [],
      updatedEdges: [],
      removedEdges: [],
    };
    for (const [id, node] of newNodes) {
      const prev = this.lastNodes.get(id);
      if (!prev) patch.addedNodes.push(node);
      else if (!nodesEqual(prev, node)) patch.updatedNodes.push(node);
    }
    for (const id of this.lastNodes.keys()) {
      if (!newNodes.has(id)) patch.removedNodeIds.push(id);
    }
    for (const [key, weight] of newEdges) {
      const prev = this.lastEdges.get(key);
      if (prev === undefined) patch.addedEdges.push(edgeFromKey(key, weight));
      else if (prev !== weight) patch.updatedEdges.push(edgeFromKey(key, weight));
    }
    for (const [key, weight] of this.lastEdges) {
      if (!newEdges.has(key)) patch.removedEdges.push(edgeFromKey(key, weight));
    }
    this.lastNodes = newNodes;
    this.lastEdges = newEdges;
    return patch;
  }

  getGraph(): CodeGraph {
    return {
      nodes: [...this.lastNodes.values()],
      edges: [...this.lastEdges].map(([key, weight]) => edgeFromKey(key, weight)),
      generatedAt: Date.now(),
    };
  }

  /** Direct dependents (files importing `id`) and dependencies. */
  neighbors(id: string): { dependents: string[]; dependencies: string[] } {
    const dependents: string[] = [];
    const dependencies: string[] = [];
    for (const key of this.lastEdges.keys()) {
      const e = edgeFromKey(key, 1);
      if (e.source === id) dependencies.push(e.target);
      if (e.target === id) dependents.push(e.source);
    }
    return { dependents, dependencies };
  }

  /** Transitive dependents count (blast radius) via reverse BFS. */
  blastRadius(id: string): number {
    const reverse = new Map<string, string[]>();
    for (const key of this.lastEdges.keys()) {
      const e = edgeFromKey(key, 1);
      const list = reverse.get(e.target);
      if (list) list.push(e.source);
      else reverse.set(e.target, [e.source]);
    }
    const seen = new Set<string>([id]);
    const queue = [id];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const dep of reverse.get(cur) ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    return seen.size - 1;
  }

  /**
   * Cluster granularity: normally the top-level directory, but a "container"
   * top dir (no code files of its own, several code-bearing subdirs, enough
   * files to matter — monorepo `apps/`, `packages/`…) clusters by its second
   * level instead, e.g. `apps/web`.
   */
  private computeClusterOf(): (path: string) => string {
    const tops = new Map<string, { direct: number; total: number; subs: Set<string> }>();
    for (const f of this.files.values()) {
      const t = topDir(f.path);
      if (t === '') continue;
      let entry = tops.get(t);
      if (!entry) {
        entry = { direct: 0, total: 0, subs: new Set() };
        tops.set(t, entry);
      }
      entry.total++;
      const rest = f.path.slice(t.length + 1);
      const idx = rest.indexOf('/');
      if (idx === -1) entry.direct++;
      else entry.subs.add(rest.slice(0, idx));
    }
    const twoLevel = new Set(
      [...tops.entries()]
        .filter(([, e]) => e.direct === 0 && e.subs.size >= 2 && e.total >= 5)
        .map(([d]) => d),
    );
    return (path: string) => {
      const t = topDir(path);
      if (!twoLevel.has(t)) return t;
      const rest = path.slice(t.length + 1);
      const idx = rest.indexOf('/');
      return idx === -1 ? t : `${t}/${rest.slice(0, idx)}`;
    };
  }

  private compute(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const edgeWeights = new Map<string, number>();
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    const external = new Map<string, string[]>();
    const adjacency = new Map<string, string[]>();

    for (const f of this.files.values()) {
      const targets = new Map<string, number>();
      const externalSpecs = new Set<string>();
      for (const decl of f.imports) {
        const resolved = resolveImport(f.path, decl.spec, this.index, this.opts);
        if (resolved && resolved !== f.path) {
          const refSum = Object.values(decl.bindings).reduce((a, b) => a + b, 0);
          const weight = Math.max(1, refSum);
          targets.set(resolved, Math.max(targets.get(resolved) ?? 0, weight));
        } else if (!resolved && !decl.speculative) {
          externalSpecs.add(decl.spec);
        }
      }
      external.set(f.path, [...externalSpecs].sort());
      const adj: string[] = [];
      for (const [target, weight] of targets) {
        edgeWeights.set(`${f.path}\n${target}`, weight);
        adj.push(target);
        outDeg.set(f.path, (outDeg.get(f.path) ?? 0) + 1);
        inDeg.set(target, (inDeg.get(target) ?? 0) + 1);
      }
      adjacency.set(f.path, adj);
    }

    const cycleIds = findCycles(adjacency);

    const testedBy = new Map<string, number>();
    for (const key of edgeWeights.keys()) {
      const e = edgeFromKey(key, 1);
      if (isTestPath(e.source) && !isTestPath(e.target)) {
        testedBy.set(e.target, (testedBy.get(e.target) ?? 0) + 1);
      }
    }

    const clusterOf = this.computeClusterOf();
    const nodes: GraphNode[] = [...this.files.values()].map((f) => {
      const isTest = isTestPath(f.path);
      const inDegree = inDeg.get(f.path) ?? 0;
      return {
        id: f.path,
        lang: f.lang,
        loc: f.loc,
        complexity: f.complexity,
        symbols: f.symbols,
        cluster: clusterOf(f.path),
        inDegree,
        outDegree: outDeg.get(f.path) ?? 0,
        externalModules: external.get(f.path) ?? [],
        testedBy: testedBy.get(f.path) ?? 0,
        isTest,
        orphan: !isTest && inDegree === 0 && topDir(f.path) !== '' && !isEntryLike(f.path),
        cycleId: cycleIds.get(f.path) ?? null,
        todos: f.todos,
      };
    });
    const edges = [...edgeWeights].map(([key, weight]) => edgeFromKey(key, weight));
    return { nodes, edges };
  }
}

/**
 * A set of files plus everything that imports them, at any depth.
 *
 * The same question `impact_of` answers over MCP and the same one the node
 * badge counts: *if I change these, what else is in the way*. Importers only,
 * deliberately — walking downstream as well would, in a repo where anything
 * imports a shared type, return the repo. The direction that bounds itself is
 * the useful one.
 *
 * Seeds come back in the set: every caller here wants "these files, and what
 * they would take with them" rather than the radius on its own, and a copy
 * that omitted the file you selected would be a strange thing to paste.
 */
export function withBlastRadius(seeds: Iterable<string>, edges: Iterable<GraphEdge>): string[] {
  const importers = new Map<string, string[]>();
  for (const e of edges) {
    const list = importers.get(e.target);
    if (list) list.push(e.source);
    else importers.set(e.target, [e.source]);
  }
  const seen = new Set(seeds);
  const queue = [...seen];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const up of importers.get(cur) ?? []) {
      if (!seen.has(up)) {
        seen.add(up);
        queue.push(up);
      }
    }
  }
  return [...seen].sort();
}

/**
 * Iterative Tarjan SCC. Returns node -> component id for components with more
 * than one node (i.e. real import cycles).
 */
export function findCycles(adjacency: Map<string, string[]>): Map<string, number> {
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result = new Map<string, number>();
  let componentId = 0;

  for (const start of adjacency.keys()) {
    if (index.has(start)) continue;
    // frame: [node, next-child pointer]
    const work: [string, number][] = [[start, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const node = frame[0];
      if (frame[1] === 0) {
        index.set(node, counter);
        lowlink.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
      }
      const neighbors = adjacency.get(node) ?? [];
      let recursed = false;
      while (frame[1] < neighbors.length) {
        const next = neighbors[frame[1]];
        frame[1]++;
        if (!index.has(next)) {
          work.push([next, 0]);
          recursed = true;
          break;
        }
        if (onStack.has(next)) {
          lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!));
        }
      }
      if (recursed) continue;
      if (lowlink.get(node) === index.get(node)) {
        const component: string[] = [];
        let popped: string;
        do {
          popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
        } while (popped !== node);
        if (component.length > 1) {
          for (const member of component) result.set(member, componentId);
          componentId++;
        }
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(node)!));
      }
    }
  }
  return result;
}

// '\n' is used as separator because it can never appear in a file path.
function edgeKey(e: GraphEdge): string {
  return `${e.source}\n${e.target}`;
}

function edgeFromKey(key: string, weight: number): GraphEdge {
  const idx = key.indexOf('\n');
  return { source: key.slice(0, idx), target: key.slice(idx + 1), weight };
}

function nodesEqual(a: GraphNode, b: GraphNode): boolean {
  return (
    a.loc === b.loc &&
    a.complexity === b.complexity &&
    a.inDegree === b.inDegree &&
    a.outDegree === b.outDegree &&
    a.externalModules.join() === b.externalModules.join() &&
    a.testedBy === b.testedBy &&
    a.orphan === b.orphan &&
    a.cycleId === b.cycleId &&
    a.todos === b.todos &&
    a.symbols.length === b.symbols.length &&
    a.symbols.every((s, i) => s.name === b.symbols[i].name && s.line === b.symbols[i].line)
  );
}
