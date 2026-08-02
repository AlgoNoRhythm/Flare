import type { GraphEdge, GraphNode, ReviewState, ShadowSnapshot } from './types';
import type { CoverageMap } from './coverage';
import { reuseScore } from './reuse';

/**
 * The unified metrics/issues engine. Pure: give it the graph plus every signal
 * the session has collected and it returns per-file metrics, a repo summary
 * and a severity-ranked issue feed tuned for agentic coding — regression
 * risk, logic concentration, refactor candidates, coverage gaps, agent thrash.
 */

export interface FileMetrics {
  path: string;
  loc: number;
  complexity: number;
  /** complexity per 100 loc */
  density: number;
  churnGit: number;
  churnSession: number;
  fanIn: number;
  fanOut: number;
  instability: number;
  blastRadius: number;
  testedBy: number;
  coveragePct: number | null;
  todos: number;
  symbols: number;
  inCycle: boolean;
  orphan: boolean;
  isTest: boolean;
  lastAgent: string | null;
  unreviewed: boolean;
  /**
   * No human has opened this file in the editor since it last changed.
   * Approving is a claim; opening is evidence — this counts the evidence.
   */
  unread: boolean;
  /** regression-risk composite, 0..100 within this repo */
  risk: number;
  /** churn × complexity, 0..100 within this repo */
  hotspot: number;
  /** refactor priority composite, 0..100 within this repo */
  refactor: number;
  /**
   * How cleanly this file could be lifted out and reused, 0..100 — absolute,
   * not relative to the repo. Null when there is too little in the file to be
   * worth the question. See `shared/reuse.ts`.
   */
  reuse: number | null;
  /** Transitive project files this one pulls in — what comes along with it. */
  drag: number;
  /** The imports that tie it to a host or a framework. */
  reuseBlockers: string[];
  /** Something in here talks to the machine: disk, network, process, database. */
  hostBound: boolean;
  /** strongest co-change partner this session */
  coupling: { partner: string; count: number } | null;
  /**
   * Every raw metric restated on the composites' scale: 0..100, where 100 is
   * the highest value in this repo.
   *
   * A table that mixes 2,055 lines, complexity 293, 16 commits and 1 importer
   * cannot be read across a row — each column needs its own mental yardstick,
   * so "is this file unusual?" takes four separate judgements. On one scale
   * the row answers it directly.
   *
   * Coverage is deliberately absent: it is already 0..100 and its meaning is
   * absolute. 80% coverage is 80% whether or not the rest of the repo is
   * worse, and normalising it against the repo would turn the best of a bad
   * set into a perfect score.
   */
  scores: {
    complexity: number;
    loc: number;
    churn: number;
    fanIn: number;
    blastRadius: number;
    todos: number;
  };
}

export type IssueSeverity = 'critical' | 'warning' | 'info';

export interface Issue {
  id: string;
  rule: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  paths: string[];
  score: number;
}

export interface InsightsSummary {
  files: number;
  loc: number;
  avgCoverage: number | null;
  /** LOC-weighted mean reuse across non-test files, 0..100. */
  reuse: number | null;
  cycles: number;
  orphans: number;
  unreviewed: number;
  /** Files that changed this session and no human has opened since. */
  neverRead: number;
  /** Files that changed this session at all — the denominator for neverRead. */
  changedThisSession: number;
  untestedChanged: number;
  todos: number;
  criticals: number;
  warnings: number;
}

export interface Insights {
  summary: InsightsSummary;
  files: FileMetrics[];
  issues: Issue[];
}

export interface InsightsInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  churn: Record<string, number>;
  coverage: CoverageMap;
  changedAt: Record<string, number>;
  changedBy: Record<string, string>;
  review: ReviewState | null;
  snapshots: ShadowSnapshot[];
}

/**
 * Transitive dependency count per file — what comes along if you lift it out.
 * The mirror of the blast radius: that walks importers, this walks imports.
 */
function allDrag(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const forward = new Map<string, string[]>();
  for (const e of edges) {
    const list = forward.get(e.source);
    if (list) list.push(e.target);
    else forward.set(e.source, [e.target]);
  }
  const out = new Map<string, number>();
  for (const n of nodes) {
    const seen = new Set<string>([n.id]);
    const queue = [n.id];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const dep of forward.get(cur) ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    out.set(n.id, seen.size - 1);
  }
  return out;
}

function allBlastRadii(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const reverse = new Map<string, string[]>();
  for (const e of edges) {
    const list = reverse.get(e.target);
    if (list) list.push(e.source);
    else reverse.set(e.target, [e.source]);
  }
  const out = new Map<string, number>();
  for (const n of nodes) {
    const seen = new Set<string>([n.id]);
    const queue = [n.id];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const dep of reverse.get(cur) ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    out.set(n.id, seen.size - 1);
  }
  return out;
}

const BULK_SNAPSHOT_LIMIT = 12;

function sessionChurnAndCoupling(snapshots: ShadowSnapshot[]): {
  churn: Map<string, number>;
  coupling: Map<string, Map<string, number>>;
} {
  const churn = new Map<string, number>();
  const coupling = new Map<string, Map<string, number>>();
  for (const snap of snapshots) {
    if (snap.message === 'session start') continue;
    for (const f of snap.files) churn.set(f, (churn.get(f) ?? 0) + 1);
    // temporal coupling — skip bulk snapshots (formatters, restores)
    if (snap.files.length >= 2 && snap.files.length <= BULK_SNAPSHOT_LIMIT) {
      for (const a of snap.files) {
        for (const b of snap.files) {
          if (a === b) continue;
          if (!coupling.has(a)) coupling.set(a, new Map());
          const m = coupling.get(a)!;
          m.set(b, (m.get(b) ?? 0) + 1);
        }
      }
    }
  }
  return { churn, coupling };
}

function isUnreviewed(path: string, changedAt: Record<string, number>, review: ReviewState | null): boolean {
  const changed = changedAt[path];
  if (!changed) return false;
  const approvedAt = review?.approvedAt[path] ?? 0;
  const checkpointAt = review?.checkpointAt ?? 0;
  return changed > Math.max(approvedAt, checkpointAt);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export function computeInsights(input: InsightsInput): Insights {
  const { nodes, edges, churn, coverage, changedAt, changedBy, review, snapshots } = input;
  const blast = allBlastRadii(nodes, edges);
  const drag = allDrag(nodes, edges);
  const session = sessionChurnAndCoupling(snapshots);
  // tests are not productization candidates, so they are not the denominator
  // for "what share of the codebase does this drag along" either
  const codebaseSize = nodes.filter((n) => !n.isTest).length;

  // raw composites first, then normalize to 0..100 within the repo
  const raw = nodes.map((n) => {
    const cov = coverage[n.id]?.pct ?? null;
    const b = blast.get(n.id) ?? 0;
    const sessionChurn = session.churn.get(n.id) ?? 0;
    const unreviewed = isUnreviewed(n.id, changedAt, review);
    const uncovFactor =
      cov !== null ? 1 + (1 - Math.min(cov, 100) / 100) : n.isTest || n.testedBy > 0 ? 1 : 1.8;
    const riskRaw =
      (1 + Math.log2(1 + b)) *
      (1 + n.complexity / 30) *
      uncovFactor *
      (unreviewed ? 1.6 : 1) *
      (1 + Math.min(sessionChurn, 5) * 0.12) *
      (n.cycleId !== null ? 1.3 : 1);
    const hotspotRaw = n.complexity * (Math.min(churn[n.id] ?? 0, 50) + sessionChurn * 3 + 1);
    const total = n.inDegree + n.outDegree;
    const refactorRaw =
      n.complexity * 1.5 +
      n.loc / 12 +
      n.inDegree * 6 +
      (n.cycleId !== null ? 25 : 0) +
      (n.symbols.length > 15 ? 15 : 0) +
      n.todos * 4;
    let coupling: FileMetrics['coupling'] = null;
    const partners = session.coupling.get(n.id);
    if (partners) {
      let best: { partner: string; count: number } | null = null;
      for (const [partner, count] of partners) {
        if (count >= 2 && (!best || count > best.count)) best = { partner, count };
      }
      coupling = best;
    }
    const d = drag.get(n.id) ?? 0;
    const reuse = reuseScore({
      path: n.id,
      lang: n.lang,
      loc: n.loc,
      complexity: n.complexity,
      externalModules: n.externalModules,
      drag: d,
      codebaseSize,
      inCycle: n.cycleId !== null,
    });
    return { n, cov, b, d, reuse, sessionChurn, unreviewed, riskRaw, hotspotRaw, refactorRaw, total, coupling };
  });

  /** Share of this repo's largest value, 0..100 — the composites' own rule. */
  const scaleBy = <T,>(rows: T[], pick: (row: T) => number): ((row: T) => number) => {
    const max = Math.max(1, ...rows.map(pick));
    return (row) => Math.round((pick(row) / max) * 100);
  };

  const cxScore = scaleBy(raw, (r) => r.n.complexity);
  const locScore = scaleBy(raw, (r) => r.n.loc);
  const churnScore = scaleBy(raw, (r) => (churn[r.n.id] ?? 0) + r.sessionChurn * 3);
  const fanInScore = scaleBy(raw, (r) => r.n.inDegree);
  const blastScore = scaleBy(raw, (r) => r.b);
  const todoScore = scaleBy(raw, (r) => r.n.todos);

  const maxRisk = Math.max(1, ...raw.map((r) => r.riskRaw));
  const maxHot = Math.max(1, ...raw.map((r) => r.hotspotRaw));
  const maxRef = Math.max(1, ...raw.map((r) => r.refactorRaw));

  const files: FileMetrics[] = raw
    .map((r) => ({
      path: r.n.id,
      loc: r.n.loc,
      complexity: r.n.complexity,
      density: r.n.loc === 0 ? 0 : Math.round((r.n.complexity / r.n.loc) * 1000) / 10,
      churnGit: churn[r.n.id] ?? 0,
      churnSession: r.sessionChurn,
      fanIn: r.n.inDegree,
      fanOut: r.n.outDegree,
      instability: r.total === 0 ? 0 : Math.round((r.n.outDegree / r.total) * 100) / 100,
      blastRadius: r.b,
      testedBy: r.n.testedBy,
      coveragePct: r.cov,
      todos: r.n.todos,
      symbols: r.n.symbols.length,
      inCycle: r.n.cycleId !== null,
      orphan: r.n.orphan,
      isTest: r.n.isTest,
      lastAgent: changedBy[r.n.id] ?? null,
      unreviewed: r.unreviewed,
      // only code that changed this session can be "unread": on a repo you
      // just opened, "100% unread" would be true and useless
      unread: (changedAt[r.n.id] ?? 0) > 0 && (review?.readAt?.[r.n.id] ?? 0) < (changedAt[r.n.id] ?? 0),
      risk: Math.round((r.riskRaw / maxRisk) * 100),
      hotspot: Math.round((r.hotspotRaw / maxHot) * 100),
      refactor: Math.round((r.refactorRaw / maxRef) * 100),
      reuse: r.reuse.score,
      drag: r.d,
      reuseBlockers: r.reuse.blockers,
      hostBound: r.reuse.hostBound,
      coupling: r.coupling,
      scores: {
        complexity: cxScore(r),
        loc: locScore(r),
        churn: churnScore(r),
        fanIn: fanInScore(r),
        blastRadius: blastScore(r),
        todos: todoScore(r),
      },
    }))
    .sort((a, b) => b.risk - a.risk);

  // ---------------- issues ----------------
  const issues: Issue[] = [];
  const cxSorted = files.map((f) => f.complexity).sort((a, b) => a - b);
  const cx75 = percentile(cxSorted, 0.75);
  const fanSorted = files.map((f) => f.fanIn).sort((a, b) => a - b);
  const fan90 = Math.max(4, percentile(fanSorted, 0.9));

  for (const f of files) {
    const uncovered =
      f.coveragePct !== null ? f.coveragePct < 50 : !f.isTest && f.testedBy === 0;
    if (f.unreviewed && f.blastRadius >= 3 && uncovered) {
      issues.push({
        id: `regression:${f.path}`,
        rule: 'regression-risk',
        severity: 'critical',
        title: `Regression risk: ${f.path}`,
        detail: `Changed${f.lastAgent && f.lastAgent !== 'you' ? ` by ${f.lastAgent}` : ''}, ${f.blastRadius} files depend on it transitively, and it is ${
          f.coveragePct !== null ? `only ${f.coveragePct}% covered` : 'not exercised by any test'
        }.`,
        paths: [f.path],
        score: 1000 + f.risk,
      });
    } else if (f.unreviewed && f.risk >= 70) {
      issues.push({
        id: `risky-change:${f.path}`,
        rule: 'risky-change',
        severity: 'warning',
        title: `High-risk change awaiting review: ${f.path}`,
        detail: `Risk ${f.risk}/100 (complexity ${f.complexity}, ${f.blastRadius} downstream).`,
        paths: [f.path],
        score: 500 + f.risk,
      });
    }
    if (f.churnSession >= 4) {
      issues.push({
        id: `thrash:${f.path}`,
        rule: 'agent-thrash',
        severity: 'warning',
        title: `Rewritten ${f.churnSession}× this session: ${f.path}`,
        detail: `${f.lastAgent && f.lastAgent !== 'you' ? `${f.lastAgent} keeps` : 'This file keeps'} being rewritten — unclear spec or a stuck loop?`,
        paths: [f.path],
        score: 400 + f.churnSession * 10,
      });
    }
    if (f.coveragePct !== null && f.coveragePct < 40 && f.fanIn >= 2 && !f.isTest) {
      issues.push({
        id: `covgap:${f.path}`,
        rule: 'coverage-gap',
        severity: f.unreviewed ? 'critical' : 'warning',
        title: `Coverage gap: ${f.path} at ${f.coveragePct}%`,
        detail: `${f.fanIn} files import it; ${f.blastRadius} sit downstream.`,
        paths: [f.path],
        score: 300 + f.fanIn * 10 + (f.unreviewed ? 500 : 0),
      });
    }
    if (f.fanIn >= fan90 && f.complexity >= cx75 && f.complexity > 5) {
      issues.push({
        id: `god:${f.path}`,
        rule: 'god-file',
        severity: 'warning',
        title: `Logic concentration: ${f.path}`,
        detail: `Complexity ${f.complexity} with ${f.fanIn} importers — load-bearing and complicated. Split before it calcifies.`,
        paths: [f.path],
        score: 350 + f.refactor,
      });
    } else if (f.refactor >= 75 && f.complexity > 5) {
      issues.push({
        id: `refactor:${f.path}`,
        rule: 'refactor-candidate',
        severity: 'info',
        title: `Refactor candidate: ${f.path}`,
        detail: `Refactor score ${f.refactor}/100 — complexity ${f.complexity}, ${f.loc} loc, ${f.symbols} symbols${f.inCycle ? ', in a cycle' : ''}${f.todos > 0 ? `, ${f.todos} TODOs` : ''}.`,
        paths: [f.path],
        score: 200 + f.refactor,
      });
    }
    if (f.hotspot >= 70 && f.churnGit + f.churnSession >= 3) {
      issues.push({
        id: `hotspot:${f.path}`,
        rule: 'hotspot',
        severity: 'info',
        title: `Hotspot: ${f.path}`,
        detail: `Changes often (${f.churnGit} commits, ${f.churnSession} this session) and is complex (${f.complexity}) — where bugs breed.`,
        paths: [f.path],
        score: 250 + f.hotspot,
      });
    }
    /*
     * Logic and plumbing in one file.
     *
     * The score already says this file is hard to lift; this says why it is
     * worth doing something about. Something host-bound with little in it is
     * an adapter doing its job — that is where IO belongs. Something host-bound
     * and *complex* has business logic trapped inside the plumbing, and freeing
     * it means splitting the file first.
     *
     * Host-bound specifically, not framework-bound: "this React component
     * depends on React" is a tautology, and firing on it buried the real
     * findings under every component in the app.
     */
    if (!f.isTest && f.reuse !== null && f.hostBound && f.complexity >= cx75 && f.complexity > 20) {
      issues.push({
        id: `mixed:${f.path}`,
        rule: 'mixed-concerns',
        severity: 'info',
        title: `Logic tangled with plumbing: ${f.path}`,
        detail: `Complexity ${f.complexity} in a file bound to ${f.reuseBlockers.slice(0, 3).join(', ')} — reuse ${f.reuse}/100. Separating the logic from the ${f.reuseBlockers.length === 1 ? 'dependency' : 'dependencies'} would make it liftable.`,
        paths: [f.path],
        score: 180 + (100 - f.reuse),
      });
    }
    if (f.orphan && !f.isTest) {
      issues.push({
        id: `orphan:${f.path}`,
        rule: 'orphan',
        severity: 'info',
        title: `Possibly dead: ${f.path}`,
        detail: 'Nothing imports it and it does not look like an entry point.',
        paths: [f.path],
        score: 50,
      });
    }
    if (f.todos >= 3) {
      issues.push({
        id: `todos:${f.path}`,
        rule: 'todo-debt',
        severity: 'info',
        title: `${f.todos} TODO/FIXME markers: ${f.path}`,
        detail: 'Accumulated deferred work in one file.',
        paths: [f.path],
        score: 60 + f.todos,
      });
    }
    if (f.coupling && f.coupling.count >= 3) {
      issues.push({
        id: `coupling:${f.path}`,
        rule: 'change-coupling',
        severity: 'info',
        title: `Changes travel in pairs: ${f.path} ↔ ${f.coupling.partner}`,
        detail: `Modified together ${f.coupling.count}× this session — hidden coupling or a missing abstraction.`,
        paths: [f.path, f.coupling.partner],
        score: 150 + f.coupling.count * 10,
      });
    }
  }

  // cycles as grouped issues
  const cycles = new Map<number, string[]>();
  for (const n of nodes) {
    if (n.cycleId !== null) {
      if (!cycles.has(n.cycleId)) cycles.set(n.cycleId, []);
      cycles.get(n.cycleId)!.push(n.id);
    }
  }
  for (const [id, members] of cycles) {
    issues.push({
      id: `cycle:${id}`,
      rule: 'import-cycle',
      severity: members.length >= 4 ? 'critical' : 'warning',
      title: `Import cycle (${members.length} files)`,
      detail: members.slice(0, 6).join(' → ') + (members.length > 6 ? ' → …' : ''),
      paths: members,
      score: 600 + members.length * 20,
    });
  }

  // aggregated review backlog
  const unreviewedFiles = files.filter((f) => f.unreviewed);
  if (unreviewedFiles.length >= 10) {
    issues.push({
      id: 'backlog',
      rule: 'review-backlog',
      severity: 'warning',
      title: `${unreviewedFiles.length} unreviewed changes piling up`,
      detail: 'The agent is outrunning your review. Triage by risk before it compounds.',
      paths: unreviewedFiles.slice(0, 8).map((f) => f.path),
      score: 450 + unreviewedFiles.length,
    });
  }
  const mixed = unreviewedFiles.filter((f) => f.lastAgent === 'mixed');
  if (mixed.length > 0) {
    issues.push({
      id: 'mixed-agents',
      rule: 'mixed-agents',
      severity: 'info',
      title: `${mixed.length} file${mixed.length === 1 ? '' : 's'} touched by multiple agents`,
      detail: 'Concurrent agents edited the same files — check for conflicting intents.',
      paths: mixed.map((f) => f.path).slice(0, 8),
      score: 220,
    });
  }

  const severityRank: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.score - a.score);

  const covered = files.filter((f) => f.coveragePct !== null);
  const covLoc = covered.reduce((a, f) => a + f.loc, 0);
  // weighted by size, like coverage: what share of the code you have written
  // could be lifted out, not what share of the files
  const scored = files.filter((f) => !f.isTest && f.reuse !== null);
  const scoredLoc = scored.reduce((a, f) => a + f.loc, 0);
  const summary: InsightsSummary = {
    files: files.length,
    loc: files.reduce((a, f) => a + f.loc, 0),
    avgCoverage:
      covLoc > 0
        ? Math.round((covered.reduce((a, f) => a + (f.coveragePct ?? 0) * f.loc, 0) / covLoc) * 10) / 10
        : null,
    reuse:
      scoredLoc > 0
        ? Math.round(scored.reduce((a, f) => a + (f.reuse ?? 0) * f.loc, 0) / scoredLoc)
        : null,
    cycles: cycles.size,
    orphans: files.filter((f) => f.orphan).length,
    unreviewed: unreviewedFiles.length,
    neverRead: files.filter((f) => f.unread).length,
    changedThisSession: files.filter((f) => (changedAt[f.path] ?? 0) > 0).length,
    untestedChanged: unreviewedFiles.filter((f) =>
      f.coveragePct !== null ? f.coveragePct < 50 : !f.isTest && f.testedBy === 0,
    ).length,
    todos: files.reduce((a, f) => a + f.todos, 0),
    criticals: issues.filter((i) => i.severity === 'critical').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
  };

  return { summary, files, issues };
}
